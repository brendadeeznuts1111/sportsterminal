import { describe, expect, test } from 'bun:test';

import {
  ProxyClientError,
  extractBuckeyeCookies,
  proxyCall,
  type ProxyCredentialProvider,
} from '../src/services/ProxyClient';

const provider: ProxyCredentialProvider = {
  async getEnhancedProxyCredentials() {
    return {
      agentID: 'BILLY666',
      token: 'buckeye-token',
      cf_clearance: 'cf-token',
      __cf_bm: 'bm-token',
    };
  },
};

describe('ProxyClient', () => {
  test('extracts Cloudflare cookies from a browser cookie header', () => {
    expect(extractBuckeyeCookies('foo=bar; cf_clearance=clear123; __cf_bm=bm456')).toEqual({
      cf_clearance: 'clear123',
      __cf_bm: 'bm456',
    });
  });

  test('treats a bare cookie value as cf_clearance', () => {
    expect(extractBuckeyeCookies('clear123')).toEqual({ cf_clearance: 'clear123' });
  });

  test('injects internal API key and vaulted Buckeye auth into POST body', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const result = await proxyCall<{ ok: boolean }>(provider, {
      endpoint: '/api/proxy/agentDownline',
      agentId: 'BILLY666',
      body: { agentID: 'BILLY666' },
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return Response.json({ ok: true });
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe('http://localhost:3001/api/proxy/agentDownline');
    expect((capturedInit?.headers as Record<string, string>)['X-API-Key']).toBe('dev-key-123');
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.agentID).toBe('BILLY666');
    expect(body.token).toBe('buckeye-token');
    expect(body.cf_clearance).toBe('cf-token');
    expect(body.__cf_bm).toBe('bm-token');
  });

  test('throws a typed error when the internal proxy rejects a request', async () => {
    await expect(proxyCall(provider, {
      endpoint: '/api/proxy/agentDownline',
      body: { agentID: 'BILLY666' },
      retries: 0,
      fetchImpl: async () => Response.json({ error: 'Nope' }, { status: 502 }) as Response,
    })).rejects.toThrow(ProxyClientError);
  });
});
