/**
 * Generate a JWT token for testing WebSocket connections.
 *
 * Usage:
 *   bun run scripts/generate-jwt.ts <agentId>
 *   bun run scripts/generate-jwt.ts TEST_AGENT
 *
 * Set JWT_SECRET env var or uses the default.
 */
import { createToken } from '../src/auth/jwt';

const agentId = process.argv[2] || 'TEST_AGENT';
const secret = process.env.JWT_SECRET || 'change-me-in-production-min-32-chars';

const token = await createToken(agentId, secret);
console.log(`JWT for agent "${agentId}":`);
console.log(token);
console.log();
console.log('Use with WebSocket:');
console.log(`  ws://localhost:3000/ws?token=${token}`);
