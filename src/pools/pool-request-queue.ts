import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { BroccoliDatabaseKernel } from '@noorm/broccolidb';
import { BroccoliQueue, type BroccoliDatabase, type Job, type WorkerHandle } from 'broccoli-queue';
import type { Workload } from './pool-protocol.js';

const NAMESPACE = 'galxrelay';
const TEXT_QUEUE = 'relay_text';
const IMAGE_QUEUE = 'relay_images';
const MAX_QUEUED_REQUESTS = 128;
const MAX_QUEUED_PER_OWNER = 8;
const MAX_WAITING_IMAGES = 32;
const RESULT_LIMIT = 64 * 1024 * 1024;
const TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const MAX_RETAINED_TERMINAL_JOBS = 4;
const COMPACTION_ACK_THRESHOLD = 8;
const COMPACTION_MUTATION_THRESHOLD = 128;
const COMPACTION_MAX_DELAY_MS = 30_000;
const MAX_QUEUE_WAIT_MS = 120_000;

export interface QueuedGenerationRequest {
  pathname: '/v1/chat/completions' | '/v1/images/generations';
  body: Record<string, any>;
  delegated: string;
  idempotencyKey: string;
  requestKey: string;
  owner: string;
  workload: Workload;
  deadlineAtEpochMs?: number;
  fingerprint: string;
}

export interface QueuedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  encoding: 'utf8' | 'base64';
}

export type QueueHandler = (request: QueuedGenerationRequest, signal: AbortSignal) => Promise<QueuedHttpResponse>;

type QueueJob = Job<QueuedGenerationRequest, QueuedHttpResponse>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function queueId(queueName: string, requestKey: string): string {
  // BroccoliQueue's documented idempotency behavior derives this stable ID
  // from its namespace, queue name, and idempotency key.
  return `idem_${digest(`${NAMESPACE}\0${queueName}\0${requestKey}`)}`;
}

function validResponse(value: unknown): value is QueuedHttpResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Partial<QueuedHttpResponse>;
  if (!Number.isInteger(response.status) || (response.status ?? 0) < 200 || (response.status ?? 0) > 599) return false;
  if (!response.headers || typeof response.headers !== 'object' || Array.isArray(response.headers)) return false;
  if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > RESULT_LIMIT) return false;
  if (response.encoding !== 'utf8' && response.encoding !== 'base64') return false;
  if (response.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.body) || response.body.length > RESULT_LIMIT)) return false;
  const allowedHeaders = new Set(['content-type', 'cache-control', 'x-content-type-options', 'referrer-policy', 'retry-after', 'x-should-retry']);
  for (const [name, header] of Object.entries(response.headers)) {
    if (!allowedHeaders.has(name) || typeof header !== 'string' || header.length > 256 || /[\r\n]/.test(header)) return false;
  }
  return true;
}

function sameRequest(job: QueueJob, request: QueuedGenerationRequest): boolean {
  return job.data?.fingerprint === request.fingerprint;
}

function queueErrorResponse(): QueuedHttpResponse {
  return {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-should-retry': 'false',
    },
    body: JSON.stringify({ error: { code: 'request_unavailable', message: 'Check the existing request before continuing.', execution_state: 'unknown' } }),
    encoding: 'utf8',
  };
}

function notAcceptedResponse(): QueuedHttpResponse {
  return {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'retry-after': '5',
      'x-should-retry': 'true',
    },
    body: JSON.stringify({ error: { code: 'service_busy', message: 'This service is busy. Try again shortly.', execution_state: 'not_accepted' } }),
    encoding: 'utf8',
  };
}

async function secureQueueWorkspace(stateDirectory: string): Promise<string> {
  const stateRoot = path.resolve(stateDirectory);
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const stateStat = await fs.lstat(stateRoot);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error('Relay state root is not a regular directory');

  const workspace = path.join(stateRoot, 'request-queue');
  try {
    await fs.mkdir(workspace, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const secureTree = async (directory: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Relay queue storage contains a non-directory path');
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
    for (const name of await fs.readdir(directory)) {
      const entry = path.join(directory, name);
      const entryStat = await fs.lstat(entry);
      if (entryStat.isSymbolicLink()) throw new Error('Relay queue storage cannot contain symbolic links');
      if (entryStat.isDirectory()) await secureTree(entry);
      else if (entryStat.isFile()) {
        if (process.platform !== 'win32') await fs.chmod(entry, 0o600);
      } else throw new Error('Relay queue storage contains an unsupported filesystem entry');
    }
  };
  await secureTree(workspace);
  return workspace;
}

export class PoolRequestQueue {
  private readonly queue: BroccoliQueue;
  private readonly database: BroccoliDatabaseKernel;
  private readonly workers: WorkerHandle[] = [];
  private readonly enqueueReservations = new Map<string, number>();
  private readonly pendingAcknowledgements = new Set<Promise<void>>();
  private totalEnqueueReservations = 0;
  private imageEnqueueReservations = 0;
  private closing = false;
  private accepting = true;
  private workersReady = false;
  private compaction?: Promise<void>;
  private compactionTimer?: NodeJS.Timeout;
  private compactionRequested = 0;
  private compactionCompleted = 0;
  private acknowledgementsRequested = 0;
  private acknowledgementsCompleted = 0;
  private closePromise?: Promise<void>;

  private constructor(database: BroccoliDatabaseKernel, queue: BroccoliQueue) {
    this.database = database;
    this.queue = queue;
  }

  static async open(stateDirectory: string, handler: QueueHandler): Promise<PoolRequestQueue> {
    const workspace = await secureQueueWorkspace(stateDirectory);
    const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace });
    const queue = new BroccoliQueue({
      db: database as unknown as BroccoliDatabase,
      namespace: NAMESPACE,
      retentionMs: TERMINAL_RETENTION_MS,
      maxTerminalJobs: MAX_RETAINED_TERMINAL_JOBS,
      maxJobDataBytes: 2 * 1024 * 1024,
      maxJobResultBytes: RESULT_LIMIT,
      maintenanceIntervalMs: 5_000,
    });
    queue.on('error', () => console.error('Relay request queue persistence or worker operation failed.'));
    const instance = new PoolRequestQueue(database, queue);
    for (const event of ['job', 'completed', 'failed', 'retrying', 'cancelled', 'removed', 'pruned', 'recovered']) {
      queue.on(event, () => instance.noteQueueMutation());
    }
    try {
      await queue.start();
      await queue.createQueue(TEXT_QUEUE);
      await queue.createQueue(IMAGE_QUEUE);
      const process = (name: string, concurrency: number): WorkerHandle => queue.process<QueuedGenerationRequest, QueuedHttpResponse>(name, async (job, context) => {
        const deadline = job.data.deadlineAtEpochMs;
        // A persisted waiting job may outlive its caller during a runtime
        // replacement. The original queue deadline is measured at claim time,
        // before provider work can begin, so recovery never dispatches stale work.
        if (deadline !== undefined && (job.processedAt ?? Date.now()) >= deadline) return notAcceptedResponse();
        return handler(job.data, context.signal);
      }, { concurrency, pollingIntervalMs: 250, leaseDurationMs: 90_000,
        workerId: name === TEXT_QUEUE ? 'relay-text' : 'relay-images' });
      instance.workers.push(
        process(TEXT_QUEUE, 8),
        process(IMAGE_QUEUE, 4),
      );
      await secureQueueWorkspace(stateDirectory);
      return instance;
    } catch (error) {
      await instance.close().catch(() => {});
      throw error;
    }
  }

  get healthy(): boolean {
    return !this.closing && this.accepting && this.workersReady && this.workers.length === 2
      && this.workers.every(worker => worker.isRunning) && this.queue.getHealth().status === 'healthy';
  }

  async startWorkers(): Promise<void> {
    if (this.closing) throw new Error('Queue is closing');
    if (this.workersReady) return;
    this.workers.forEach(worker => worker.pause());
    const started = await Promise.allSettled(this.workers.map(worker => worker.start()));
    const failures = started.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length || !this.workers.every(worker => worker.isRunning)) {
      const stopped = await Promise.allSettled(this.workers.map(worker => worker.stop({ drainTimeoutMs: 0 })));
      failures.push(...stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      throw new AggregateError(failures.length ? failures : [new Error('Queue workers did not start')], 'Relay queue worker startup failed');
    }
    this.workersReady = true;
    this.workers.forEach(worker => worker.resume());
  }

  beginDrain(): void {
    this.accepting = false;
  }

  private reserveCapacity(request: QueuedGenerationRequest): () => void {
    const queueName = request.workload === 'images' ? IMAGE_QUEUE : TEXT_QUEUE;
    const total = this.queue.getQueues().reduce((sum, item) => sum + item.counts.active + item.counts.waiting + item.counts.delayed, 0);
    const perOwner = this.queue.getJobs({ state: ['active', 'waiting', 'delayed'], limit: 500 })
      .filter(job => (job.data as unknown as QueuedGenerationRequest | null)?.owner === request.owner).length;
    const reservedForOwner = this.enqueueReservations.get(request.owner) ?? 0;
    const waitingImages = (this.queue.getQueue(IMAGE_QUEUE)?.counts.waiting ?? 0)
      + (this.queue.getQueue(IMAGE_QUEUE)?.counts.delayed ?? 0);
    if (total + this.totalEnqueueReservations >= MAX_QUEUED_REQUESTS || perOwner + reservedForOwner >= MAX_QUEUED_PER_OWNER
      || request.workload === 'images' && waitingImages + this.imageEnqueueReservations >= MAX_WAITING_IMAGES) {
      throw Object.assign(new Error('Queue capacity unavailable'), { code: 'queue_full' });
    }
    this.totalEnqueueReservations++;
    if (request.workload === 'images') this.imageEnqueueReservations++;
    this.enqueueReservations.set(request.owner, reservedForOwner + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.totalEnqueueReservations--;
      if (request.workload === 'images') this.imageEnqueueReservations--;
      const remaining = (this.enqueueReservations.get(request.owner) ?? 1) - 1;
      if (remaining) this.enqueueReservations.set(request.owner, remaining);
      else this.enqueueReservations.delete(request.owner);
    };
  }

  async enqueue(request: QueuedGenerationRequest): Promise<QueueJob> {
    if (this.closing || !this.accepting || !this.queue.isStarted) throw Object.assign(new Error('Queue unavailable'), { code: 'queue_unavailable' });
    const queueName = request.workload === 'images' ? IMAGE_QUEUE : TEXT_QUEUE;
    const id = queueId(queueName, request.requestKey);
    let existing = this.queue.getJob<QueuedGenerationRequest, QueuedHttpResponse>(id);
    if (existing && !sameRequest(existing, request)) throw Object.assign(new Error('Queue idempotency conflict'), { code: 'idempotency_conflict' });

    const shouldAdd = !existing || existing.state === 'failed' || existing.state === 'cancelled'
      || existing.state === 'completed' && existing.returnValue?.headers?.['x-should-retry'] === 'true';
    let releaseCapacity = shouldAdd ? this.reserveCapacity(request) : undefined;
    try {
      if (!existing) {
        const adding = this.queue.add<QueuedGenerationRequest>(queueName, request, {
          attempts: 1,
          idempotencyKey: request.requestKey,
        });
        releaseCapacity?.();releaseCapacity=undefined;
        existing = await adding as unknown as QueueJob;
      } else if (existing.state === 'failed' || existing.state === 'cancelled'
        || existing.state === 'completed' && existing.returnValue?.headers?.['x-should-retry'] === 'true') {
        await this.queue.delete(existing.id);
        const adding = this.queue.add<QueuedGenerationRequest>(queueName, request, {
          attempts: 1,
          idempotencyKey: request.requestKey,
        });
        releaseCapacity?.();releaseCapacity=undefined;
        existing = await adding as unknown as QueueJob;
      }
    } finally {
      releaseCapacity?.();
    }

    return existing;
  }

  async waitForResult(jobId: string, isConnected: () => boolean, cancelWaitingOnDisconnect = true): Promise<QueuedHttpResponse | undefined> {
    const initial = this.queue.getJob<QueuedGenerationRequest, QueuedHttpResponse>(jobId);
    const deadlineAtEpochMs = initial?.data.deadlineAtEpochMs ?? Date.now() + MAX_QUEUE_WAIT_MS;
    for (;;) {
      const job = this.queue.getJob<QueuedGenerationRequest, QueuedHttpResponse>(jobId);
      if (!job) return queueErrorResponse();
      if (!isConnected()) {
        if (cancelWaitingOnDisconnect && (job.state === 'waiting' || job.state === 'delayed')) await this.queue.cancelWaiting(job.id).catch(() => false);
        return undefined;
      }
      if (job.state === 'completed') return validResponse(job.returnValue) ? job.returnValue : queueErrorResponse();
      if (job.state === 'cancelled') return notAcceptedResponse();
      if (job.state === 'failed') return queueErrorResponse();
      if ((job.state === 'waiting' || job.state === 'delayed') && Date.now() >= deadlineAtEpochMs) {
        if (await this.queue.cancelWaiting(job.id).catch(() => false)) return notAcceptedResponse();
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private scheduleCompaction(delayMs: number): void {
    if (this.closing) return;
    if (this.compactionTimer && delayMs > 0) return;
    if (this.compactionTimer) clearTimeout(this.compactionTimer);
    this.compactionTimer = setTimeout(() => {
      this.compactionTimer = undefined;
      void this.compactPendingAcknowledgements();
    }, delayMs);
    this.compactionTimer.unref();
  }

  private noteQueueMutation(acknowledgement = false): void {
    if (acknowledgement) this.acknowledgementsRequested++;
    else this.compactionRequested++;
    const pendingMutations = this.compactionRequested - this.compactionCompleted;
    const pendingAcknowledgements = this.acknowledgementsRequested - this.acknowledgementsCompleted;
    if (pendingAcknowledgements >= COMPACTION_ACK_THRESHOLD || pendingMutations >= COMPACTION_MUTATION_THRESHOLD) {
      this.scheduleCompaction(0);
    } else if (!this.compactionTimer) this.scheduleCompaction(COMPACTION_MAX_DELAY_MS);
  }

  private async compactPendingAcknowledgements(): Promise<void> {
    if (this.closing || this.compactionRequested <= this.compactionCompleted) return;
    if (this.compaction) {
      await this.compaction;
      if (this.compactionRequested > this.compactionCompleted) this.scheduleCompaction(1_000);
      return;
    }
    const through = this.compactionRequested;
    const acknowledgementThrough = this.acknowledgementsRequested;
    const operation = this.database.compact().then(compacted => {
      if (compacted) {
        this.compactionCompleted = Math.max(this.compactionCompleted, through);
        this.acknowledgementsCompleted = Math.max(this.acknowledgementsCompleted, acknowledgementThrough);
      }
      else this.scheduleCompaction(1_000);
    }).catch(() => {
      console.error('Relay request queue compaction did not complete.');
      this.scheduleCompaction(5_000);
    }).finally(() => {
      this.compaction = undefined;
      if (this.compactionRequested > this.compactionCompleted && !this.compactionTimer) this.scheduleCompaction(1_000);
    });
    this.compaction = operation;
    await operation;
  }

  acknowledge(jobId: string): void {
    const operation = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (!await this.queue.delete(jobId)) return;
      this.noteQueueMutation(true);
    }).catch(() => {
      console.error('Relay request queue cleanup did not complete.');
    });
    this.pendingAcknowledgements.add(operation);
    void operation.finally(() => this.pendingAcknowledgements.delete(operation));
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.beginDrain();
    if (this.compactionTimer) clearTimeout(this.compactionTimer);
    this.compactionTimer = undefined;
    const operation = (async () => {
      const failures: unknown[] = [];
      const acknowledgements = await Promise.allSettled([...this.pendingAcknowledgements]);
      failures.push(...acknowledgements.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      const workers = await Promise.allSettled(this.workers.map(worker => worker.stop({ drainTimeoutMs: 330_000 })));
      failures.push(...workers.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      const queue = await Promise.allSettled([this.queue.close({ drainTimeoutMs: 0 })]);
      failures.push(...queue.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      const compaction = this.compaction ? await Promise.allSettled([this.compaction]) : [];
      failures.push(...compaction.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      const database = await Promise.allSettled([this.database.stop()]);
      failures.push(...database.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      if (failures.length) throw new AggregateError(failures, 'Relay request queue shutdown failed');
    })();
    this.closePromise = operation;
    await operation;
  }
}

export const NovaRequestQueue = PoolRequestQueue;
export type NovaRequestQueue = PoolRequestQueue;
