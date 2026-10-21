#!/usr/bin/env node
/**
 * NOVA CLI: Unified runner for NOVA Relay and NOVA Resource Pool
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
  console.log(`
NOVA: Autonomous Inference Relay & Resource Routing Substrate

Usage:
  nova <command> [options]

Commands:
  relay     Start the NOVA inference relay server (OpenAI-compatible gateway)
  pool      Start the NOVA multi-worker pool coordinator runtime
  migrate   Run distilled schema migrations and seeds against local PostgreSQL

Options:
  --help, -h  Show this help message

Examples:
  nova relay --port 3001 --api-key secret
  nova pool --port 3000 --inference-key secret
  nova migrate --seed
`);
}

if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === 'relay') {
  const relayScript = path.join(__dirname, 'relay.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', relayScript, ...args.slice(1)], {
    stdio: 'inherit'
  });
  child.on('exit', code => process.exit(code ?? 0));
} else if (command === 'pool') {
  const poolScript = path.join(__dirname, 'pool.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', poolScript, ...args.slice(1)], {
    stdio: 'inherit'
  });
  child.on('exit', code => process.exit(code ?? 0));
} else if (command === 'migrate' || command === 'db:migrate') {
  const migrateScript = path.join(__dirname, 'migrate.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', migrateScript, ...args.slice(1)], {
    stdio: 'inherit'
  });
  child.on('exit', code => process.exit(code ?? 0));
} else {
  console.error(`Unknown NOVA command: "${command}"\nRun "nova --help" for available commands.`);
  process.exit(1);
}
