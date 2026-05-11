const js = await Bun.file('buckeye-manager.js').text();

// Search for cloud/api patterns
const cloudMatches = new Set(Array.from(js.matchAll(/cloud\/api\/[^\s"'\)]+/g)).map(m => m[0]));
console.log('=== CLOUD/API PATTERNS ===');
Array.from(cloudMatches).sort().forEach(e => console.log('  ' + e));

// Search for Manager/ patterns  
const managerMatches = new Set(Array.from(js.matchAll(/Manager\/[^\s"'\)]+/g)).map(m => m[0]));
console.log('\n=== MANAGER/ PATTERNS ===');
Array.from(managerMatches).sort().forEach(e => console.log('  ' + e));

// Search for set/update operations
const writeMatches = new Set(Array.from(js.matchAll(/(set|update|save|change|delete|remove)[A-Z][a-zA-Z]*/g)).map(m => m[0]));
console.log('\n=== WRITE OPERATIONS ===');
Array.from(writeMatches).sort().forEach(e => console.log('  ' + e));

// Search for PlayerID patterns
const playerMatches = Array.from(js.matchAll(/PlayerID[^\n]{0,100}/g)).map(m => m[0]).slice(0, 20);
console.log('\n=== PLAYERID CONTEXT ===');
playerMatches.forEach(e => console.log('  ' + e.replace(/\s+/g, ' ').slice(0, 120)));
