import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { PoolExecution, MemoryExecutionStore, type AssignedAccount } from '../src/pools/pool-execution.js';
import { CentralClient, hash } from '../src/pools/pool-protocol.js';
import { centralServer } from '../src/pools/pool-central.js';

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

const close = (server: http.Server) => new Promise<void>(resolve => {
  server.closeAllConnections();
  server.close(() => resolve());
});

test('PoolExecution with MemoryExecutionStore persists reservations, binds leases, and settles', async () => {
  const store = new MemoryExecutionStore();
  let settleCalls = 0;

  const mockCentral = new CentralClient('http://127.0.0.1:1', hash('runtime'), {
    pool: 'premium',
    installationId: randomUUID()
  }, (async (url: any) => {
    if (String(url).endsWith('/acquire')) {
      return Response.json({ leaseId: 'lease_123', fencingToken: 1, expiresAtMs: Date.now() + 30000 });
    }
    if (String(url).endsWith('/settle')) {
      settleCalls++;
      return Response.json({ success: true });
    }
    throw new Error('Unhandled mock endpoint: ' + url);
  }) as typeof fetch);

  let recoveryNow = 0;
  const execution = new PoolExecution(mockCentral, store, undefined, {
    now: () => recoveryNow,
    random: () => 0
  });

  const account: AssignedAccount = {
    id: 'shard_exec_1',
    revision: 1,
    assignmentRevision: 1,
    credentialRevision: hash('cred_1'),
    state: 'enabled',
    desktopId: randomUUID(),
    models: ['gpt-4o'],
    expiresAtMs: Date.now() + 600_000
  };

  const fakeReq = {
    url: '/v1/chat/completions',
    headers: { 'idempotency-key': 'idem_key_100' }
  } as any;

  // 1. Admit request
  const grant = await execution.policy(account).admit(
    fakeReq,
    { model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] },
    'tenant_alpha',
    'exec_1'
  );

  grant.assert();
  assert.equal(grant.signal.aborted, false);

  // 2. Complete execution and advance clock to trigger settlement sweep
  await grant.complete(true, 150);
  recoveryNow = 2000;
  await execution.settlePending();
  assert.equal(settleCalls, 1);

  // 3. Second identical request rejects due to completed idempotency
  await assert.rejects(
    execution.policy(account).admit(fakeReq, { model: 'gpt-4o' }, 'tenant_alpha', 'exec_repeat')
  );

  execution.stop();
});

test('Pool Central Server validates protocol routes and isolates caller roles', async () => {
  const tokens = Object.fromEntries(['runtime', 'operator', 'viewer'].map(role => [hash(hash(role)), role]));
  let actions: string[] = [];

  const server = centralServer({
    identitySecret: hash('identity_secret_minimum_32_bytes_long'),
    query: async (token, action, body) => {
      actions.push(action);
      const kind = tokens[token];
      if (!kind) throw new Error('Unrecognized token');
      if (action === 'authenticate') return { kind, pool: 'premium', installationId: 'inst_1' };
      if (action === 'status') return { pool: 'premium', accounts: [] };
      if (action === 'projection') {
        return {
          pool: 'premium',
          installationId: 'inst_1',
          epoch: body.epoch,
          executionAllowed: true,
          accounts: [{
            id: 'shard_proj',
            state: 'enabled',
            revision: 1,
            credentialRevision: hash('cred'),
            models: ['gpt-4o']
          }]
        };
      }
      throw new Error(`Unhandled action ${action}`);
    }
  });

  const origin = await listen(server);
  try {
    const call = (route: string, role: string, body: object = {}) =>
      fetch(`${origin}${route}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${hash(role)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

    // 1. Operator status succeeds
    const opRes = await call('/operator/status', 'operator');
    assert.equal(opRes.status, 200);

    // 2. Viewer cannot call operator mutation
    const viewerRes = await call('/operator/set_account', 'viewer');
    assert.equal(viewerRes.status, 403);

    // 3. Runtime projection succeeds
    const projRes = await call('/runtime/projection', 'runtime', { epoch: randomUUID() });
    assert.equal(projRes.status, 200);
    const projData = await projRes.json();
    assert.equal(projData.accounts[0].id, 'shard_proj');
  } finally {
    await close(server);
  }
});
