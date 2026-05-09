export interface AppEnv {
  PORT: number;
  HOST: string;
  JWT_SECRET: string;
  BUCKEYE_BASE_URL?: string;
  DEBUG: boolean;
}

export function loadEnv(source: Record<string, string | undefined> = Bun.env): AppEnv {
  const nodeEnv = source.NODE_ENV || 'development';
  const jwtSecret = source.JWT_SECRET || 'change-me-in-production-min-32-chars';

  if (nodeEnv === 'production' && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }

  const port = parsePort(source.PORT || '3000');
  const host = source.HOST || '0.0.0.0';
  if (!host.trim()) {
    throw new Error('HOST cannot be empty');
  }

  const buckeyeBaseUrl = source.BUCKEYE_BASE_URL;
  if (buckeyeBaseUrl) {
    try {
      new URL(buckeyeBaseUrl);
    } catch {
      throw new Error('BUCKEYE_BASE_URL must be a valid URL');
    }
  }

  return {
    PORT: port,
    HOST: host,
    JWT_SECRET: jwtSecret,
    BUCKEYE_BASE_URL: buckeyeBaseUrl,
    DEBUG: source.DEBUG === '1' || source.DEBUG === 'true',
  };
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}
