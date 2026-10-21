#!/usr/bin/env node
import { GalxaiRelayServer } from '../src/relay/relay-server.js';
import { randomBytes } from 'node:crypto';

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Inference Relay Server CLI

Usage:
  node bin/relay.ts [options]

Options:
  --port <port>          Port to listen on (default: 3001 or $PORT)
  --host <host>          Host to bind on (default: 127.0.0.1 or $HOST)
  --api-key <key>        Inference API key (default: $RELAY_API_KEY or auto-generated)
  --admin-key <key>      Admin API key (default: $RELAY_ADMIN_KEY or auto-generated)
  --ws-endpoint <url>    Upstream WebSocket endpoint
  --help, -h             Show this help message
`);
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        options[key] = next;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }

  const port = Number(options.port || process.env.PORT || 3001);
  const host = options.host || process.env.HOST || '127.0.0.1';
  const apiKey = options['api-key'] || process.env.RELAY_API_KEY || `key_live_${randomBytes(24).toString('hex')}`;
  const adminKey = options['admin-key'] || process.env.RELAY_ADMIN_KEY || `key_admin_${randomBytes(24).toString('hex')}`;
  const wsEndpoint = options['ws-endpoint'] || process.env.WS_ENDPOINT;

  return { port, host, apiKey, adminKey, wsEndpoint };
}

async function main() {
  const { port, host, apiKey, adminKey, wsEndpoint } = parseArgs();

  console.log('======================================================================');
  console.log('   🚀 INFERENCE RELAY SERVER');
  console.log('======================================================================');
  console.log(`  Host:        ${host}`);
  console.log(`  Port:        ${port}`);
  console.log(`  API Key:     ${apiKey}`);
  console.log(`  Admin Key:   ${adminKey}`);
  if (wsEndpoint) {
    console.log(`  Upstream WS: ${wsEndpoint}`);
  }
  console.log('----------------------------------------------------------------------\n');

  const server = new GalxaiRelayServer({
    host,
    port,
    apiKeys: [apiKey],
    adminApiKeys: [adminKey],
    wsEndpoint,
    discoverHostCredentials: false,
    registryEnabled: false
  });

  const shutdown = async () => {
    console.log('\n[Relay] Shutting down gracefully...');
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await server.start();
  console.log(`[Relay] Ready and listening on http://${host}:${server.listeningPort()}\n`);
}

main().catch(err => {
  console.error('[Relay] Fatal error:', err);
  process.exit(1);
});
