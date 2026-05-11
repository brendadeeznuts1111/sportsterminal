import type { Database } from '../database';
import type { BuckeyeWebLogRow, BuckeyeWebLogType } from '../scrapers/BuckeyeAPI';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import { enrichIpGeo, formatGeoLabel } from './GeoIpService';

type AccessLogRecord = Record<string, unknown> & {
  login_id?: string;
  ip_address?: string;
  access_datetime?: string;
  agent_id?: string;
  operation?: string;
  data?: string;
};

interface IpTrackerOptions {
  agentId?: string;
  start?: string;
  end?: string;
  live?: boolean;
  limit?: number;
}

interface IpAlertEvent {
  type: 'ip_alert' | 'risk_alert';
  severity: 'info' | 'warning' | 'high' | 'critical';
  ip: string;
  accounts?: number;
  player?: string;
  message: string;
  timestamp: number;
}

interface IpReputation {
  score: number;
  category: 'good' | 'suspicious' | 'malicious';
  factors: {
    accountCount: number;
    totalWager: number;
    riskFlags: number;
    lastSeen: string | null;
  };
}

export class IPTracker {
  constructor(
    private readonly db: Database,
    private readonly scraperManager: BuckeyeScraperManager
  ) {}

  async fetchLatestLogs(agentId: string): Promise<{ fetched: number; inserted: number; patterns: number }> {
    return this.scraperManager.forceAccessLogRefresh(agentId);
  }

  async processWebLogRows(agentId: string, rows: BuckeyeWebLogRow[], logType: BuckeyeWebLogType): Promise<{
    accountChanges: number;
    failedLogins: number;
    alerts: number;
  }> {
    let accountChanges = 0;
    let failedLogins = 0;
    let alerts = 0;

    for (const row of rows) {
      const type = webLogRowType(row, logType);
      switch (type) {
        case 'C':
          accountChanges += await this.handleAccountChange(agentId, row);
          break;
        case 'I':
          alerts += await this.handleIPChange(agentId, row);
          break;
        case 'F':
          failedLogins += await this.handleFailedLogin(agentId, row);
          alerts += failedLogins > 0 ? 1 : 0;
          break;
        case 'A':
        case 'B':
        default:
          break;
      }
    }

    return { accountChanges, failedLogins, alerts };
  }

  async getSuspiciousIPs(limit = 20): Promise<{
    shared: AccessLogRecord[];
    newIPs: AccessLogRecord[];
    summary: {
      sharedClusters: number;
      newIpLogins: number;
      generatedAt: string;
    };
  }> {
    const safeLimit = clampLimit(limit);
    const shared = await this.db.all<AccessLogRecord>(
      `SELECT
         ip_address,
         GROUP_CONCAT(DISTINCT login_id) AS accounts,
         COUNT(DISTINCT login_id) AS acct_count,
         COUNT(*) AS access_count,
         MIN(access_datetime) AS first_seen,
         MAX(access_datetime) AS last_seen
       FROM access_logs
       WHERE access_datetime >= datetime('now', '-1 day')
         AND ip_address IS NOT NULL
         AND ip_address <> ''
       GROUP BY ip_address
       HAVING acct_count > 1
       ORDER BY acct_count DESC, last_seen DESC
       LIMIT ?`,
      [safeLimit]
    );

    const newIPs = await this.db.all<AccessLogRecord>(
      `WITH first_pair AS (
         SELECT login_id, ip_address, MIN(access_datetime) AS first_seen
         FROM access_logs
         WHERE login_id IS NOT NULL
           AND login_id <> ''
           AND ip_address IS NOT NULL
           AND ip_address <> ''
         GROUP BY login_id, ip_address
       )
       SELECT l.*, fp.first_seen
       FROM access_logs l
       JOIN first_pair fp
         ON fp.login_id = l.login_id
        AND fp.ip_address = l.ip_address
        AND fp.first_seen = l.access_datetime
       WHERE l.access_datetime >= datetime('now', '-1 day')
         AND EXISTS (
           SELECT 1
           FROM access_logs prior
           WHERE prior.login_id = l.login_id
             AND prior.ip_address <> l.ip_address
             AND prior.access_datetime < l.access_datetime
         )
       ORDER BY l.access_datetime DESC
       LIMIT ?`,
      [safeLimit]
    );

    const enrichedShared = await this.enrichRows(shared);
    const enrichedNewIPs = await this.enrichRows(newIPs);

    return {
      shared: enrichedShared,
      newIPs: enrichedNewIPs,
      summary: {
        sharedClusters: enrichedShared.length,
        newIpLogins: enrichedNewIPs.length,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  async getAccountsByIP(ip: string, options: IpTrackerOptions = {}): Promise<{
    mode: 'ip';
    ip: string;
    accounts: AccessLogRecord[];
    local: AccessLogRecord[];
    live: BuckeyeWebLogRow[];
    liveError?: string;
    country?: string;
    geoLabel?: string;
    reputation: IpReputation;
    blocked: boolean;
  }> {
    const normalizedIp = ip.trim();
    const safeLimit = clampLimit(options.limit || 100, 500);
    const local = await this.db.all<AccessLogRecord>(
      `SELECT login_id, agent_id, ip_address, operation, data,
              MIN(access_datetime) AS first_seen,
              MAX(access_datetime) AS last_seen,
              COUNT(*) AS access_count
       FROM access_logs
       WHERE ip_address = ?
       GROUP BY login_id, agent_id, ip_address, operation, data
       ORDER BY last_seen DESC
       LIMIT ?`,
      [normalizedIp, safeLimit]
    );

    const liveResult = await this.fetchLiveWebLog({
      ...options,
      type: 'I',
      ip: normalizedIp,
      customerID: '0',
    });
    const accounts = await this.enrichRows(mergeLocalAndLive(local, liveResult.rows, 'ip'));
    const geo = await this.lookupGeo(normalizedIp);
    const reputation = await this.computeIPReputation(normalizedIp);
    const blocked = await this.isBlocked(normalizedIp);
    return {
      mode: 'ip',
      ip: normalizedIp,
      accounts,
      local,
      live: liveResult.rows,
      country: geo?.country || undefined,
      geoLabel: geo?.label || undefined,
      reputation,
      blocked,
      ...(liveResult.error ? { liveError: liveResult.error } : {}),
    };
  }

  async getIPsForPlayer(playerLogin: string, options: IpTrackerOptions = {}): Promise<{
    mode: 'player';
    player: string;
    ips: AccessLogRecord[];
    local: AccessLogRecord[];
    live: BuckeyeWebLogRow[];
    ipHistory: AccessLogRecord[];
    liveError?: string;
  }> {
    const player = playerLogin.trim();
    const safeLimit = clampLimit(options.limit || 100, 500);
    const local = await this.db.all<AccessLogRecord>(
      `SELECT login_id, agent_id, ip_address, operation, data,
              MIN(access_datetime) AS first_seen,
              MAX(access_datetime) AS last_seen,
              COUNT(*) AS access_count
       FROM access_logs
       WHERE login_id = ?
       GROUP BY login_id, agent_id, ip_address, operation, data
       ORDER BY last_seen DESC
       LIMIT ?`,
      [player, safeLimit]
    );

    const liveResult = await this.fetchLiveWebLog({
      ...options,
      type: 'C',
      customerID: player,
    });
    const ips = await this.enrichRows(mergeLocalAndLive(local, liveResult.rows, 'player'));
    const ipHistory = await this.getIPHistoryForPlayer(player);
    return {
      mode: 'player',
      player,
      ips,
      local,
      live: liveResult.rows,
      ipHistory,
      ...(liveResult.error ? { liveError: liveResult.error } : {}),
    };
  }

  async getIPHistoryForPlayer(playerLogin: string): Promise<AccessLogRecord[]> {
    const player = playerLogin.trim();
    const rows = await this.db.all<AccessLogRecord>(
      `SELECT
         date(access_datetime) AS day,
         MIN(access_datetime) AS first_seen,
         MAX(access_datetime) AS last_seen,
         COUNT(*) AS loginCount,
         COUNT(DISTINCT ip_address) AS ipCount,
         GROUP_CONCAT(DISTINCT ip_address) AS ips,
         (
           SELECT COALESCE(SUM(wa.amount_wagered), 0)
           FROM wager_archive wa
           WHERE (wa.login = ? OR wa.customer_id = ?)
             AND substr(wa.insert_date_time, 1, 10) = date(access_logs.access_datetime)
         ) AS wagerVolume
       FROM access_logs
       WHERE login_id = ?
       GROUP BY day
       ORDER BY day ASC
       LIMIT 120`,
      [player, player, player]
    );
    return rows;
  }

  async computeIPReputation(ip: string): Promise<IpReputation> {
    const row = await this.db.get<{
      acctCount: number | string | null;
      totalWager: number | string | null;
      riskFlags: number | string | null;
      lastSeen: string | null;
    }>(
      `WITH ip_players AS (
         SELECT DISTINCT login_id AS player
         FROM access_logs
         WHERE ip_address = ?
           AND login_id IS NOT NULL
           AND login_id <> ''
       )
       SELECT
         COUNT(DISTINCT ip_players.player) AS acctCount,
         COALESCE(SUM(wa.amount_wagered), 0) AS totalWager,
         COUNT(DISTINCT pf.id) AS riskFlags,
         (SELECT MAX(access_datetime) FROM access_logs WHERE ip_address = ?) AS lastSeen
       FROM ip_players
       LEFT JOIN wager_archive wa
         ON wa.login = ip_players.player OR wa.customer_id = ip_players.player
       LEFT JOIN player_flags pf
         ON pf.customer_id = ip_players.player AND pf.status = 'active'`,
      [ip, ip]
    );

    const accountCount = Number(row?.acctCount || 0);
    const totalWager = Number(row?.totalWager || 0);
    const riskFlags = Number(row?.riskFlags || 0);
    const lastSeen = row?.lastSeen || null;

    let score = 0;
    if (accountCount > 2) score += 40;
    if (totalWager > 10000) score += 20;
    if (riskFlags > 0) score += 30;

    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : NaN;
    if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < 24 * 60 * 60 * 1000) {
      score -= 10;
    }

    const boundedScore = Math.max(0, Math.min(score, 100));
    return {
      score: boundedScore,
      category: boundedScore > 60 ? 'malicious' : boundedScore > 30 ? 'suspicious' : 'good',
      factors: { accountCount, totalWager, riskFlags, lastSeen },
    };
  }

  async getExportData(): Promise<AccessLogRecord[]> {
    const rows = await this.db.all<AccessLogRecord>(
      `WITH ip_rollup AS (
         SELECT
           l.ip_address,
           GROUP_CONCAT(DISTINCT l.login_id) AS players,
           MIN(l.access_datetime) AS first_seen,
           MAX(l.access_datetime) AS last_seen,
           COUNT(DISTINCT l.login_id) AS acct_count,
           COUNT(*) AS access_count
         FROM access_logs l
         WHERE l.ip_address IS NOT NULL
           AND l.ip_address <> ''
         GROUP BY l.ip_address
       )
       SELECT
         ip_rollup.ip_address AS ip,
         ip_rollup.ip_address,
         ip_rollup.players,
         ip_rollup.first_seen,
         ip_rollup.last_seen,
         ip_rollup.acct_count,
         ip_rollup.access_count,
         COALESCE((
           SELECT SUM(wa.amount_wagered)
           FROM wager_archive wa
           WHERE instr(',' || ip_rollup.players || ',', ',' || wa.login || ',') > 0
              OR instr(',' || ip_rollup.players || ',', ',' || wa.customer_id || ',') > 0
         ), 0) AS total_wager,
         COALESCE((
           SELECT COUNT(DISTINCT pf.id)
           FROM player_flags pf
           WHERE instr(',' || ip_rollup.players || ',', ',' || pf.customer_id || ',') > 0
             AND pf.status = 'active'
         ), 0) AS risk_flags
       FROM ip_rollup
       ORDER BY ip_rollup.acct_count DESC, ip_rollup.last_seen DESC`
    );

    const enriched = await this.enrichRows(rows);
    return Promise.all(enriched.map(async (row) => {
      const reputation = await this.computeIPReputation(String(row.ip_address || row.ip || ''));
      return {
        ...row,
        reputation_score: reputation.score,
        reputation_category: reputation.category,
        reputation,
      };
    }));
  }

  async blockIP(ip: string, reason = 'Operator block'): Promise<void> {
    const normalizedIp = ip.trim();
    if (!normalizedIp) throw new Error('ip is required');
    await this.db.run(
      `INSERT INTO ip_denylist (ip, blocked_at, reason)
       VALUES (?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(ip) DO UPDATE SET blocked_at = excluded.blocked_at, reason = excluded.reason`,
      [normalizedIp, reason]
    );
  }

  async isBlocked(ip: string): Promise<boolean> {
    if (!ip) return false;
    const row = await this.db.get<{ ip: string }>(
      `SELECT ip FROM ip_denylist WHERE ip = ? LIMIT 1`,
      [ip.trim()]
    );
    return Boolean(row);
  }

  async collectAlertEvents(agentId?: string, minutes = 10): Promise<IpAlertEvent[]> {
    const safeMinutes = clampLimit(minutes, 240);
    const events: IpAlertEvent[] = [];
    const agentClause = agentId ? 'AND agent_id = ?' : '';
    const params: unknown[] = [`-${safeMinutes} minutes`];
    if (agentId) params.push(agentId);

    const shared = await this.db.all<AccessLogRecord>(
      `SELECT
         ip_address,
         GROUP_CONCAT(DISTINCT login_id) AS accounts,
         COUNT(DISTINCT login_id) AS acct_count,
         MAX(access_datetime) AS last_seen
       FROM access_logs
       WHERE access_datetime >= datetime('now', ?)
         AND ip_address IS NOT NULL
         AND ip_address <> ''
         ${agentClause}
       GROUP BY ip_address
       HAVING acct_count >= 2`,
      params
    );

    for (const row of shared) {
      const ip = String(row.ip_address || '');
      const accounts = Number(row.acct_count || 0);
      if (!ip || accounts < 2) continue;
      events.push({
        type: 'ip_alert',
        severity: accounts >= 3 ? 'high' : 'warning',
        ip,
        accounts,
        message: `IP ${ip} now used by ${accounts} accounts`,
        timestamp: Date.now(),
      });

      if (accounts >= 3 && await this.insertSharedIpAlert(ip, accounts, String(row.accounts || ''), agentId)) {
        events.push({
          type: 'risk_alert',
          severity: 'high',
          ip,
          accounts,
          message: `Shared IP detected: ${ip} used by ${accounts} accounts`,
          timestamp: Date.now(),
        });
      }
    }

    const newIps = await this.db.all<AccessLogRecord>(
      `WITH first_pair AS (
         SELECT login_id, ip_address, MIN(access_datetime) AS first_seen
         FROM access_logs
         WHERE login_id IS NOT NULL AND login_id <> ''
           AND ip_address IS NOT NULL AND ip_address <> ''
         GROUP BY login_id, ip_address
       )
       SELECT l.login_id, l.ip_address, l.access_datetime
       FROM access_logs l
       JOIN first_pair fp
         ON fp.login_id = l.login_id
        AND fp.ip_address = l.ip_address
        AND fp.first_seen = l.access_datetime
       WHERE l.access_datetime >= datetime('now', ?)
         ${agentClause}
         AND EXISTS (
           SELECT 1
           FROM access_logs prior
           WHERE prior.login_id = l.login_id
             AND prior.ip_address <> l.ip_address
             AND prior.access_datetime < l.access_datetime
         )
       ORDER BY l.access_datetime DESC
       LIMIT 50`,
      params
    );

    for (const row of newIps) {
      const ip = String(row.ip_address || '');
      const player = String(row.login_id || '');
      if (!ip || !player) continue;
      events.push({
        type: 'ip_alert',
        severity: 'warning',
        ip,
        player,
        message: `New IP ${ip} for player ${player}`,
        timestamp: Date.now(),
      });
    }

    return events;
  }

  private async fetchLiveWebLog(options: IpTrackerOptions & {
    type: 'C' | 'I';
    ip?: string;
    customerID?: string;
  }): Promise<{ rows: BuckeyeWebLogRow[]; error?: string }> {
    if (options.live === false) return { rows: [] };

    const agentId = options.agentId || this.scraperManager.getAgentIds()[0];
    if (!agentId) return { rows: [] };

    try {
      const range = defaultWebLogRange(options.type);
      const result = await this.scraperManager.getWebLogLive({
        customerID: options.customerID || '0',
        start: options.start || range.start,
        end: options.end || range.end,
        type: options.type,
        actions: 'ALL',
        ip: options.ip || '',
      }, agentId);
      return { rows: result.data };
    } catch (error) {
      return { rows: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async insertSharedIpAlert(ip: string, accounts: number, players: string, agentId?: string): Promise<boolean> {
    const message = `IP ${ip} detected on ${accounts} accounts - possible syndicate.`;
    const existing = await this.db.get<{ alert_id: number }>(
      `SELECT alert_id
       FROM alerts
       WHERE rule_name = 'Shared IP Cluster'
         AND message LIKE ?
         AND created_at >= datetime('now', '-1 hour')
       LIMIT 1`,
      [`%${ip}%`]
    );
    if (existing) return false;

    await this.db.run(
      `INSERT INTO alerts (wager_number, rule_name, severity, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        null,
        'Shared IP Cluster',
        'critical',
        `${message} Accounts: ${players || 'unknown'}${agentId ? ` Agent: ${agentId}` : ''}`,
        new Date().toISOString(),
      ]
    );
    return true;
  }

  private async handleAccountChange(agentId: string, row: BuckeyeWebLogRow): Promise<number> {
    const player = row.LoginID?.trim();
    if (!player) return 0;
    const parsed = parseChangeData(row);
    await this.db.run(
      `INSERT INTO account_change_logs
        (agent_id, player, ip_address, change_type, old_value, new_value, timestamp, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        player,
        row.IPAddress || '',
        parsed.changeType,
        parsed.oldValue,
        parsed.newValue,
        normalizeTimestamp(row.AccessDateTime),
        JSON.stringify(row.raw || row),
      ]
    );

    if (parsed.isLargeLimitIncrease) {
      await this.insertPlayerFlag(
        player,
        'account_change',
        'critical',
        'Large Limit Increase',
        `${parsed.changeType} changed from ${parsed.oldValue || 'unknown'} to ${parsed.newValue || 'unknown'}`
      );
      await this.insertOperationalAlert(
        null,
        'Large Account Limit Change',
        'critical',
        `${player} had a large account-limit increase${row.IPAddress ? ` from ${row.IPAddress}` : ''}.`
      );
      return 1;
    }

    return 1;
  }

  private async handleIPChange(agentId: string, row: BuckeyeWebLogRow): Promise<number> {
    const player = row.LoginID?.trim();
    const ip = row.IPAddress?.trim();
    if (!player || !ip) return 0;
    const recent = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(DISTINCT ip_address) AS cnt
       FROM access_logs
       WHERE login_id = ?
         AND ip_address <> ?
         AND access_datetime >= datetime(?, '-60 minutes')`,
      [player, ip, normalizeTimestamp(row.AccessDateTime)]
    );
    if (Number(recent?.cnt || 0) <= 3) return 0;

    await this.insertPlayerFlag(
      player,
      'ip_churn',
      'critical',
      'Rapid IP Changes',
      `${player} used ${Number(recent?.cnt || 0) + 1} IPs within about one hour.`
    );
    await this.insertOperationalAlert(
      null,
      'Rapid IP Change',
      'critical',
      `${player} changed IPs repeatedly in a short window. Current IP: ${ip}. Agent: ${agentId}.`
    );
    return 1;
  }

  private async handleFailedLogin(agentId: string, row: BuckeyeWebLogRow): Promise<number> {
    const player = row.LoginID?.trim();
    if (!player) return 0;
    const timestamp = normalizeTimestamp(row.AccessDateTime);
    await this.db.run(
      `INSERT INTO failed_logins (agent_id, player, ip, timestamp, raw_json)
       VALUES (?, ?, ?, ?, ?)`,
      [agentId, player, row.IPAddress || '', timestamp, JSON.stringify(row.raw || row)]
    );

    const failures = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM failed_logins
       WHERE player = ?
         AND timestamp >= datetime(?, '-15 minutes')`,
      [player, timestamp]
    );
    if (Number(failures?.cnt || 0) < 5) return 1;

    await this.insertPlayerFlag(
      player,
      'failed_login',
      'critical',
      'Failed Login Burst',
      `${Number(failures?.cnt || 0)} failed logins in 15 minutes${row.IPAddress ? ` from ${row.IPAddress}` : ''}.`
    );
    await this.insertOperationalAlert(
      null,
      'Failed Login Burst',
      'critical',
      `${player} hit ${Number(failures?.cnt || 0)} failed logins in 15 minutes${row.IPAddress ? ` from ${row.IPAddress}` : ''}.`
    );
    return 1;
  }

  private async insertPlayerFlag(
    player: string,
    flagType: string,
    severity: 'info' | 'warning' | 'critical',
    label: string,
    details: string
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO player_flags
        (provider, customer_id, flag_type, severity, label, details, created_by, created_at, status)
       VALUES ('buckeye', ?, ?, ?, ?, ?, 'ip_tracker', CURRENT_TIMESTAMP, 'active')`,
      [player, flagType, severity, label, details]
    );
  }

  private async insertOperationalAlert(
    wagerNumber: number | null,
    ruleName: string,
    severity: 'info' | 'warning' | 'critical',
    message: string
  ): Promise<void> {
    const existing = await this.db.get<{ alert_id: number }>(
      `SELECT alert_id
       FROM alerts
       WHERE rule_name = ?
         AND message = ?
         AND created_at >= datetime('now', '-1 hour')
       LIMIT 1`,
      [ruleName, message]
    );
    if (existing) return;
    await this.db.run(
      `INSERT INTO alerts (wager_number, rule_name, severity, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [wagerNumber, ruleName, severity, message, new Date().toISOString()]
    );
  }

  private async enrichRows(rows: AccessLogRecord[]): Promise<AccessLogRecord[]> {
    return Promise.all(rows.map(async (row) => {
      const ip = String(row.ip_address || row.ip || '');
      if (!ip) return row;
      const geo = await this.lookupGeo(ip);
      const country = geo?.country || (row.geo && typeof row.geo === 'object' ? String((row.geo as { country?: unknown }).country || '') : '');
      return {
        ...row,
        country: country || undefined,
        geoLabel: geo?.label || undefined,
        geo: row.geo || geo?.geo || null,
      };
    }));
  }

  private async lookupGeo(ip: string): Promise<{ country: string; label: string; geo: unknown } | null> {
    const geo = await enrichIpGeo(ip);
    if (!geo) return null;
    return {
      country: geo.country,
      label: formatGeoLabel(geo),
      geo,
    };
  }
}

function mergeLocalAndLive(local: AccessLogRecord[], live: BuckeyeWebLogRow[], mode: 'ip' | 'player'): AccessLogRecord[] {
  const seen = new Set<string>();
  const merged: AccessLogRecord[] = [];

  for (const row of local) {
    const key = `${row.login_id || ''}|${row.ip_address || ''}|${row.last_seen || row.access_datetime || ''}`;
    seen.add(key);
    merged.push({ ...row, source: 'local' });
  }

  for (const row of live) {
    const normalized = normalizeLiveRow(row);
    const key = `${normalized.login_id || ''}|${normalized.ip_address || ''}|${normalized.access_datetime || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...normalized, source: 'live', match_mode: mode });
  }

  return merged;
}

function normalizeLiveRow(row: BuckeyeWebLogRow): AccessLogRecord {
  return {
    login_id: row.LoginID,
    ip_address: row.IPAddress,
    access_datetime: row.AccessDateTime,
    last_seen: row.AccessDateTime,
    operation: row.Operation,
    data: row.Data,
    geo: row.geo || null,
  };
}

function webLogRowType(row: BuckeyeWebLogRow, fallback: BuckeyeWebLogType): BuckeyeWebLogType {
  const raw = row.raw || {};
  const rawType = raw.Type || raw.type || raw.LogType || raw.logType;
  return rawType === 'A' || rawType === 'B' || rawType === 'C' || rawType === 'I' || rawType === 'F'
    ? rawType
    : fallback;
}

function parseChangeData(row: BuckeyeWebLogRow): {
  changeType: string;
  oldValue: string;
  newValue: string;
  isLargeLimitIncrease: boolean;
} {
  const operation = row.Operation || 'ACCOUNT_CHANGE';
  const data = row.Data || '';
  const numbers = data.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const oldValue = numbers.length >= 2 ? String(numbers[0]) : '';
  const newValue = numbers.length >= 2 ? String(numbers[numbers.length - 1]) : '';
  const oldNum = Number(oldValue);
  const newNum = Number(newValue);
  const mentionsLimit = /limit|credit|max|wager|bet/i.test(`${operation} ${data}`);
  const isLargeLimitIncrease = mentionsLimit
    && Number.isFinite(oldNum)
    && oldNum > 0
    && Number.isFinite(newNum)
    && newNum > oldNum * 1.2;
  return {
    changeType: operation,
    oldValue,
    newValue,
    isLargeLimitIncrease,
  };
}

function normalizeTimestamp(value: string | undefined): string {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function defaultWebLogRange(type: 'C' | 'I'): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - (type === 'I' ? 6 : 29) * 24 * 60 * 60 * 1000);
  return {
    start: formatWebLogDate(start, type),
    end: formatWebLogDate(end, type),
  };
}

function formatWebLogDate(date: Date, type: 'C' | 'I'): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return type === 'C' ? `${yyyy}-${mm}-${dd}` : `${mm}/${dd}/${yyyy}`;
}

function clampLimit(value: number, max = 100): number {
  return Math.min(Math.max(Math.floor(Number(value) || 20), 1), max);
}
