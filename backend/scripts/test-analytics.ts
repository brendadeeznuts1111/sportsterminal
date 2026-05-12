const { Database } = require('bun:sqlite');
const { AgentAnalyticsService } = require('../src/services/AgentAnalyticsService');

// Wrap bun:sqlite Database to match app Database interface
class DbAdapter {
  constructor(path) {
    this.db = new Database(path);
  }
  get(sql, params = []) {
    return this.db.query(sql).get(...params);
  }
  all(sql, params = []) {
    return this.db.query(sql).all(...params);
  }
  run(sql, params = []) {
    return this.db.query(sql).run(...params);
  }
  exec(sql) {
    return this.db.exec(sql);
  }
}

const db = new DbAdapter('./data/terminal.db');
const svc = new AgentAnalyticsService(db);
svc.getAnalytics().then((result) => {
  console.log('Summary:', JSON.stringify(result.summary, null, 2));
  console.log('By level count:', result.by_level.length);
  console.log('By type:', JSON.stringify(result.by_type, null, 2));
  console.log('Rate dist count:', result.rate_distribution.length);
  console.log('Orphan players:', result.orphan_players);
  console.log('Top agents:', result.top_agents_by_players.slice(0, 3));
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
