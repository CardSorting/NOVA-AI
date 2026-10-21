import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { NovaRequestQueue, type QueuedGenerationRequest, type QueuedHttpResponse } from '../src/pools/pool-request-queue.js';

test('NovaRequestQueue enqueues, processes via worker, handles idempotency, and drains cleanly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pool-queue-test-'));
  let processedCount = 0;

  const handler = async (req: QueuedGenerationRequest, _signal: AbortSignal): Promise<QueuedHttpResponse> => {
    processedCount++;
    return {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      },
      body: JSON.stringify({ message: 'Processed ' + req.requestKey, tokens: 42 }),
      encoding: 'utf8'
    };
  };

  const queue = await NovaRequestQueue.open(directory, handler);
  await queue.startWorkers();
  assert.equal(queue.healthy, true);

  try {
    const requestKey = 'req_' + randomBytes(8).toString('hex');
    const req1: QueuedGenerationRequest = {
      pathname: '/v1/chat/completions',
      body: { model: 'gpt-4o', prompt: 'test queue' },
      delegated: 'auth_token',
      idempotencyKey: 'idem_1',
      requestKey: requestKey,
      owner: 'tenant_alpha',
      workload: 'text',
      fingerprint: 'fp_initial'
    };

    // 1. Enqueue and wait for completion
    const job = await queue.enqueue(req1);
    assert.ok(job.id);

    const result = await queue.waitForResult(job.id, () => true);
    assert.ok(result);
    assert.equal(result.status, 200);
    assert.match(result.body, /Processed req_/);
    assert.equal(processedCount, 1);

    // 2. Re-enqueue with identical fingerprint returns existing completed job without re-executing
    const jobRepeat = await queue.enqueue(req1);
    assert.equal(jobRepeat.id, job.id);
    assert.equal(processedCount, 1);

    // 3. Re-enqueue with differing fingerprint throws idempotency conflict
    const conflictingReq: QueuedGenerationRequest = {
      ...req1,
      fingerprint: 'fp_differing'
    };
    await assert.rejects(
      queue.enqueue(conflictingReq),
      (err: any) => err.code === 'idempotency_conflict'
    );
  } finally {
    await queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});
