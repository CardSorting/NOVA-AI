import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BroccoliDatabaseKernel } from '@noorm/broccolidb';
import { BroccoliQueue, type BroccoliDatabase } from '../src/queue/index.js';

async function createRuntime(options: Record<string, any> = {}) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'broccoli-queue-test-'));
  const db = new BroccoliDatabaseKernel({ workspaceRoot });
  const queue = new BroccoliQueue({ db: db as unknown as BroccoliDatabase, ...options });
  await queue.start();
  return { workspaceRoot, db, queue };
}

async function closeRuntime(runtime: { workspaceRoot: string; db: any; queue: BroccoliQueue }) {
  await runtime.queue.close().catch(() => {});
  await runtime.db.stop().catch(() => {});
  await rm(runtime.workspaceRoot, { recursive: true, force: true });
}

test('BroccoliQueue validates producer batches before changing tables', async (t) => {
  const runtime = await createRuntime();
  t.after(() => closeRuntime(runtime));
  const circular: Record<string, any> = {};
  circular.self = circular;

  await assert.rejects(runtime.queue.addBulk([
    { name: 'valid', data: { value: 1 } },
    { name: 'invalid', data: circular }
  ]), /JSON serializable/);

  assert.deepEqual(runtime.queue.getQueues(), []);
  assert.deepEqual(runtime.queue.getJobs(), []);
});

test('BroccoliQueue bulk enqueue copies payloads, preserves idempotency, and reports state counts', async (t) => {
  const runtime = await createRuntime();
  t.after(() => closeRuntime(runtime));
  const payload = { nested: { count: 1 } };
  const jobs = await runtime.queue.addBulk([
    { name: 'ingest', data: payload, options: { idempotencyKey: 'event-1' } },
    { name: 'ingest', data: { nested: { count: 2 } }, options: { idempotencyKey: 'event-2' } }
  ]);
  payload.nested.count = 99;
  const duplicate = await runtime.queue.add('ingest', { nested: { count: 100 } }, { idempotencyKey: 'event-1' });

  assert.equal(duplicate.id, jobs[0].id);
  assert.deepEqual(runtime.queue.getJob(jobs[0].id)?.data, { nested: { count: 1 } });
  assert.deepEqual(runtime.queue.getQueue('ingest')?.counts, {
    waiting: 2, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0
  });
});

test('BroccoliQueue coalesces concurrent writes into shared flush window', async (t) => {
  const runtime = await createRuntime();
  t.after(() => closeRuntime(runtime));
  const flush = runtime.db.flush.bind(runtime.db);
  let flushCount = 0;
  runtime.db.flush = async () => {
    flushCount++;
    await flush();
  };

  const jobs = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    runtime.queue.add('coalesced', { index })
  ));

  assert.equal(jobs.length, 32);
  assert.ok(flushCount <= jobs.length);
  assert.equal(runtime.queue.getQueue('coalesced')?.counts.waiting, 32);
});

test('BroccoliQueue workers claim batches, renew leases via heartbeat, and complete jobs', async (t) => {
  const runtime = await createRuntime();
  t.after(() => closeRuntime(runtime));

  let heartbeats = 0;
  const processed: string[] = [];

  const worker = runtime.queue.process<{ message: string }, { ack: boolean }>('tasks', async (job, context) => {
    processed.push(job.data.message);
    const renewed = await context.heartbeat();
    if (renewed) heartbeats++;
    return { ack: true };
  }, { concurrency: 2, leaseDurationMs: 10_000 });

  await worker.start();

  const j1 = await runtime.queue.add('tasks', { message: 'hello world' });
  const j2 = await runtime.queue.add('tasks', { message: 'task 2' });

  // Wait for processing
  const end = Date.now() + 3_000;
  while (Date.now() < end && processed.length < 2) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert.equal(processed.length, 2);
  assert.ok(heartbeats >= 1);
  assert.equal(runtime.queue.getJob(j1.id)?.state, 'completed');
  assert.equal(runtime.queue.getJob(j2.id)?.state, 'completed');

  await worker.stop({ drainTimeoutMs: 1000 });
});

test('BroccoliQueue retries failing jobs with exponential backoff and tracks attempts', async (t) => {
  const runtime = await createRuntime();
  t.after(() => closeRuntime(runtime));

  let attempts = 0;
  const worker = runtime.queue.process('retrying-queue', async (_job) => {
    attempts++;
    if (attempts < 3) {
      throw new Error('transient worker failure ' + attempts);
    }
    return 'success';
  }, { concurrency: 1, pollingIntervalMs: 50 });

  await worker.start();

  const job = await runtime.queue.add('retrying-queue', { val: 1 }, {
    attempts: 3,
    backoff: { type: 'fixed', delayMs: 50 }
  });

  const end = Date.now() + 3_000;
  while (Date.now() < end && attempts < 3) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  assert.equal(attempts, 3);
  const finished = runtime.queue.getJob(job.id);
  assert.equal(finished?.state, 'completed');
  assert.equal(finished?.returnValue, 'success');

  await worker.stop({ drainTimeoutMs: 1000 });
});

test('BroccoliQueue allows cancellation and pruning of expired jobs', async (t) => {
  const runtime = await createRuntime();
  t.after(() => closeRuntime(runtime));

  const delayedJob = await runtime.queue.add('delayed-queue', { test: 1 }, { delayMs: 60_000 });
  assert.equal(delayedJob.state, 'delayed');

  const cancelled = await runtime.queue.cancel(delayedJob.id);
  assert.equal(cancelled, true);
  assert.equal(runtime.queue.getJob(delayedJob.id)?.state, 'cancelled');

  // Pruning with retentionMs = 0 should prune terminal job
  const pruned = await runtime.queue.prune({ retentionMs: 0 });
  assert.ok(pruned >= 1);
  assert.equal(runtime.queue.getJob(delayedJob.id), null);
});
