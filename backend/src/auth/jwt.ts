/**
 * JWT authentication utilities
 * Uses jose for HS256 signing/verification — native Bun support.
 */
import * as jose from 'jose';

const JWT_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes (matches Buckeye token renewal)
const JWT_ALG = 'HS256';

export interface JwtPayload {
  agentId: string;
  iat: number;
  exp: number;
}

/**
 * Create a signed JWT for the given agentId.
 */
export async function createToken(agentId: string, secret: string): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);

  const jwt = await new jose.SignJWT({ agentId })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + Math.floor(JWT_EXPIRY_MS / 1000))
    .sign(secretKey);

  return jwt;
}

/**
 * Verify a JWT and return the payload.
 * Throws on invalid/expired token.
 */
export async function verifyToken(token: string, secret: string): Promise<JwtPayload> {
  const secretKey = new TextEncoder().encode(secret);

  const { payload } = await jose.jwtVerify(token, secretKey, {
    algorithms: [JWT_ALG],
  });

  return {
    agentId: payload.agentId as string,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}

/**
 * Returns true if NODE_ENV=development (dev bypass for auth).
 */
export function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development';
}
