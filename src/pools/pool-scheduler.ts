import { performance } from 'node:perf_hooks';

export const RECOVERY_INTERVAL_MS = 5000;
export const IMAGE_QUEUE_MAX_WAIT_MS = 120_000;
export const IMAGE_QUEUE_RECHECK_MS = 1000;
export const IMAGE_QUEUE_MAX_DEPTH = 32;
export const IMAGE_QUEUE_MAX_PER_OWNER = 8;

export type SchedulerQueueReason = 'full' | 'timeout' | 'cancelled';

export interface SchedulerReservation<T> {
  readonly candidate: T;
  readonly workload: string;
  release(): void;
}

/**
 * Internal admission outcome. This is deliberately not serialized into a
 * public response; the pool maps it to the small public busy/unavailable
 * contract after deciding whether the POST was forwarded.
 */
export class SchedulerQueueError extends Error {
  constructor(readonly reason: SchedulerQueueReason) {
    super(`scheduler_queue_${reason}`);
    this.name = 'SchedulerQueueError';
  }
}

interface QueueWaiter {
  readonly owner: string;
  readonly resolve: () => void;
  readonly reject: (error: SchedulerQueueError) => void;
  readonly signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  done: boolean;
}

interface WorkloadWaiters {
  readonly owners: Map<string, QueueWaiter[]>;
  /** Round-robin owner order preserves per-owner FIFO without head-of-line starvation. */
  readonly order: string[];
  /** A single bounded dispatch recheck covers capacity released outside this scheduler. */
  recheckMs?: number;
  recheckTimer?: NodeJS.Timeout;
}

/** Shared local dispatch ordering. Central leases remain the capacity authority. */
export class PoolScheduler {
  private readonly selected = new Map<string, true>();
  /** Capacity is workload-scoped: image slots cannot be consumed by text reservations. */
  private readonly forwarding = new Map<string, Map<string, Set<symbol>>>();
  private readonly waiters = new Map<string, WorkloadWaiters>();
  private nextRecoveryAt = -Infinity;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reserve<T extends { id: string; lastUsedAtMs: number; recovering?: boolean; availableSlots?: number }>(candidates: readonly T[], workload = 'default'): SchedulerReservation<T> | undefined {
    const now = this.now();
    const rank = new Map([...this.selected.keys()].map((id, index) => [id, index]));
    const historicalUse = (c: T) => Number.isSafeInteger(c.lastUsedAtMs) && c.lastUsedAtMs > 0 ? c.lastUsedAtMs : 0;
    const workloadForwarding = this.forwarding.get(workload);
    const candidate = candidates.filter(c => (workloadForwarding?.get(c.id)?.size ?? 0) < (c.availableSlots ?? 1) && (!c.recovering || now >= this.nextRecoveryAt))
      .sort((a, b) => {
        const ar = rank.get(a.id), br = rank.get(b.id);
        // Checkpoint timestamps seed only first use. Live rotation has no wall-clock dependency.
        if (ar === undefined && br === undefined) return historicalUse(a) - historicalUse(b) || a.id.localeCompare(b.id);
        if (ar === undefined) return -1;
        if (br === undefined) return 1;
        return ar - br;
      })[0];
    if (!candidate) return undefined;
    // One ordering across models: changing a capability subset must not reset a cursor.
    this.selected.delete(candidate.id); this.selected.set(candidate.id, true);
    const token = Symbol(), reservations = workloadForwarding?.get(candidate.id) ?? new Set<symbol>();
    const activeWorkloadForwarding = workloadForwarding ?? new Map<string, Set<symbol>>();
    reservations.add(token);
    activeWorkloadForwarding.set(candidate.id, reservations);
    this.forwarding.set(workload, activeWorkloadForwarding);
    // Recovery is real user work, never a timer-driven probe or an uncertain-request retry.
    if (candidate.recovering) this.nextRecoveryAt = now + RECOVERY_INTERVAL_MS;
    let released = false;
    return { candidate, workload, release: () => {
      if (released) return;
      released = true;
      reservations.delete(token);
      if (!reservations.size && activeWorkloadForwarding.get(candidate.id) === reservations) {
        activeWorkloadForwarding.delete(candidate.id);
        if (!activeWorkloadForwarding.size && this.forwarding.get(workload) === activeWorkloadForwarding) this.forwarding.delete(workload);
      }
      this.wakeOne(workload);
    } };
  }

  /**
   * Wait for a future reservation without touching a worker. This is the
   * in-process equivalent of a queue's dispatch lease: bounded, cancellable,
   * fair across owners, and never a retry of the generation itself.
   */
  waitForAvailability(
    workload: string,
    owner: string,
    options: { maxWaitMs?: number; maxQueueDepth?: number; maxOwnerDepth?: number; recheckMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!workload || !owner) throw new TypeError('workload and owner are required');
    const maxWaitMs = options.maxWaitMs ?? IMAGE_QUEUE_MAX_WAIT_MS;
    const maxQueueDepth = options.maxQueueDepth ?? IMAGE_QUEUE_MAX_DEPTH;
    const maxOwnerDepth = options.maxOwnerDepth ?? IMAGE_QUEUE_MAX_PER_OWNER;
    const recheckMs = options.recheckMs;
    if (![maxWaitMs, maxQueueDepth, maxOwnerDepth].every(Number.isSafeInteger) || maxWaitMs < 1 || maxQueueDepth < 1 || maxOwnerDepth < 1
      || (recheckMs !== undefined && (!Number.isSafeInteger(recheckMs) || recheckMs < 1))) {
      throw new RangeError('Invalid scheduler queue limits');
    }
    if (options.signal?.aborted) return Promise.reject(new SchedulerQueueError('cancelled'));

    const queue = this.waiters.get(workload) ?? { owners: new Map<string, QueueWaiter[]>(), order: [] };
    if (recheckMs !== undefined) queue.recheckMs = queue.recheckMs === undefined ? recheckMs : Math.min(queue.recheckMs, recheckMs);
    const ownerQueue = queue.owners.get(owner);
    const depth = [...queue.owners.values()].reduce((total, entries) => total + entries.length, 0);
    if (depth >= maxQueueDepth || (ownerQueue?.length ?? 0) >= maxOwnerDepth) {
      return Promise.reject(new SchedulerQueueError('full'));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = { owner, resolve, reject, signal: options.signal, done: false };
      const finish = (error?: SchedulerQueueError) => {
        if (waiter.done) return;
        waiter.done = true;
        this.cleanupWaiter(waiter);
        if (error) reject(error); else resolve();
      };
      const remove = () => this.removeWaiter(workload, waiter);
      waiter.onAbort = () => { remove(); finish(new SchedulerQueueError('cancelled')); };
      if (options.signal) options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      waiter.timer = setTimeout(() => { remove(); finish(new SchedulerQueueError('timeout')); }, maxWaitMs);
      waiter.timer.unref();

      let entries = queue.owners.get(owner);
      if (!entries) {
        entries = [];
        queue.owners.set(owner, entries);
        queue.order.push(owner);
      }
      entries.push(waiter);
      this.waiters.set(workload, queue);
      this.ensureRecheck(workload, queue);
    });
  }

  queueDepth(workload: string): number {
    const queue = this.waiters.get(workload);
    return queue ? [...queue.owners.values()].reduce((total, entries) => total + entries.length, 0) : 0;
  }

  close(): void {
    for (const [workload, queue] of [...this.waiters]) {
      const pending = [...queue.owners.values()].flat();
      for (const waiter of pending) {
        this.removeWaiter(workload, waiter);
        if (!waiter.done) {
          waiter.done = true;
          this.cleanupWaiter(waiter);
          waiter.reject(new SchedulerQueueError('cancelled'));
        }
      }
      this.clearRecheck(queue);
    }
    this.waiters.clear();
  }

  reconcile(accountIds: ReadonlySet<string>) {
    const forwardingIds = new Set([...this.forwarding.values()].flatMap(workload => [...workload.keys()]));
    for (const id of this.selected.keys()) if (!accountIds.has(id) && !forwardingIds.has(id)) this.selected.delete(id);
  }

  private removeWaiter(workload: string, waiter: QueueWaiter): void {
    const queue = this.waiters.get(workload);
    if (!queue) return;
    const entries = queue.owners.get(waiter.owner);
    if (!entries) return;
    const index = entries.indexOf(waiter);
    if (index >= 0) entries.splice(index, 1);
    if (entries.length) return;
    queue.owners.delete(waiter.owner);
    const ownerIndex = queue.order.indexOf(waiter.owner);
    if (ownerIndex >= 0) queue.order.splice(ownerIndex, 1);
    if (!queue.owners.size) {
      this.clearRecheck(queue);
      this.waiters.delete(workload);
    }
  }

  private wakeOne(workload: string): boolean {
    const queue = this.waiters.get(workload);
    if (!queue) return false;
    while (queue.order.length) {
      const owner = queue.order.shift()!;
      const entries = queue.owners.get(owner);
      if (!entries?.length) {
        queue.owners.delete(owner);
        continue;
      }
      const waiter = entries.shift()!;
      if (entries.length) queue.order.push(owner); else queue.owners.delete(owner);
      if (!queue.owners.size) {
        this.clearRecheck(queue);
        this.waiters.delete(workload);
      }
      if (waiter.done || waiter.signal?.aborted) {
        if (!waiter.done) {
          waiter.done = true;
          this.cleanupWaiter(waiter);
          waiter.reject(new SchedulerQueueError('cancelled'));
        }
        continue;
      }
      waiter.done = true;
      this.cleanupWaiter(waiter);
      waiter.resolve();
      return true;
    }
    this.waiters.delete(workload);
    this.clearRecheck(queue);
    return false;
  }

  private ensureRecheck(workload: string, queue: WorkloadWaiters): void {
    if (queue.recheckMs === undefined || queue.recheckTimer || !queue.owners.size) return;
    queue.recheckTimer = setTimeout(() => {
      queue.recheckTimer = undefined;
      if (this.waiters.get(workload) !== queue) return;
      this.wakeOne(workload);
      if (this.waiters.get(workload) === queue) this.ensureRecheck(workload, queue);
    }, queue.recheckMs);
    queue.recheckTimer.unref();
  }

  private clearRecheck(queue: WorkloadWaiters): void {
    if (!queue.recheckTimer) return;
    clearTimeout(queue.recheckTimer);
    queue.recheckTimer = undefined;
  }

  private cleanupWaiter(waiter: QueueWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.onAbort = undefined;
  }
}
