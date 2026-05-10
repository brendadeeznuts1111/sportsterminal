interface BackendSmokeCase {
  name: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  okStatuses?: number[];
  validate?: (body: unknown, status: number) => true | string;
}

const baseUrl = (Bun.env.BACKEND_SMOKE_URL || `http://localhost:${Bun.env.PORT || Bun.env.BACKEND_PORT || '3000'}`).replace(/\/$/, '');

const cases: BackendSmokeCase[] = [
  {
    name: 'backend health',
    path: '/health',
    validate: (body) => isObject(body) && ('status' in body || 'service' in body || 'timestamp' in body),
  },
  {
    name: 'system status rollup',
    path: '/api/health/system-status',
    validate: (body) => {
      if (!isObject(body)) return 'expected JSON object';
      if (typeof body.status !== 'string') return 'expected status string';
      if (!('enhancedProxyHealth' in body || 'proxyHealth' in body || 'details' in body)) {
        return 'expected enhanced proxy health/detail fields in system status';
      }
      if (!isObject(body.proxy) || typeof body.proxy.status !== 'string' || typeof body.proxy.url !== 'string') {
        return 'expected top-level proxy status object';
      }
      return true;
    },
  },
  {
    name: 'backend proxy status',
    path: '/api/proxy/status',
    okStatuses: [200, 401],
    validate: (body, status) => {
      if (status === 401) return isStructuredAuthError(body);
      return isObject(body) && typeof body.service === 'string' && body.service.includes('Proxy')
        ? true
        : 'expected proxy status object';
    },
  },
  {
    name: 'backend proxy endpoint catalog',
    path: '/api/proxy/endpoints',
    okStatuses: [200, 401],
    validate: (body, status) => {
      if (status === 401) return isStructuredAuthError(body);
      if (!isObject(body)) return 'expected JSON object';
      if (!isObject(body.endpoints)) return 'expected endpoints object';
      if (!isObject(body.endpoints.proxy)) return 'expected proxy endpoint map';
      if (!isObject(body.endpoints.manager)) return 'expected manager endpoint map';
      return true;
    },
  },
  {
    name: 'unified proxy auth guard',
    path: '/api/proxy/agentDownline',
    method: 'POST',
    body: { agentID: 'SMOKE_NO_STORED_TOKEN' },
    okStatuses: [400, 401, 502, 503],
    validate: (body, status) => {
      if (status >= 200 && status < 300) return true;
      if (!isObject(body)) return 'expected JSON error object';
      if (typeof body.error !== 'string' && typeof body.message !== 'string') return 'expected error/message string';
      if ('data' in body) return 'auth guard must not look like successful data';
      return true;
    },
  },
  {
    name: 'agent downline public route',
    path: '/api/agents/downline',
    okStatuses: [200, 503],
    validate: (body) => {
      if (Array.isArray(body)) return true;
      if (!isObject(body)) return 'expected JSON object';
      if (!('agents' in body || 'error' in body || 'message' in body)) return 'expected agents or structured unavailable response';
      return true;
    },
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStructuredAuthError(body: unknown): true | string {
  if (!isObject(body)) return 'expected JSON auth error object';
  if (typeof body.error !== 'string' && typeof body.message !== 'string') return 'expected auth error/message string';
  if ('data' in body) return 'auth response must not include data payload';
  return true;
}

async function fetchJson(testCase: BackendSmokeCase) {
  const response = await fetch(`${baseUrl}${testCase.path}`, {
    method: testCase.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(testCase.body ? { 'Content-Type': 'application/json' } : {}),
      ...testCase.headers,
    },
    body: testCase.body ? JSON.stringify(testCase.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

let failures = 0;
console.log(`Backend unified API smoke test: ${baseUrl}`);

for (const testCase of cases) {
  try {
    const { response, body } = await fetchJson(testCase);
    const okStatuses = testCase.okStatuses || [];
    const validStatus = (response.status >= 200 && response.status < 300) || okStatuses.includes(response.status);
    const validation = testCase.validate ? testCase.validate(body, response.status) : true;
    const validBody = validation === true;

    if (!validStatus || !validBody) {
      failures++;
      console.error(`FAIL ${testCase.name} ${testCase.path} status=${response.status}`);
      if (!validBody && typeof validation === 'string') console.error(validation);
      console.error(typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
      continue;
    }

    console.log(`PASS ${testCase.name} ${testCase.path}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${testCase.name} ${testCase.path}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failures > 0) {
  console.error(`Backend smoke test failed: ${failures}/${cases.length} checks failed`);
  process.exit(1);
}

console.log(`Backend smoke test passed: ${cases.length}/${cases.length} checks passed`);
