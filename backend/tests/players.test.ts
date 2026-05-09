import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AppDatabase, type Database } from '../src/database';
import {
  registerPlayerAccountSnapshotsRoutes,
  registerPlayerDepositsRoutes,
  registerPlayerExportRoutes,
  registerPlayerFlagCreateRoutes,
  registerPlayerFlagsRoutes,
  registerPlayerIntelligenceMapRoutes,
  registerPlayerLinkCheckRoutes,
  registerPlayerLinksRoutes,
  registerPlayerNoteCreateRoutes,
  registerPlayerNotesRoutes,
  registerPlayerProfileRoutes,
  registerPlayerSearchRoutes,
  registerPlayerTransactionsRoutes,
} from '../src/api/routes/players';

let db: Database;
let scraperManager: { getDatabase: () => Database };

beforeEach(async () => {
  db = new AppDatabase(':memory:');
  scraperManager = { getDatabase: () => db, requestPlayer360Refresh: () => {} };
  await db.exec(`
    CREATE TABLE wager_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wager_number INTEGER UNIQUE NOT NULL,
      agent_id TEXT,
      customer_id TEXT,
      login TEXT,
      wager_type TEXT,
      amount_wagered REAL,
      to_win_amount REAL,
      insert_date_time TEXT NOT NULL,
      ticket_writer TEXT,
      volume_amount REAL,
      short_desc_raw TEXT,
      vip TEXT,
      agent_login TEXT,
      ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL,
      sport TEXT,
      league TEXT,
      price REAL
    );

    CREATE TABLE access_logs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      login_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      access_datetime TEXT NOT NULL,
      operation TEXT,
      data TEXT,
      log_type TEXT NOT NULL,
      pulled_at TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE deposits (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      agent_login TEXT,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT,
      method TEXT,
      ip_address TEXT,
      status TEXT,
      transaction_time TEXT NOT NULL,
      pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE player_transactions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      agent_login TEXT,
      document_number TEXT,
      tran_code TEXT,
      tran_type TEXT,
      amount REAL NOT NULL DEFAULT 0,
      balance REAL,
      hold_amount REAL,
      grade_num TEXT,
      description TEXT,
      entered_by TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      transaction_time TEXT NOT NULL,
      pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE customer_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      agent_login TEXT,
      kyc_level TEXT,
      vip_status TEXT,
      email_masked TEXT,
      phone_masked TEXT,
      currency TEXT,
      source TEXT NOT NULL DEFAULT 'probe',
      snapshot_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE player_source_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      source_key TEXT NOT NULL,
      refresh_policy TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 0,
      scale_class TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      next_refresh_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, customer_id, source_key)
    );

    CREATE TABLE player_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      player_a TEXT NOT NULL,
      player_b TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE player_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      flag_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      label TEXT NOT NULL,
      details TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE player_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'general',
      body TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      archived_at TEXT
    );

    CREATE TABLE watermarks (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE raw_api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      agent_id TEXT,
      duration_ms INTEGER,
      status_code INTEGER,
      request_params TEXT,
      response_json TEXT
    );
  `);

  await db.run(
    `INSERT INTO wager_archive
      (wager_number, agent_id, customer_id, login, wager_type, amount_wagered, to_win_amount, insert_date_time, ticket_writer, volume_amount, short_desc_raw, vip, agent_login, raw_json, sport, league, price)
     VALUES
      (1001, 'A1', 'P1', 'PLAYER1', 'M', 500, 450, '2026-05-01 10:00:00', 'Internet', 500, 'Football wager', '0', 'AGENT1', '{"ClosingLine":-104}', 'Football', 'NFL', -110),
      (1002, 'A1', 'P1', 'PLAYER1', 'M', 1500, 1250, '2026-05-02 10:00:00', 'GSLIVE', 1500, 'Basketball wager', '1', 'AGENT1', '{}', 'Basketball', 'NBA', -120),
      (1003, 'A2', 'P2', 'PLAYER2', 'S', 200, 180, '2026-05-03 10:00:00', 'Internet', 200, 'Baseball wager', '0', 'AGENT2', '{}', 'Baseball', 'MLB', 105)`
  );

  await db.run(
    `INSERT INTO access_logs
      (id, agent_id, login_id, ip_address, access_datetime, operation, data, log_type, pulled_at, raw_json)
     VALUES
      ('l1', 'A1', 'PLAYER1', '1.1.1.1', '2026-05-01 09:00:00', 'login', '{"device":"Chrome","geo":"US"}', 'web', '2026-05-01 09:00:01', '{}'),
      ('l2', 'A1', 'PLAYER1', '2.2.2.2', '2026-05-02 09:00:00', 'login', '{"device":"Mobile","geo":"US"}', 'web', '2026-05-02 09:00:01', '{}'),
      ('l3', 'A1', 'PLAYER2', '2.2.2.2', '2026-05-02 09:02:00', 'login', '{"device":"Chrome","geo":"US"}', 'web', '2026-05-02 09:02:01', '{}')`
  );

  await db.run(
    `INSERT INTO deposits
      (id, customer_id, login, agent_id, agent_login, amount, currency, method, ip_address, status, transaction_time, raw_json)
     VALUES
      ('d1', 'PLAYER1', 'PLAYER1', 'A1', 'AGENT1', 250, 'USD', 'card', '2.2.2.2', 'approved', '2026-05-02 08:00:00', '{}')`
  );

  await db.run(
    `INSERT INTO player_transactions
      (id, customer_id, login, agent_id, agent_login, document_number, tran_code, tran_type, amount, balance, hold_amount, grade_num, description, entered_by, category, transaction_time, raw_json)
     VALUES
      ('618181248', 'PLAYER1', 'PLAYER1', 'A1', 'AGENT1', '618181248', 'C', 'W', 4500, 4500, 0, '525520121', 'Wager Won', 'Internet', 'wager_win', '2026-05-02 08:30:00', '{}')`
  );

  await db.run(
    `INSERT INTO customer_snapshots
      (customer_id, login, agent_id, agent_login, kyc_level, vip_status, email_masked, phone_masked, currency, source, snapshot_time, raw_json)
     VALUES
      ('PLAYER1', 'PLAYER1', 'A1', 'AGENT1', 'verified', 'gold', 'p***@example.com', '***1234', 'USD', 'test', '2026-05-02 07:00:00', '{}')`
  );

  await db.run(
    `INSERT INTO player_source_status
      (customer_id, login, agent_id, source_key, refresh_policy, ttl_seconds, scale_class, last_attempt_at, last_success_at, next_refresh_at)
     VALUES
      ('PLAYER1', 'PLAYER1', 'AGENT1', 'player_transactions', 'on_open', 21600, 'heavy', '2026-05-02 08:29:00', '2026-05-02 08:30:00', '2026-05-02T14:30:00.000Z'),
      ('PLAYER1', 'PLAYER1', 'AGENT1', 'customer_snapshots', 'on_open', 86400, 'heavy', '2026-05-02 06:59:00', '2026-05-02 07:00:00', '2026-05-03T07:00:00.000Z'),
      ('PLAYER1', 'PLAYER1', 'AGENT1', 'teaser_profile', 'on_open', 86400, 'heavy', '2026-05-02 06:59:00', NULL, NULL)`
  );

  await db.run(
    `INSERT INTO player_links
      (player_a, player_b, reason, confidence, evidence_json, detected_at, status)
     VALUES
      ('PLAYER1', 'PLAYER2', 'shared_ip', 0.85, '{"ip":"2.2.2.2"}', '2026-05-02 09:05:00', 'active')`
  );

  await db.run(
    `INSERT INTO player_flags
      (customer_id, flag_type, severity, label, details, created_by, created_at, status)
     VALUES
      ('PLAYER1', 'manual_review', 'warning', 'Manual Review', 'Watch deposit velocity', 'test', '2026-05-02 09:10:00', 'active')`
  );

  await db.run(
    `INSERT INTO player_notes
      (customer_id, note_type, body, created_by, created_at)
     VALUES
      ('PLAYER1', 'telegram', 'Telegram: @player1', 'test', '2026-05-02 09:15:00')`
  );

  await db.run(
    `INSERT INTO watermarks (key, value, updated_at)
     VALUES
      ('last_player360_poll.AGENT1', '{"players":1,"deposits":1,"snapshots":1,"links":1}', '2026-05-02 09:20:00'),
      ('last_access_log_poll.AGENT1', '2026-05-02T09:00:00.000Z', '2026-05-02 09:01:00')`
  );

  await db.run(
    `INSERT INTO raw_api_logs (endpoint, fetched_at, agent_id, duration_ms, status_code, request_params, response_json)
     VALUES
      ('getCustomerDeposits', '2026-05-02 09:20:00', 'AGENT1', 12, 200, '{}', '{}'),
      ('getCustomerInfo', '2026-05-02 09:21:00', 'AGENT1', 12, 200, '{}', '{}')`
  );
});

afterEach(async () => {
  await db.close();
});

describe('player archive routes', () => {
  test('search returns aggregated player rows and agent filters', async () => {
    const res = await registerPlayerSearchRoutes(
      new URL('http://localhost/api/players/search?q=PLAYER&agent=AGENT1&sort=wagers'),
      new Request('http://localhost/api/players/search'),
      scraperManager as any
    );
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.count).toBe(1);
    expect(body.players[0].login).toBe('PLAYER1');
    expect(body.players[0].wagerCount).toBe(2);
    expect(body.players[0].totalVolume).toBe(2000);
    expect(body.agents).toContain('AGENT1');
  });

  test('50k player search stays local while opening one profile enqueues one hotset refresh', async () => {
    let refreshRequests = 0;
    const trackingManager = {
      getDatabase: () => db,
      requestPlayer360Refresh: () => {
        refreshRequests += 1;
      },
    };

    await db.exec(`
      WITH digits(n) AS (
        VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
      ),
      seq(x) AS (
        SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000 + e.n * 10000 + 1
        FROM digits a
        CROSS JOIN digits b
        CROSS JOIN digits c
        CROSS JOIN digits d
        CROSS JOIN digits e
      )
      INSERT INTO wager_archive
        (wager_number, agent_id, customer_id, login, wager_type, amount_wagered, to_win_amount, insert_date_time, ticket_writer, volume_amount, short_desc_raw, vip, agent_login, raw_json, sport, league, price)
      SELECT
        200000 + x,
        'SCALEA',
        'SCALE' || x,
        'SCALE' || x,
        'M',
        10,
        9,
        '2026-05-08 10:00:00',
        'Internet',
        10,
        'Scale wager',
        '0',
        'SCALE_AGENT',
        '{}',
        'Football',
        'NFL',
        -110
      FROM seq
      WHERE x <= 50000;
    `);

    const searchRes = await registerPlayerSearchRoutes(
      new URL('http://localhost/api/players/search?q=SCALE&sort=last'),
      new Request('http://localhost/api/players/search'),
      trackingManager as any
    );
    expect(searchRes?.status).toBe(200);
    expect(refreshRequests).toBe(0);

    const profileRes = await registerPlayerProfileRoutes(
      new URL('http://localhost/api/players/SCALE1/profile'),
      new Request('http://localhost/api/players/SCALE1/profile'),
      trackingManager as any
    );
    expect(profileRes?.status).toBe(200);
    expect(refreshRequests).toBe(1);
  });

  test('profile includes stats, wagers, weekly pnl, sports, and access logs', async () => {
    const res = await registerPlayerProfileRoutes(
      new URL('http://localhost/api/players/PLAYER1/profile'),
      new Request('http://localhost/api/players/PLAYER1/profile'),
      scraperManager as any
    );
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.stats.totalVolume).toBe(2000);
    expect(body.stats.favoriteSport).toBe('Basketball');
    expect(body.recentWagers).toHaveLength(2);
    expect(body.weeklyPnl.length).toBeGreaterThan(0);
    expect(body.sportBreakdown.length).toBeGreaterThan(0);
    expect(body.accessLogs[0].device).toBe('Mobile');
    expect(body.deposits[0].ip_matched_login).toBe(1);
    expect(body.transactions[0].description).toBe('Wager Won');
    expect(body.transactions[0].amount).toBe(4500);
    expect(body.stats.avgStake).toBe(1000);
    expect(body.stats.staleLineHits).toBeGreaterThan(0);
    expect(body.stats.pastPostingRate).toBeGreaterThan(0);
    expect(body.recentWagers[0].pattern_flags.length).toBeGreaterThan(0);
    expect(body.accountSnapshots[0].kyc_level).toBe('verified');
    expect(body.links[0].reason).toBe('shared_ip');
    expect(body.flags[0].label).toBe('Manual Review');
    expect(body.notes[0].body).toContain('@player1');
  });

  test('player 360 dataset endpoints return read-only slices', async () => {
    const endpoints = [
      [registerPlayerDepositsRoutes, 'deposits'],
      [registerPlayerTransactionsRoutes, 'transactions'],
      [registerPlayerAccountSnapshotsRoutes, 'accountSnapshots'],
      [registerPlayerLinksRoutes, 'links'],
      [registerPlayerFlagsRoutes, 'flags'],
      [registerPlayerNotesRoutes, 'notes'],
    ] as const;

    for (const [handler, key] of endpoints) {
      const res = await handler(
        new URL(`http://localhost/api/players/PLAYER1/${key === 'accountSnapshots' ? 'account-snapshots' : key}`),
        new Request('http://localhost/api/players/PLAYER1'),
        scraperManager as any
      );
      expect(res?.status).toBe(200);
      const body = await res!.json();
      expect(Array.isArray(body[key])).toBe(true);
      expect(body[key].length).toBeGreaterThan(0);
    }
  });

  test('player intelligence map reports source coverage, freshness, and gaps', async () => {
    const res = await registerPlayerIntelligenceMapRoutes(
      new URL('http://localhost/api/players/PLAYER1/intelligence-map'),
      new Request('http://localhost/api/players/PLAYER1/intelligence-map'),
      scraperManager as any
    );
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.profileContract.profile).toBe('/api/v1/players/PLAYER1/profile');
    expect(body.profileContract.tabs.Overview).toContain('/api/v1/players/PLAYER1/profile');
    expect(body.sources.map((source: any) => source.key)).toEqual([
      'wager_archive',
      'agent_performance_snapshots',
      'access_logs',
      'player_transactions',
      'deleted_transactions',
      'deposits',
      'customer_snapshots',
      'teaser_profile',
      'player_links',
      'player_flags',
      'player_notes',
    ]);
    expect(body.sources.find((source: any) => source.key === 'wager_archive').status).toBe('live');
    expect(body.sources.find((source: any) => source.key === 'agent_performance_snapshots').buckeyeEndpoint).toContain('getPerformancePlayer');
    expect(body.sources.find((source: any) => source.key === 'access_logs').status).toBe('live');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').status).toBe('live');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').buckeyeEndpoint).toContain('getTransactionHistory');
    expect(body.sources.find((source: any) => source.key === 'deleted_transactions').buckeyeEndpoint).toBe('getReportDeletedTransactions');
    expect(body.sources.find((source: any) => source.key === 'deleted_transactions').refreshPolicy).toBe('on_open');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').refreshPolicy).toBe('on_open');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').ttlSeconds).toBe(21600);
    expect(body.sources.find((source: any) => source.key === 'player_transactions').scaleClass).toBe('heavy');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').lastAttemptAt).toBe('2026-05-02 08:29:00');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').lastSuccessAt).toBe('2026-05-02 08:30:00');
    expect(body.sources.find((source: any) => source.key === 'player_transactions').nextRefreshAt).toBeTruthy();
    expect(body.sources.find((source: any) => source.key === 'player_transactions').freshnessState).toBeTruthy();
    expect(body.sources.find((source: any) => source.key === 'deposits').status).toBe('live');
    expect(body.sources.find((source: any) => source.key === 'customer_snapshots').status).toBe('live');
    expect(body.sources.find((source: any) => source.key === 'teaser_profile').status).toBe('probe');
    expect(body.sources.find((source: any) => source.key === 'teaser_profile').buckeyeEndpoint).toBe('getTeaserProfile');
    expect(body.sources.find((source: any) => source.key === 'teaser_profile').refreshPolicy).toBe('on_open');
    expect(body.tabCoverage.find((row: any) => row.tab === 'Deposits').recentUpdateAt).toBeTruthy();
    expect(body.tabCoverage.find((row: any) => row.tab === 'Deposits').recentUpdateSource).toBeTruthy();
    expect(body.tabCoverage.find((row: any) => row.tab === 'Deposits').weakestSource).toBeTruthy();
    expect(body.fieldContract.find((row: any) => row.field === 'stats.totalVolume').source).toContain('wager_archive');
    expect(body.fieldContract.find((row: any) => row.field === 'stats.riskScore').source).toContain('getPerformancePlayer');
    expect(body.fieldContract.find((row: any) => row.tab === 'Status / Docs').route).toContain('/intelligence-map');
    expect(body.contractMismatches.map((row: any) => row.key)).toContain('closing_line_feed');
    expect(body.freshness.wager_archive.rowCount).toBe(2);
    expect(body.freshness.watermarks.player360.value.players).toBe(1);
    expect(body.gaps.map((gap: any) => gap.key)).toContain('closing_line_feed');
    expect(body.gaps.map((gap: any) => gap.key)).toContain('withdrawals');
    expect(body.gaps.map((gap: any) => gap.key)).toContain('kyc_documents');
    expect(body.gaps.map((gap: any) => gap.key)).toContain('source_of_funds');
    expect(body.coverage.haveNow).toContain('live wagers');
    expect(body.coverage.haveNow).toContain('transaction ledger');
    expect(body.coverage.canReuse).toContain('getTransactionList/getTransactionHistory/getReportDeletedTransactions ledger');
    expect(body.coverage.canReuse).toContain('raw API logs');
    expect(body.coverage.needOrProbe).toContain('getInfoPlayer/getTeaserProfile customer profile payload shape');
    expect(body.coverage.needOrProbe).toContain('true closing line');
  });

  test('player intelligence map marks archive missing when selected player has no real rows', async () => {
    const res = await registerPlayerIntelligenceMapRoutes(
      new URL('http://localhost/api/players/UNKNOWN/intelligence-map'),
      new Request('http://localhost/api/players/UNKNOWN/intelligence-map'),
      scraperManager as any
    );
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.sources.find((source: any) => source.key === 'wager_archive').status).toBe('missing');
    expect(body.contractMismatches.find((row: any) => row.key === 'missing_wager_archive').severity).toBe('critical');
  });

  test('player export streams csv', async () => {
    const res = await registerPlayerExportRoutes(
      new URL('http://localhost/api/players/PLAYER1/export/wagers'),
      new Request('http://localhost/api/players/PLAYER1/export/wagers'),
      scraperManager as any
    );
    expect(res?.headers.get('Content-Type')).toContain('text/csv');
    const csv = await res!.text();
    expect(csv).toContain('wager_number');
    expect(csv).toContain('1002');
  });

  test('player 360 mutation routes create flags, notes, and link checks', async () => {
    const flagRes = await registerPlayerFlagCreateRoutes(
      new URL('http://localhost/api/players/PLAYER1/flags'),
      new Request('http://localhost/api/players/PLAYER1/flags', {
        method: 'POST',
        body: JSON.stringify({ flag_type: 'suspicious_pattern', severity: 'high', label: 'Suspicious Pattern' }),
      }),
      scraperManager as any
    );
    expect(flagRes?.status).toBe(200);
    expect((await flagRes!.json()).flagId).toBeGreaterThan(0);

    const noteRes = await registerPlayerNoteCreateRoutes(
      new URL('http://localhost/api/players/PLAYER1/notes'),
      new Request('http://localhost/api/players/PLAYER1/notes', {
        method: 'POST',
        body: JSON.stringify({ note_type: 'telegram', body: 'Telegram: @fresh' }),
      }),
      scraperManager as any
    );
    expect(noteRes?.status).toBe(200);
    expect((await noteRes!.json()).noteId).toBeGreaterThan(0);

    const linkRes = await registerPlayerLinkCheckRoutes(
      new URL('http://localhost/api/players/PLAYER1/links/check'),
      new Request('http://localhost/api/players/PLAYER1/links/check', { method: 'POST' }),
      scraperManager as any
    );
    expect(linkRes?.status).toBe(200);
    const linkBody = await linkRes!.json();
    expect(linkBody.links.length).toBeGreaterThan(0);
  });
});
