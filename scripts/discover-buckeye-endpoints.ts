import { BuckeyeAPI } from '../backend/src/scrapers/BuckeyeAPI';
import { BunSecretVault } from '../backend/src/services/BunSecretVault';

async function runDiscovery() {
  console.log('--- Phase 1: Credential Retrieval & Session Init ---');

  const vault = new BunSecretVault();
  const secrets = await vault.getBuckeyeSecrets();

  if (!secrets || !secrets.agentId || !secrets.password) {
    console.error('Error: Missing required credentials in Bun.secrets');
    process.exit(1);
  }

  console.log(`Found credentials for agent: ${secrets.agentId}`);

  const client = new BuckeyeAPI({
    agentId: secrets.agentId,
    password: secrets.password,
    cfCookie: secrets.cfCookie,
    token: secrets.token
  }, true); // debugMode = true

  try {
    console.log('Authenticating with Buckeye...');
    const success = await client.login();
    if (!success) {
      throw new Error('Login failed');
    }
    console.log('Session initialized successfully. Token:', client.token);

    console.log('\n--- Phase 2: Testing New Endpoints ---');
    const newEndpoints = [
      'Manager/getAccountInfoOwner',
      'Manager/getPlayers',
      'Manager/getHeriarchy',
      'Manager/getSportsType'
    ];

    for (const endpoint of newEndpoints) {
      console.log(`Probing ${endpoint}...`);
      try {
        const body = new URLSearchParams({
          agentID: client.getAgentId(),
          operation: endpoint.split('/')[1],
          RRO: '1',
          agentOwner: client.getAgentId(),
          agentSite: '1',
          // Add common parameters that might be required
          customerID: '12345', // Example customer ID
        });

        const response = await fetch(`${client.getBaseUrl()}/cloud/api/${endpoint}`, {
          method: 'POST',
          headers: client.buildHeaders({ contentType: 'application/x-www-form-urlencoded' }),
          body,
        });

        const data = await response.json();
        console.log(`Response from ${endpoint} (Status ${response.status}):`, JSON.stringify(data, null, 2).substring(0, 500));
      } catch (err) {
        console.error(`Failed to probe ${endpoint}:`, err);
      }
    }
  } catch (err) {
    console.error('Authentication failed:', err);
    process.exit(1);
  }
}

runDiscovery().catch(console.error);
