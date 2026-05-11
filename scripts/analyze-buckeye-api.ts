const BUNDLE_URL = 'https://fantasy402.com/app/manager/manager.js?bust=1.0.188';
const RAW_OUTPUT = 'buckeye-manager.js';
const ANALYSIS_OUTPUT = 'buckeye-bundle-analysis.json';

interface Analysis {
  fetchedAt: string;
  source: string;
  bundleSize: number;
  endpoints: string[];
  operations: string[];
  params: Array<[string, number]>;
  urls: string[];
  writeCandidates: {
    endpoints: string[];
    operations: string[];
    params: Array<[string, number]>;
  };
}

async function analyzeBundle(): Promise<void> {
  console.log('[Analyzer] Fetching Buckeye manager bundle...');

  const res = await fetch(BUNDLE_URL, {
    headers: {
      Accept: 'application/javascript,text/javascript,*/*;q=0.8',
      Referer: 'https://fantasy402.com/manager.html',
      'User-Agent': 'Mozilla/5.0 SportsTerminal/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch bundle: ${res.status} ${res.statusText}`);
  }

  const js = await res.text();
  await Bun.write(RAW_OUTPUT, js);
  console.log(`[Analyzer] Bundle size: ${(js.length / 1024).toFixed(1)}KB`);
  console.log(`[Analyzer] Raw bundle saved to ${RAW_OUTPUT}`);

  const endpoints = collectMatches(js, /["'](\/cloud\/api\/[^"']+)["']/g);
  const operations = collectMatches(js, /operation\s*:\s*["']([^"']+)["']/g);
  const ajaxUrls = collectMatches(js, /url\s*:\s*["']([^"']+)["']/g);
  const params = countMatches(js, /([A-Z][a-zA-Z0-9_]+)\s*:\s*["']?([^"'},\n]+)/g);

  const writeEndpointPattern = /(?:set|update|save|delete|remove|change|block|suspend|limit|credit|payout|status|profile|player)/i;
  const writeOperationPattern = /^(?:set|update|save|delete|remove|change|block|suspend)/i;
  const writeParamPattern = /(?:Limit|Exposure|Status|Suspend|Block|Credit|Payout|Max|PlayerID|CustomerID)/i;

  const analysis: Analysis = {
    fetchedAt: new Date().toISOString(),
    source: BUNDLE_URL,
    bundleSize: js.length,
    endpoints: [...endpoints].sort(),
    operations: [...operations].sort(),
    params: [...params.entries()].sort((a, b) => b[1] - a[1]),
    urls: [...ajaxUrls].sort(),
    writeCandidates: {
      endpoints: [...endpoints].filter((value) => writeEndpointPattern.test(value)).sort(),
      operations: [...operations].filter((value) => writeOperationPattern.test(value)).sort(),
      params: [...params.entries()].filter(([key]) => writeParamPattern.test(key)).sort((a, b) => b[1] - a[1]),
    },
  };

  printSection('API ENDPOINTS', analysis.endpoints);
  printSection('OPERATIONS', analysis.operations);
  printSection('COMMON PARAMS', analysis.params.slice(0, 40).map(([key, count]) => `${key} (${count}x)`));
  printSection('AJAX URLS', analysis.urls);
  printSection('WRITE CANDIDATE ENDPOINTS', analysis.writeCandidates.endpoints);
  printSection('WRITE CANDIDATE OPERATIONS', analysis.writeCandidates.operations);
  printSection(
    'WRITE CANDIDATE PARAMS',
    analysis.writeCandidates.params.slice(0, 40).map(([key, count]) => `${key} (${count}x)`)
  );

  await Bun.write(ANALYSIS_OUTPUT, JSON.stringify(analysis, null, 2));
  console.log(`\n[Analyzer] Saved analysis to ${ANALYSIS_OUTPUT}`);
}

function collectMatches(source: string, pattern: RegExp): Set<string> {
  const values = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    if (match[1]) values.add(match[1]);
  }
  return values;
}

function countMatches(source: string, pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of source.matchAll(pattern)) {
    const key = match[1];
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function printSection(title: string, rows: string[]): void {
  console.log(`\n=== ${title} ===`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const row of rows) console.log(`  ${row}`);
}

await analyzeBundle();
