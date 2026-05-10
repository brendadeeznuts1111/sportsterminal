interface SmokeCase {
  name: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  okStatuses?: number[];
  validate?: (body: unknown) => true | string;
}

const baseUrl = (Bun.env.PROXY_SMOKE_URL || `http://localhost:${Bun.env.PROXY_PORT || "3001"}`).replace(/\/$/, "");
const apiKey = Bun.env.PROXY_API_KEY || "dev-key-123";
const demoModeRequested = Bun.env.DEMO_MODE === "true" || Bun.env.ENABLE_DEMO_MODE === "true";

const jsonHeaders = {
  "Accept": "application/json",
};

const cases: SmokeCase[] = [
  {
    name: "root service info",
    path: "/",
    validate: (body) => isObject(body) && typeof body.service === "string",
  },
  {
    name: "liveness ping",
    path: "/ping",
    headers: { Accept: "text/plain" },
    validate: (body) => body === "pong" ? true : "expected pong",
  },
  {
    name: "feature flags",
    path: "/features",
    validate: (body) => isObject(body) && isObject(body.features),
  },
  {
    name: "demo status",
    path: "/demo/status",
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (typeof body.demoMode !== "boolean") return "demoMode must be boolean";
      if (!isStringArray(body.mockedEndpoints)) return "mockedEndpoints must be string[]";
      if (!body.mockedEndpoints.includes("pending")) return "demo status must list pending mock";
      return true;
    },
  },
  {
    name: "runtime metrics",
    path: "/metrics",
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (!isObject(body.memory)) return "metrics.memory missing";
      if (typeof body.uptime !== "number") return "metrics.uptime must be numeric";
      if (!isObject(body.server)) return "metrics.server missing";
      if (typeof body.server.pendingRequests !== "number") return "metrics.server.pendingRequests must be numeric";
      if (typeof body.server.pendingWebSockets !== "number") return "metrics.server.pendingWebSockets must be numeric";
      if (!isObject(body.heap)) return "metrics.heap missing";
      return true;
    },
  },
  {
    name: "prometheus metrics",
    path: "/metrics/prometheus",
    headers: { Accept: "text/plain" },
    validate: (body) => {
      if (typeof body !== "string") return "expected Prometheus text body";
      if (!body.includes("# HELP buckeye_requests_total")) return "missing request counter help";
      if (!body.includes("buckeye_active_websockets")) return "missing websocket gauge";
      return true;
    },
  },
  {
    name: "admin requires auth",
    path: "/admin",
    okStatuses: [401],
    validate: (body) => isObject(body) && typeof body.error === "string",
  },
  {
    name: "admin html authorized",
    path: `/admin?api_key=${encodeURIComponent(apiKey)}`,
    validate: (body) => typeof body === "string" && body.includes("Buckeye Proxy Admin")
      ? true
      : "expected admin HTML",
  },
  {
    name: "admin summary api",
    path: "/api/proxy/admin/summary",
    headers: { "X-Admin-Key": apiKey },
    validate: (body) => isObject(body) && typeof body.generatedAt === "string" && isObject(body.metrics),
  },
  {
    name: "admin config redacts secrets",
    path: "/api/proxy/admin/config",
    headers: { "X-Admin-Key": apiKey },
    validate: (body) => {
      if (!isObject(body) || !isObject(body.config)) return "expected config wrapper";
      if (body.config.apiKey !== "[redacted]") return "apiKey must be redacted";
      return true;
    },
  },
  {
    name: "admin logs api",
    path: "/api/proxy/admin/logs?limit=5",
    headers: { "X-Admin-Key": apiKey },
    validate: (body) => isObject(body) && typeof body.count === "number" && Array.isArray(body.logs),
  },
  {
    name: "admin rate limit overrides",
    path: "/admin/rate-limit",
    headers: { "X-Admin-Key": apiKey },
    validate: (body) => isObject(body) && Array.isArray(body.overrides),
  },
  {
    name: "openapi document",
    path: "/openapi.json",
    validate: validateOpenApiContract,
  },
  {
    name: "endpoint catalog",
    path: "/api/proxy/endpoints",
    headers: { "X-API-Key": apiKey },
    validate: validateEndpointCatalogContract,
  },
  {
    name: "token status",
    path: "/api/proxy/tokens?customerID=BILLY666",
    okStatuses: [200, 404],
    validate: (body) => isObject(body) && typeof body.found === "boolean",
  },
  {
    name: "proxy health",
    path: "/api/proxy/health",
    okStatuses: [200, 503],
    validate: (body) => isObject(body) && typeof body.database === "boolean",
  },
  {
    name: "taxonomy auth guard",
    path: "/api/proxy/taxonomy/sports",
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: { customerID: "BILLY666" },
    okStatuses: [200, 400, 401, 502],
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (!("data" in body || "error" in body)) return "expected data or structured error";
      if ("error" in body && typeof body.error !== "string") return "structured error must be a string";
      return true;
    },
  },
  {
    name: "leagueLines required params",
    path: "/api/proxy/leagueLines",
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: {
      token: "smoke-token",
      cf_clearance: "smoke-clearance",
      league: "NFL",
    },
    okStatuses: [400],
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (typeof body.error !== "string") return "expected missing-parameter error";
      if (!body.error.includes("sport")) return "leagueLines missing-param error must mention sport";
      if ("data" in body) return "required-param response must not include data payload";
      return true;
    },
  },
  {
    name: "pending params auth guard",
    path: "/api/proxy/pending",
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: {
      agentID: "BILLY666",
      date: "2026-05-10",
      wagerType: "S",
      week: "3",
      customerID: "0",
      agentOwner: "BILLY666",
      agentSite: "1",
    },
    okStatuses: demoModeRequested ? [200] : [400],
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (demoModeRequested) {
        if (body.source !== "demo") return "DEMO_MODE pending should return demo source";
        if (!isObject(body.data)) return "DEMO_MODE pending should return data object";
        return true;
      }
      if (typeof body.error !== "string") return "expected error string";
      if ("data" in body) return "auth guard response must not include data payload";
      return true;
    },
  },
  {
    name: "report config params auth guard",
    path: "/api/proxy/updatePendingReportConfig",
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: {
      agentID: "SMOKE_NO_STORED_TOKEN",
      agent: "on",
      customerID: "on",
      password: "off",
      name: "on",
      timeAccepted: "on",
      timeScheduled: "on",
      type: "on",
      print: "on",
      delete: "off",
      custTotal: "off",
      agentOwner: "BILLY666",
      agentSite: "1",
    },
    okStatuses: [400],
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (typeof body.error !== "string") return "expected error string";
      if ("data" in body) return "auth guard response must not include data payload";
      return true;
    },
  },
];

if (demoModeRequested) {
  cases.push({
    name: "demo mock bypasses Buckeye auth",
    path: "/api/proxy/accountInfo",
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: { customerID: "DEMO" },
    validate: (body) => {
      if (!isObject(body)) return "expected JSON object";
      if (body.source !== "demo") return "expected demo source when DEMO_MODE=true";
      if (!isObject(body.data)) return "expected demo data object";
      if ("error" in body) return "demo mock response must not be an auth error";
      return true;
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordOfString(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function validateEndpointCatalogContract(body: unknown): true | string {
  if (!isObject(body)) return "catalog is not an object";
  if (!isRecordOfString(body.proxy)) return "catalog.proxy must be a path->description string map";
  if (!isRecordOfString(body.buckeye)) return "catalog.buckeye must be an endpoint->description string map";
  if (!isObject(body.endpointMap)) return "catalog.endpointMap missing";
  if (!isObject(body.aliases)) return "catalog.aliases missing";
  if (!isObject(body.taxonomy)) return "catalog.taxonomy missing";
  if (!isObject(body.counts)) return "catalog.counts missing";

  const proxyCount = Number(body.counts.proxy || 0);
  const buckeyeCount = Number(body.counts.buckeye || 0);
  if (proxyCount < 19) return `expected at least 19 proxy endpoints, saw ${proxyCount}`;
  if (buckeyeCount < 49) return `expected at least 49 Buckeye endpoints, saw ${buckeyeCount}`;

  const pendingMeta = body.endpointMap.pending;
  if (!isObject(pendingMeta)) return "endpointMap.pending missing";
  if (pendingMeta.path !== "/cloud/api/Manager/getPending") return "endpointMap.pending path changed";
  if (typeof pendingMeta.cacheTtl !== "number") return "endpointMap.pending.cacheTtl must be numeric metadata";
  if ("params" in pendingMeta || "data" in pendingMeta || "response_shape" in pendingMeta) {
    return "endpointMap entries must not mix request params or response data fields";
  }

  const aliasNames = [
    "sportsLeagues",
    "leagueLines",
    "agentDownline",
    "agentBilling",
    "playerInfo",
    "dynamicLive",
    "gameVolume",
    "pendingReportConfig",
    "updatePendingReportConfig",
  ];
  for (const aliasName of aliasNames) {
    const route = `/api/proxy/${aliasName}`;
    const alias = body.aliases[route];
    if (!isObject(alias)) return `alias ${route} missing`;
    if (alias.method !== "POST") return `alias ${route} must be POST`;
    if (!isObject(alias.params)) return `alias ${route}.params missing`;
    if (!isStringArray(alias.params.required)) return `alias ${route}.params.required must be string[]`;
    if (!isStringArray(alias.params.optional)) return `alias ${route}.params.optional must be string[]`;
    if (!isObject(alias.params.example)) return `alias ${route}.params.example missing`;
    if (!Array.isArray(alias.candidates) || alias.candidates.length === 0) return `alias ${route}.candidates missing`;
    if ("data" in alias.params || "response_shape" in alias.params) return `alias ${route}.params mixed with response data`;

    const required = new Set(alias.params.required);
    for (const name of alias.params.optional) {
      if (required.has(name)) return `alias ${route} has ${name} in required and optional`;
    }
    for (const name of alias.params.required) {
      if (!(name in alias.params.example)) return `alias ${route} example missing required param ${name}`;
    }
    for (const candidate of alias.candidates) {
      if (!isObject(candidate) || typeof candidate.endpoint !== "string" || typeof candidate.operation !== "string") {
        return `alias ${route} has malformed candidate`;
      }
      if ("data" in candidate || "params" in candidate) return `alias ${route} candidate mixed endpoint metadata with data/params`;
    }
  }

  const updateParams = (body.aliases["/api/proxy/updatePendingReportConfig"] as Record<string, unknown>).params as Record<string, unknown>;
  const updateOptional = updateParams.optional as string[];
  const updateExample = updateParams.example as Record<string, unknown>;
  if (!updateOptional.includes("customerID")) return "updatePendingReportConfig must document customerID column-toggle param";
  if (updateExample.customerID !== "on" && updateExample.customerID !== "off") {
    return "updatePendingReportConfig example customerID must be on/off column visibility, not player data";
  }

  const taxonomyLevels = ["sports", "leagues", "schedule", "lines", "periods", "gametypes"];
  for (const level of taxonomyLevels) {
    const route = `/api/proxy/taxonomy/${level}`;
    if (typeof body.taxonomy[route] !== "string") return `taxonomy route ${route} missing`;
  }

  return true;
}

function validateOpenApiContract(body: unknown): true | string {
  if (!isObject(body)) return "OpenAPI body is not an object";
  if (body.openapi !== "3.0.0") return "OpenAPI version must be 3.0.0";
  if (!isObject(body.paths)) return "OpenAPI paths missing";
  if (!isObject(body.paths["/ping"])) return "OpenAPI missing /ping";
  if (!isObject(body.paths["/demo/status"])) return "OpenAPI missing /demo/status";
  if (!isObject(body.paths["/metrics/prometheus"])) return "OpenAPI missing /metrics/prometheus";
  if (!isObject(body.paths["/admin"])) return "OpenAPI missing /admin";

  const proxyEndpoint = body.paths["/api/proxy/{endpoint}"];
  if (!isObject(proxyEndpoint) || !isObject(proxyEndpoint.post)) return "OpenAPI missing /api/proxy/{endpoint} POST";
  if (!Array.isArray(proxyEndpoint.post.parameters)) return "/api/proxy/{endpoint} must document path parameters separately";
  if (!isObject(proxyEndpoint.post.responses)) return "/api/proxy/{endpoint} must document responses separately";
  if ("data" in proxyEndpoint.post.parameters) return "OpenAPI parameters must not contain response data";

  const taxonomyEndpoint = body.paths["/api/proxy/taxonomy/{level}"];
  if (!isObject(taxonomyEndpoint) || !isObject(taxonomyEndpoint.post)) return "OpenAPI missing taxonomy POST";
  if (!Array.isArray(taxonomyEndpoint.post.parameters)) return "taxonomy endpoint must document path level as parameters";

  const pendingEndpoint = body.paths["/api/proxy/pending"];
  if (!isObject(pendingEndpoint) || !isObject(pendingEndpoint.post)) return "OpenAPI missing pending POST";
  if (!isObject(pendingEndpoint.post.requestBody)) return "pending POST must document request params in requestBody";
  if (!isObject(pendingEndpoint.post.responses)) return "pending POST must document responses separately";

  const updateEndpoint = body.paths["/api/proxy/updatePendingReportConfig"];
  if (!isObject(updateEndpoint) || !isObject(updateEndpoint.post)) return "OpenAPI missing updatePendingReportConfig POST";
  const description = String((updateEndpoint.post.requestBody as Record<string, unknown> | undefined)?.description || "");
  if (!description.includes("customerID")) return "updatePendingReportConfig OpenAPI requestBody must mention customerID toggle";

  return true;
}

async function fetchJson(testCase: SmokeCase) {
  const response = await fetch(`${baseUrl}${testCase.path}`, {
    method: testCase.method || "GET",
    headers: { ...jsonHeaders, ...(testCase.body ? { "Content-Type": "application/json" } : {}), ...testCase.headers },
    body: testCase.body ? JSON.stringify(testCase.body) : undefined,
    signal: AbortSignal.timeout(5000),
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
console.log(`Enhanced proxy smoke test: ${baseUrl}`);

for (const testCase of cases) {
  try {
    const { response, body } = await fetchJson(testCase);
    const okStatuses = testCase.okStatuses || [];
    const validStatus = response.status >= 200 && response.status < 300 || okStatuses.includes(response.status);
    const validation = testCase.validate ? testCase.validate(body) : true;
    const validBody = validation === true;
    if (!validStatus || !validBody) {
      failures++;
      console.error(`FAIL ${testCase.name} ${testCase.path} status=${response.status}`);
      if (!validBody && typeof validation === "string") console.error(validation);
      console.error(typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
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
  console.error(`Smoke test failed: ${failures}/${cases.length} checks failed`);
  process.exit(1);
}

console.log(`Smoke test passed: ${cases.length}/${cases.length} checks passed`);
