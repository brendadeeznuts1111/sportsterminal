import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('📝 BACKFILLING PLAYER NOTES + LINKS + SOURCE FRESHNESS');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── PLAYER NOTES ───────────────────────────────────────────────────────
  console.log('Step 1: Player Notes from violations/flags');
  let notesInserted = 0;

  // Note for each customer with violations
  const violationCustomers = await db.all<{ customer_id: string; count: number; types: string }>(
    `SELECT customer_id, COUNT(*) as count, GROUP_CONCAT(DISTINCT violation_type) as types
     FROM wager_violations GROUP BY customer_id`
  );
  for (const v of violationCustomers) {
    try {
      await db.run(
        `INSERT INTO player_notes (customer_id, note_type, body, created_by)
         VALUES (?, 'risk', ?, 'system-backfill')`,
        [v.customer_id, `Auto-detected ${v.count} violations: ${v.types}. Review required.`]
      );
      notesInserted++;
    } catch { /* skip */ }
  }

  // Note for each flagged customer
  const flaggedCustomers = await db.all<{ customer_id: string; flag_type: string; label: string }>(
    `SELECT customer_id, flag_type, label FROM player_flags`
  );
  for (const f of flaggedCustomers) {
    try {
      await db.run(
        `INSERT INTO player_notes (customer_id, note_type, body, created_by)
         VALUES (?, 'flag', ?, 'system-backfill')`,
        [f.customer_id, `Flag: ${f.label} (${f.flag_type}).`]
      );
      notesInserted++;
    } catch { /* skip */ }
  }
  console.log(`   Inserted ${notesInserted} notes`);

  // ─── PLAYER LINKS ───────────────────────────────────────────────────────
  console.log('\nStep 2: Player Links from shared agents');
  let linksInserted = 0;

  // Link customers who share the same agent_login (potential syndicate)
  const sharedAgents = await db.all<{ agent_login: string; customers: string }>(
    `SELECT agent_login, GROUP_CONCAT(DISTINCT customer_id) as customers
     FROM wagers WHERE agent_login IS NOT NULL AND agent_login <> ''
     GROUP BY agent_login HAVING COUNT(DISTINCT customer_id) >= 2`
  );

  for (const sa of sharedAgents) {
    const ids = sa.customers.split(',');
    // Create pairwise links (limit to first 10 customers per agent to avoid explosion)
    const limited = ids.slice(0, 10);
    for (let i = 0; i < limited.length; i++) {
      for (let j = i + 1; j < limited.length; j++) {
        try {
          await db.run(
            `INSERT INTO player_links (player_a, player_b, confidence, reason, detected_at, status)
             VALUES (?, ?, 0.6, ?, datetime('now'), 'active')`,
            [limited[i], limited[j], `Shared agent: ${sa.agent_login}`]
          );
          linksInserted++;
        } catch { /* skip */ }
      }
    }
  }
  console.log(`   Inserted ${linksInserted} links`);

  // ─── SOURCE FRESHNESS ───────────────────────────────────────────────────
  console.log('\nStep 3: Source Freshness watermark');
  let freshnessInserted = 0;

  const sources = [
    { name: 'wagers', table: 'wagers', dateCol: 'scraped_at' },
    { name: 'customer_features', table: 'customer_features', dateCol: 'extracted_at' },
    { name: 'wager_violations', table: 'wager_violations', dateCol: 'detected_at' },
    { name: 'risk_positions', table: 'risk_positions', dateCol: 'created_at' },
    { name: 'player_flags', table: 'player_flags', dateCol: 'created_at' },
  ];

  for (const src of sources) {
    try {
      const row = await db.get<{ count: number; latest: string }>(
        `SELECT COUNT(*) as count, MAX(${src.dateCol}) as latest FROM ${src.table}`
      );
      if (row && row.count > 0) {
        await db.run(
          `INSERT INTO source_freshness (source, last_pull, row_count, checksum, metadata)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET
             last_pull = excluded.last_pull, row_count = excluded.row_count,
             checksum = excluded.checksum, metadata = excluded.metadata`,
          [src.name, row.latest, row.count, `${src.name}:${row.count}`, JSON.stringify({ backfilled: true })]
        );
        freshnessInserted++;
      }
    } catch { /* skip */ }
  }
  console.log(`   Inserted/updated ${freshnessInserted} freshness records`);

  // Summary
  const n = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM player_notes');
  const l = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM player_links');
  const s = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM source_freshness');
  console.log('\n═══════════════════════════════════════════════════');
  console.log('✅ DONE');
  console.log(`   player_notes:      ${n?.c || 0}`);
  console.log(`   player_links:      ${l?.c || 0}`);
  console.log(`   source_freshness:  ${s?.c || 0}`);
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
