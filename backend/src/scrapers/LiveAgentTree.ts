import type { EnrichedWager } from '../risk/AlertEngine';
import { decodeEntities } from '../utils/decodeEntities';

export interface AgentDelta {
  agent: string;
  total_volume: number;
  total_risk: number;
  wager_count: number;
  alert_count: number;
  live_count: number;
  top_game: string;
  top_customer: string;
}

interface AgentNode {
  agentId: string;
  login: string;
  level: number;
  type: 'A' | 'M';
  parentId: string | null;
  children: Map<string, AgentNode>;
  totalRisk: number;
  totalVolume: number;
  wagerCount: number;
  alertCount: number;
  liveCount: number;
  topGame: string;
  topCustomer: string;
  gameAmounts: Map<string, number>;
  customerAmounts: Map<string, number>;
}

type AgentUpdateSubscriber = (delta: AgentDelta) => void;

interface AgentTreeSourceRow {
  SeqNumber?: unknown;
  Login?: unknown;
  AgentID?: unknown;
  Level?: unknown;
  AgentType?: unknown;
}

export class LiveAgentTree {
  private nodes: Map<string, AgentNode> = new Map();
  private aliases: Map<string, AgentNode> = new Map();
  private roots: AgentNode[] = [];
  private subscribers: Set<AgentUpdateSubscriber> = new Set();

  constructor(agents: unknown[] = []) {
    this.rebuild(agents);
  }

  rebuild(agents: unknown[]): void {
    this.nodes.clear();
    this.aliases.clear();
    this.roots = [];

    const stack: { level: number; node: AgentNode }[] = [];
    const sortedAgents = (agents as AgentTreeSourceRow[]).sort((a, b) => {
      return (Number(a?.SeqNumber) || 0) - (Number(b?.SeqNumber) || 0);
    });

    for (const agent of sortedAgents) {
      const login = String(agent?.Login || agent?.AgentID || '').trim();
      const agentId = String(agent?.AgentID || login).trim();
      if (!login && !agentId) continue;

      const level = Number(agent?.Level) || 1;
      const node = this.createNode({
        agentId: agentId || login,
        login: login || agentId,
        level,
        type: agent?.AgentType === 'M' ? 'M' : 'A',
      });

      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }

      if (stack.length > 0) {
        const parent = stack[stack.length - 1].node;
        node.parentId = parent.agentId;
        parent.children.set(node.agentId, node);
      } else {
        this.roots.push(node);
      }

      this.addNode(node);
      stack.push({ level: node.level, node });
    }
  }

  processWager(wager: EnrichedWager): AgentDelta[] {
    const agentLogin = String(wager.AgentLogin || wager.AgentID || '').trim();
    if (!agentLogin) return [];

    const node = this.findOrCreateAgent(agentLogin);
    const amount = Number(wager.AmountWagered) || 0;
    const risk = Number(wager.VolumeAmount || wager.ToWinAmount || wager.AmountWagered) || 0;
    const game = this.extractGame(wager.ShortDesc);
    const customer = String(wager.Login || wager.CustomerID || 'Unknown').trim() || 'Unknown';
    const isLive = wager.TicketWriter === 'GSLIVE';

    const deltas: AgentDelta[] = [];
    this.applyWagerToNode(node, { amount, risk, game, customer, isLive, includeWager: true });
    deltas.push(this.toDelta(node));

    let current = node.parentId ? this.nodes.get(node.parentId) || null : null;
    while (current) {
      this.applyWagerToNode(current, { amount, risk, game, customer, isLive, includeWager: false });
      deltas.push(this.toDelta(current));
      current = current.parentId ? this.nodes.get(current.parentId) || null : null;
    }

    for (const delta of deltas) {
      this.notify(delta);
    }
    return deltas;
  }

  processAlert(agentLogin: string): AgentDelta[] {
    const node = this.findNode(agentLogin);
    if (!node) return [];

    const deltas: AgentDelta[] = [];
    let current: AgentNode | null = node;
    while (current) {
      current.alertCount++;
      deltas.push(this.toDelta(current));
      current = current.parentId ? this.nodes.get(current.parentId) || null : null;
    }

    for (const delta of deltas) {
      this.notify(delta);
    }
    return deltas;
  }

  onUpdate(callback: AgentUpdateSubscriber): void {
    this.subscribers.add(callback);
  }

  getFlatList(): AgentDelta[] {
    return Array.from(this.nodes.values()).map((node) => this.toDelta(node));
  }

  private applyWagerToNode(
    node: AgentNode,
    update: {
      amount: number;
      risk: number;
      game: string;
      customer: string;
      isLive: boolean;
      includeWager: boolean;
    }
  ): void {
    node.totalVolume += update.amount;
    node.totalRisk += update.risk;
    if (update.includeWager) {
      node.wagerCount++;
    }
    if (update.isLive) {
      node.liveCount++;
    }

    node.gameAmounts.set(update.game, (node.gameAmounts.get(update.game) || 0) + update.risk);
    node.customerAmounts.set(update.customer, (node.customerAmounts.get(update.customer) || 0) + update.risk);
    node.topGame = this.findTopKey(node.gameAmounts);
    node.topCustomer = this.findTopKey(node.customerAmounts);
  }

  private findOrCreateAgent(agentLogin: string): AgentNode {
    const existing = this.findNode(agentLogin);
    if (existing) return existing;

    const node = this.createNode({
      agentId: agentLogin,
      login: agentLogin,
      level: 1,
      type: 'A',
    });
    this.roots.push(node);
    this.addNode(node);
    return node;
  }

  private findNode(agentLogin: string): AgentNode | undefined {
    const key = this.normalizeKey(agentLogin);
    return this.aliases.get(key);
  }

  private addNode(node: AgentNode): void {
    this.nodes.set(node.agentId, node);
    this.aliases.set(this.normalizeKey(node.agentId), node);
    this.aliases.set(this.normalizeKey(node.login), node);
  }

  private createNode(input: {
    agentId: string;
    login: string;
    level: number;
    type: 'A' | 'M';
  }): AgentNode {
    return {
      agentId: input.agentId,
      login: input.login,
      level: input.level,
      type: input.type,
      parentId: null,
      children: new Map(),
      totalRisk: 0,
      totalVolume: 0,
      wagerCount: 0,
      alertCount: 0,
      liveCount: 0,
      topGame: '',
      topCustomer: '',
      gameAmounts: new Map(),
      customerAmounts: new Map(),
    };
  }

  private toDelta(node: AgentNode): AgentDelta {
    return {
      agent: node.login,
      total_volume: node.totalVolume,
      total_risk: node.totalRisk,
      wager_count: node.wagerCount,
      alert_count: node.alertCount,
      live_count: node.liveCount,
      top_game: node.topGame,
      top_customer: node.topCustomer,
    };
  }

  private notify(delta: AgentDelta): void {
    for (const subscriber of this.subscribers) {
      subscriber(delta);
    }
  }

  private extractGame(shortDesc: string): string {
    if (!shortDesc) return 'Unknown';
    const decoded = decodeEntities(shortDesc);

    const standard = decoded.match(/^[A-Z][.:\s][\w\s]+?\s+#\d+\s+(.+?)(?:\s+-\s+For\s|\s+for\s+Game|\s+\/|\s+-\s+\d)/i);
    if (standard) return standard[1].trim().substring(0, 35);

    const live = decoded.match(/^[A-Z][.:]G?\d+\s+-\s+(?:Top\s+)?\w+\s+-\s+(.+?)(?:\s+\/|\s+-\s+For\s|$)/);
    if (live) return live[1].trim().substring(0, 35);

    const hashFallback = decoded.split('#')[1]?.split('-')[0]?.trim();
    return hashFallback || 'Unknown';
  }

  private findTopKey(amounts: Map<string, number>): string {
    let topKey = '';
    let topAmount = 0;
    for (const [key, amount] of amounts.entries()) {
      if (amount > topAmount) {
        topAmount = amount;
        topKey = key;
      }
    }
    return topKey;
  }

  private normalizeKey(value: string): string {
    return value.trim().toUpperCase();
  }
}
