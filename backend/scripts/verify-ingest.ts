const { Database } = require('bun:sqlite');
const db = new Database('./data/terminal.db');

const topAgents = db.query("SELECT login, level, agent_type, seq_number FROM agents WHERE provider = 'buckeye' ORDER BY seq_number LIMIT 5").all();
console.log('Sample agents:');
for (const a of topAgents) console.log('  ', a.login, '| L' + a.level, '|', a.agent_type, '| seq=' + a.seq_number);

const topPlayers = db.query("SELECT id, login, agent_login FROM players WHERE provider = 'buckeye' LIMIT 5").all();
console.log('\nSample players:');
for (const p of topPlayers) console.log('  ', p.id, '|', p.login, '| agent=', p.agent_login);

const levels = db.query("SELECT level, COUNT(*) as c FROM agents WHERE provider = 'buckeye' GROUP BY level ORDER BY level").all();
console.log('\nAgent levels:');
for (const l of levels) console.log('  Level', l.level + ':', l.c);

const agentTypes = db.query("SELECT agent_type, COUNT(*) as c FROM agents WHERE provider = 'buckeye' GROUP BY agent_type").all();
console.log('\nAgent types:');
for (const t of agentTypes) console.log('  ' + t.agent_type + ':', t.c);

const orphanPlayers = db.query("SELECT COUNT(*) as c FROM players WHERE provider = 'buckeye' AND agent_login NOT IN (SELECT login FROM agents WHERE provider = 'buckeye')").get();
console.log('\nPlayers without matching agent:', orphanPlayers.c);

db.close();
