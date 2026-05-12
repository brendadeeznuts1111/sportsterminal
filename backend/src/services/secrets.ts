/**
 * secrets.ts — OS keychain access for SportsTerminal.
 * Shares the same service namespace as KimiRemote integration
 * so credentials are portable across both projects.
 */
import { secrets } from 'bun';

const SERVICE = 'com.sports-terminal.integration';

export const CREDENTIAL_NAMES = [
  'buckeye-customer-id',
  'buckeye-password',
  'buckeye-api-key',
  'cf-clearance',
  'kimi-api-key',
  'proxy-admin-key',
  'agent-id',
  'agent-owner',
  'cloudflare-api-token',
  'telegram-bot-token',
  'telegram-chat-id',
  'telegram-topic-risk-alerts',
  'telegram-topic-webhook-events',
  'telegram-topic-service-health',
  'telegram-topic-domain-dns',
  'telegram-topic-analytics',
  'telegram-topic-bot-miniapp',
] as const;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export async function getCredential(name: CredentialName): Promise<string | null> {
  try {
    return await secrets.get({ service: SERVICE, name });
  } catch {
    return null;
  }
}

export async function setCredential(name: CredentialName, value: string): Promise<void> {
  await secrets.set({ service: SERVICE, name, value });
}

export async function deleteCredential(name: CredentialName): Promise<boolean> {
  try {
    return await secrets.delete({ service: SERVICE, name });
  } catch {
    return false;
  }
}

export async function getAllSecretsStatus(): Promise<Record<CredentialName, boolean>> {
  const result = {} as Record<CredentialName, boolean>;
  for (const name of CREDENTIAL_NAMES) {
    const val = await getCredential(name);
    result[name] = val !== null;
  }
  return result;
}
