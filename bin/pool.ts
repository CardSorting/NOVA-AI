#!/usr/bin/env node
import { PoolRuntime } from '../src/pools/pool-runtime.js';
import { PoolExecution, MemoryExecutionStore } from '../src/pools/pool-execution.js';
import { CentralClient, hash } from '../src/pools/pool-protocol.js';
import { randomBytes, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Inference Pool Runtime CLI

Usage:
  node bin/pool.ts [options]

Options:
  --port <port>          Port to listen on (default: 3000)
  --inference-key <key>  Inference API key
  --central-origin <url> Central coordinator origin (default: mock internal)
  --state-dir <path>     Directory for state & WAL queue (default: os temp dir)
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

  const port = Number(options.port || 3000);
  const inferenceKey = options['inference-key'] || hash('pool-inference-' + randomBytes(8).toString('hex'));
  const capabilityKey = hash('pool-capability-' + randomBytes(8).toString('hex'));
  const stateDir = options['state-dir'] || path.join(os.tmpdir(), `pool-state-${Date.now()}`);

  return { port, inferenceKey, capabilityKey, stateDir };
}

async function main() {
  const { port, inferenceKey, capabilityKey, stateDir } = parseArgs();

  console.log('======================================================================');
  console.log('   🌊 INFERENCE POOL RUNTIME');
  console.log('======================================================================');
  console.log(`  Port:            ${port}`);
  console.log(`  Inference Key:   ${inferenceKey}`);
  console.log(`  State Directory: ${stateDir}`);
  console.log('----------------------------------------------------------------------\n');

  const executionStore = new MemoryExecutionStore();
  const centralClient = new CentralClient('http://127.0.0.1:1', hash('runtime'), {
    pool: 'premium',
    installationId: randomUUID()
  });

  const execution = new PoolExecution(centralClient, executionStore);
  const runtime = new PoolRuntime(execution, inferenceKey, stateDir, capabilityKey);

  const shutdown = async () => {
    console.log('\n[Pool] Stopping runtime...');
    await runtime.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await runtime.start();
  console.log('[Pool] Runtime active and ready for work.\n');
}

main().catch(err => {
  console.error('[Pool] Fatal error:', err);
  process.exit(1);
});
