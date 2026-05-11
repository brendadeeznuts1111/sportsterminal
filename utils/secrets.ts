import { secrets } from "bun";

export const BUCKEYE_PROXY_SECRET_SERVICE = "com.sports-terminal.buckeye-proxy";
export const PROXY_SECRET_INDEX_NAME = "_index";

export const PROXY_SECRET_NAMES = {
  proxyAdminKey: "proxy-admin-key",
  buckeyeApiKey: "buckeye-api-key",
  buckeyeCustomerId: "buckeye-customer-id",
  password: "buckeye-password",
  agentId: "agent-id",
  agentOwner: "agent-owner",
  kimiApiKey: "kimi-api-key",
  cfClearance: "cf-clearance",
} as const;

export type ProxySecretName = typeof PROXY_SECRET_NAMES[keyof typeof PROXY_SECRET_NAMES];

export const KNOWN_PROXY_SECRET_NAMES = [
  PROXY_SECRET_NAMES.proxyAdminKey,
  PROXY_SECRET_NAMES.buckeyeApiKey,
  PROXY_SECRET_NAMES.buckeyeCustomerId,
  PROXY_SECRET_NAMES.password,
  PROXY_SECRET_NAMES.agentId,
  PROXY_SECRET_NAMES.agentOwner,
  PROXY_SECRET_NAMES.kimiApiKey,
  PROXY_SECRET_NAMES.cfClearance,
] as const;

const LEGACY_SECRET_ALIASES: Partial<Record<ProxySecretName, string[]>> = {
  [PROXY_SECRET_NAMES.cfClearance]: ["buckeye-cf-clearance"],
};

export interface SecretStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<void | boolean>;
}

export async function getSecret(name: string, store: SecretStore = secrets): Promise<string | null> {
  return store.get({ service: BUCKEYE_PROXY_SECRET_SERVICE, name });
}

export async function setSecret(name: string, value: string, store: SecretStore = secrets): Promise<void> {
  await store.set({ service: BUCKEYE_PROXY_SECRET_SERVICE, name, value });
}

export async function deleteSecret(name: string, store: SecretStore = secrets): Promise<boolean> {
  return Boolean(await store.delete({ service: BUCKEYE_PROXY_SECRET_SERVICE, name }));
}

export function scopedSecretName(name: ProxySecretName, customerID?: string | null): string {
  const normalizedCustomer = normalizeCustomerID(customerID);
  return normalizedCustomer ? `${normalizedCustomer}:${name}` : name;
}

export async function getScopedSecret(name: ProxySecretName, customerID?: string | null): Promise<string | null> {
  for (const candidate of scopedLookupNames(name, customerID)) {
    const secret = await safeSecretRead(candidate);
    if (secret) return secret;
  }
  return null;
}

export async function setScopedSecret(name: ProxySecretName, value: string, customerID?: string | null): Promise<void> {
  const secretName = scopedSecretName(name, customerID);
  await safeSecretWrite(secretName, value);
  await addSecretNameToIndex(secretName);
}

export async function deleteScopedSecret(name: ProxySecretName, customerID?: string | null): Promise<boolean> {
  const secretName = scopedSecretName(name, customerID);
  const deleted = await safeSecretDelete(secretName);
  await removeSecretNameFromIndex(secretName);
  return deleted;
}

export async function getManagedSecret(name: string): Promise<string | null> {
  for (const candidate of secretLookupNames(name)) {
    const secret = await safeSecretRead(candidate);
    if (secret) return secret;
  }
  return null;
}

export async function setManagedSecret(name: string, value: string): Promise<void> {
  await setSecret(name, value);
  await addSecretNameToIndex(name);
}

export async function deleteManagedSecret(name: string): Promise<boolean> {
  let deleted = false;
  for (const candidate of secretLookupNames(name)) {
    deleted = Boolean(await deleteSecret(candidate)) || deleted;
    await removeSecretNameFromIndex(candidate);
  }
  return deleted;
}

export async function getManagedSecretNames(): Promise<string[]> {
  const indexed = parseSecretIndex(await safeSecretRead(PROXY_SECRET_INDEX_NAME));
  const names = new Set<string>([...KNOWN_PROXY_SECRET_NAMES, ...indexed]);
  return Array.from(names).sort();
}

export function proxySecretEnvFallback(name: ProxySecretName): string {
  if (name === PROXY_SECRET_NAMES.password) {
    return Bun.env.BUCKEYE_PASSWORD || "";
  }
  return extractCfClearanceValue(
    Bun.env.BUCKEYE_CF_CLEARANCE ||
    Bun.env.BUCKEYE_CF_COOKIE ||
    Bun.env.CF_COOKIE ||
    ""
  );
}

export function shouldUseKeychain(): boolean {
  return Bun.env.CI !== "true" && Bun.env.NODE_ENV !== "production" && Bun.env.PROXY_PRODUCTION !== "true";
}

export function extractCfClearanceValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.includes("cf_clearance=")) return trimmed;

  const match = trimmed.match(/(?:^|;\s*)cf_clearance=([^;]+)/);
  return match?.[1]?.trim() || "";
}

function normalizeCustomerID(value?: string | null): string {
  return String(value || "").trim().toUpperCase();
}

function secretLookupNames(name: string): string[] {
  const aliases = LEGACY_SECRET_ALIASES[name as ProxySecretName] || [];
  return Array.from(new Set([name, ...aliases]));
}

function scopedLookupNames(name: ProxySecretName, customerID?: string | null): string[] {
  const normalizedCustomer = normalizeCustomerID(customerID);
  const names = secretLookupNames(name);
  if (!normalizedCustomer) return names;

  return [
    ...names.map((candidate) => `${normalizedCustomer}:${candidate}`),
    ...names,
  ];
}

function parseSecretIndex(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((entry) => String(entry).trim()).filter(Boolean))).sort();
  } catch {
    return [];
  }
}

async function addSecretNameToIndex(name: string): Promise<void> {
  if (!name || name === PROXY_SECRET_INDEX_NAME) return;
  const names = new Set(parseSecretIndex(await safeSecretRead(PROXY_SECRET_INDEX_NAME)));
  names.add(name);
  await safeSecretWrite(PROXY_SECRET_INDEX_NAME, JSON.stringify(Array.from(names).sort()));
}

async function removeSecretNameFromIndex(name: string): Promise<void> {
  const names = parseSecretIndex(await safeSecretRead(PROXY_SECRET_INDEX_NAME)).filter((entry) => entry !== name);
  await safeSecretWrite(PROXY_SECRET_INDEX_NAME, JSON.stringify(names));
}

async function safeSecretRead(name: string): Promise<string | null> {
  try {
    return await getSecret(name);
  } catch (error) {
    console.warn("[ProxySecrets] Unable to read secret:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function safeSecretWrite(name: string, value: string): Promise<void> {
  try {
    await setSecret(name, value);
  } catch (error) {
    console.warn("[ProxySecrets] Unable to save secret:", error instanceof Error ? error.message : String(error));
  }
}

async function safeSecretDelete(name: string): Promise<boolean> {
  try {
    return await deleteSecret(name);
  } catch (error) {
    console.warn("[ProxySecrets] Unable to delete secret:", error instanceof Error ? error.message : String(error));
    return false;
  }
}
