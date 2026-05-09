import { secrets } from 'bun';

const BUCKEYE_SERVICE = 'sportsterminal.buckeye';
const LAST_AGENT_NAME = '__last_agent';
const AGENT_INDEX_NAME = '__agents';

export interface BuckeyeSecretValues {
  agentId: string;
  password?: string;
  cfCookie?: string;
  token?: string;
}

export interface BuckeyeSecretStatus {
  agentId: string | null;
  hasPassword: boolean;
  hasCfCookie: boolean;
  hasToken: boolean;
}

export interface SecretStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<void>;
}

export class BunSecretVault {
  constructor(private readonly store: SecretStore = secrets) {}

  async saveBuckeyeSecrets(values: BuckeyeSecretValues): Promise<void> {
    const agentId = normalizeAgentId(values.agentId);
    if (!agentId) return;

    await this.set(`${agentId}:agent`, agentId);
    await this.addAgentToIndex(agentId);
    await this.set(LAST_AGENT_NAME, agentId);

    if (values.password) {
      await this.set(`${agentId}:password`, values.password);
    }
    if (values.cfCookie) {
      await this.set(`${agentId}:cfCookie`, values.cfCookie);
    }
    if (values.token) {
      await this.set(`${agentId}:token`, values.token);
    }
  }

  async getBuckeyeSecrets(agentId?: string): Promise<BuckeyeSecretValues | null> {
    const resolvedAgentId = normalizeAgentId(agentId || (await this.get(LAST_AGENT_NAME)) || '');
    if (!resolvedAgentId) return null;

    const [password, cfCookie, token] = await Promise.all([
      this.get(`${resolvedAgentId}:password`),
      this.get(`${resolvedAgentId}:cfCookie`),
      this.get(`${resolvedAgentId}:token`),
    ]);

    if (!password && !token) return null;
    return {
      agentId: resolvedAgentId,
      password: password || undefined,
      cfCookie: cfCookie || undefined,
      token: token || undefined,
    };
  }

  async getAllBuckeyeSecrets(): Promise<BuckeyeSecretValues[]> {
    const agentIds = await this.getBuckeyeAgentIds();
    const secrets = await Promise.all(agentIds.map((agentId) => this.getBuckeyeSecrets(agentId)));
    return secrets.filter((secret): secret is BuckeyeSecretValues => Boolean(secret));
  }

  async getBuckeyeAgentIds(): Promise<string[]> {
    const indexed = parseAgentIndex(await this.get(AGENT_INDEX_NAME));
    const lastAgent = normalizeAgentId((await this.get(LAST_AGENT_NAME)) || '');
    if (lastAgent && !indexed.includes(lastAgent)) {
      indexed.push(lastAgent);
    }
    return indexed;
  }

  async getBuckeyeSecretStatus(agentId?: string): Promise<BuckeyeSecretStatus | BuckeyeSecretStatus[]> {
    if (!agentId) {
      const agentIds = await this.getBuckeyeAgentIds();
      return Promise.all(agentIds.map((id) => this.getSingleBuckeyeSecretStatus(id)));
    }
    return this.getSingleBuckeyeSecretStatus(agentId);
  }

  private async getSingleBuckeyeSecretStatus(agentId?: string): Promise<BuckeyeSecretStatus> {
    const resolvedAgentId = normalizeAgentId(agentId || (await this.get(LAST_AGENT_NAME)) || '');
    if (!resolvedAgentId) {
      return {
        agentId: null,
        hasPassword: false,
        hasCfCookie: false,
        hasToken: false,
      };
    }

    const [password, cfCookie, token] = await Promise.all([
      this.get(`${resolvedAgentId}:password`),
      this.get(`${resolvedAgentId}:cfCookie`),
      this.get(`${resolvedAgentId}:token`),
    ]);

    return {
      agentId: resolvedAgentId,
      hasPassword: Boolean(password),
      hasCfCookie: Boolean(cfCookie),
      hasToken: Boolean(token),
    };
  }

  async clearBuckeyeSecrets(agentId?: string): Promise<void> {
    const resolvedAgentId = normalizeAgentId(agentId || (await this.get(LAST_AGENT_NAME)) || '');
    if (!resolvedAgentId) return;

    await Promise.all([
      this.delete(`${resolvedAgentId}:agent`),
      this.delete(`${resolvedAgentId}:password`),
      this.delete(`${resolvedAgentId}:cfCookie`),
      this.delete(`${resolvedAgentId}:token`),
    ]);
    await this.removeAgentFromIndex(resolvedAgentId);
  }

  async clearAllBuckeyeSecrets(): Promise<void> {
    const agentIds = await this.getBuckeyeAgentIds();
    for (const agentId of agentIds) {
      await this.clearBuckeyeSecrets(agentId);
    }
    await Promise.all([
      this.delete(AGENT_INDEX_NAME),
      this.delete(LAST_AGENT_NAME),
    ]);
  }

  private async addAgentToIndex(agentId: string): Promise<void> {
    const agentIds = await this.getBuckeyeAgentIds();
    if (!agentIds.includes(agentId)) {
      agentIds.push(agentId);
      await this.set(AGENT_INDEX_NAME, JSON.stringify(agentIds.sort()));
    }
  }

  private async removeAgentFromIndex(agentId: string): Promise<void> {
    const agentIds = (await this.getBuckeyeAgentIds()).filter((id) => id !== agentId);
    if (agentIds.length > 0) {
      await this.set(AGENT_INDEX_NAME, JSON.stringify(agentIds));
      const lastAgent = normalizeAgentId((await this.get(LAST_AGENT_NAME)) || '');
      if (lastAgent === agentId) {
        await this.set(LAST_AGENT_NAME, agentIds[agentIds.length - 1]);
      }
    } else {
      await Promise.all([
        this.delete(AGENT_INDEX_NAME),
        this.delete(LAST_AGENT_NAME),
      ]);
    }
  }

  private async get(name: string): Promise<string | null> {
    try {
      return await this.store.get({ service: BUCKEYE_SERVICE, name });
    } catch (error) {
      console.warn(`[SecretVault] Unable to read ${name}:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  private async set(name: string, value: string): Promise<void> {
    try {
      await this.store.set({ service: BUCKEYE_SERVICE, name, value });
    } catch (error) {
      console.warn(`[SecretVault] Unable to save ${name}:`, error instanceof Error ? error.message : error);
    }
  }

  private async delete(name: string): Promise<void> {
    try {
      await this.store.delete({ service: BUCKEYE_SERVICE, name });
    } catch (error) {
      console.warn(`[SecretVault] Unable to delete ${name}:`, error instanceof Error ? error.message : error);
    }
  }
}

function normalizeAgentId(value: string): string {
  return value.trim().toUpperCase();
}

function parseAgentIndex(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((entry) => normalizeAgentId(String(entry))).filter(Boolean))).sort();
  } catch {
    return [];
  }
}
