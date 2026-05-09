# Code Quality Checklist

Run these checks before handing off UI or wager/account metric changes:

```bash
rg --no-ignore --no-ignore-parent -n "onclick=.*\\$\\{|onclick=.*'\\$\\{|innerHTML\\s*\\+=" frontend/public/index.html frontend/public/js
rg --no-ignore --no-ignore-parent -n "lifetime_pnl|profit_loss|pnl|total_potential_payout|to_win_amount" backend/src frontend/public/index.html frontend/public/js
```

For dynamic HTML, keep external data out of inline JavaScript. Render escaped text and escaped attributes, then use `data-*` attributes with delegated event listeners for user actions.

For player/account metrics, do not label projected exposure as settled P/L. Use explicit projection names until graded win/loss data is ingested.

Before handing off architecture or ingestion changes, update the living docs:

```bash
git diff -- README.md docs/IMPLEMENTATION_TRACKER.md docs/BUCKEYE_BACKEND_SCOPE.md docs/DATA_DICTIONARY.md docs/ENTERPRISE_TAB_GOALS.md docs/AUDIT_ANALYTICS_ENGINE.md docs/PROJECT_ORGANIZATION.md docs/CHANGELOG.md docs/API_ENDPOINTS.md docs/CODE_QUALITY_CHECKLIST.md
```

Keep local raw Buckeye exports and downloaded tools ignored. They can contain sensitive customer/agent data and should not become source files.

## Audit & Analytics Verification

After making changes to the audit/analytics layer, run:

```bash
# Backend tests
cd backend && bun test

# Verify all analytics endpoints respond
Invoke-RestMethod http://localhost:3000/api/betting/velocity?minutes=10
Invoke-RestMethod http://localhost:3000/api/betting/live-vs-pre
Invoke-RestMethod http://localhost:3000/api/logs/access?limit=5
Invoke-RestMethod http://localhost:3000/api/master/history?limit=5
Invoke-RestMethod http://localhost:3000/api/performance/summary
Invoke-RestMethod http://localhost:3000/api/performance/details?agent=BILLY666&weeks=4

# Verify CSV exports return Content-Type: text/csv
Invoke-WebRequest http://localhost:3000/api/export/wagers | Select-Object -ExpandProperty ContentType
Invoke-WebRequest http://localhost:3000/api/export/access-logs | Select-Object -ExpandProperty ContentType
Invoke-WebRequest http://localhost:3000/api/export/performance | Select-Object -ExpandProperty ContentType

# Verify error handling
Invoke-WebRequest http://localhost:3000/api/performance/details | Select-Object -ExpandProperty Content
Invoke-WebRequest http://localhost:3000/api/nonexistent -ErrorAction SilentlyContinue | Select-Object -ExpandProperty StatusCode
```

## Error Recovery Verification

After making changes to pollers or error handling:

```bash
# Check health endpoint for error counts
Invoke-RestMethod http://localhost:3000/health | ConvertTo-Json

# Verify watermarks table is populated
cd backend && bun run -e "
  import {initDatabase} from './src/database';
  const db = await initDatabase();
  const rows = await db.all('SELECT * FROM watermarks');
  console.log(JSON.stringify(rows, null, 2));
  await db.close();
"

# Verify raw_api_logs table accepts inserts
cd backend && bun run -e "
  import {initDatabase} from './src/database';
  const db = await initDatabase();
  await db.run('INSERT INTO raw_api_logs (endpoint, response_json) VALUES (?, ?)', ['test', JSON.stringify({test: true})]);
  const row = await db.get('SELECT * FROM raw_api_logs ORDER BY id DESC LIMIT 1');
  console.log('Raw log inserted:', row.id, row.endpoint);
  await db.close();
"
```
