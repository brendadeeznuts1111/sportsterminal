import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import type { BuckeyeCredentials } from '../scrapers/BuckeyeAPI';
import type { BunSecretVault } from './BunSecretVault';

export interface BuckeyeVaultRestoreResult {
  restored: string[];
  failed: Array<{ agentId: string; error: string }>;
}

export async function restoreBuckeyeAgentsFromVault(
  secretVault: BunSecretVault,
  scraperManager: BuckeyeScraperManager,
  baseUrl?: string
): Promise<BuckeyeVaultRestoreResult> {
  const result: BuckeyeVaultRestoreResult = { restored: [], failed: [] };
  const savedAgents = await secretVault.getAllBuckeyeSecrets();

  for (const saved of savedAgents) {
    const credentials: BuckeyeCredentials = {
      agentId: saved.agentId,
      password: saved.password || '',
      baseUrl,
      cfCookie: saved.cfCookie,
      token: saved.token,
    };

    try {
      if (saved.token) {
        const resumed = await scraperManager.resumeAgent(saved.agentId, credentials, saved.token);
        if (resumed) {
          result.restored.push(saved.agentId);
          continue;
        }
      }

      if (saved.password) {
        // Clear stale token so startAgent performs a fresh login
        delete credentials.token;
        await scraperManager.startAgent(saved.agentId, credentials);
        result.restored.push(saved.agentId);
        continue;
      }

      result.failed.push({ agentId: saved.agentId, error: 'No password available for re-login' });
    } catch (error) {
      result.failed.push({
        agentId: saved.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
