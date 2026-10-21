import fs from 'node:fs';
import path from 'node:path';

export const REGISTRY_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_POLICY = {
  maxResponseBytes: REGISTRY_MAX_RESPONSE_BYTES,
  burstBytes: 512 * 1024,
  bytesPerHour: 3 * 1024 * 1024,
  requestsPerMinute: 40,
  requestBurst: 4,
  overheadBytes: 1024,
};
type Policy = typeof DEFAULT_POLICY;
interface State {
  version: 1; updatedAt: number; byteTokens: number; requestTokens: number;
  requests: number; accountedBytes: number; blocked: number; failures: number;
}

export class RegistryEgressLimitError extends Error {
  constructor() { super('Registry synchronization budget exceeded'); this.name = 'RegistryEgressLimitError'; }
}

/** One controller owns the state file under its existing exclusive process lock.
 * This caps application payloads with a conservative protocol allowance, not Supabase billing bytes.
 * A reservation is persisted BEFORE I/O so restart loops cannot reset the budget.
 */
export class RegistryEgressGuard {
  private state: State;
  private readonly policy: Policy;
  private lastWarningAt = -Infinity;
  constructor(private readonly options: { stateFile?: string; now?: () => number; policy?: Partial<Policy> } = {}) {
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    if (Object.values(this.policy).some(n => !Number.isSafeInteger(n) || n <= 0)
      || this.policy.maxResponseBytes + this.policy.overheadBytes > this.policy.burstBytes) throw new Error('Invalid registry egress policy');
    this.state = { version: 1, updatedAt: this.now(), byteTokens: this.policy.burstBytes,
      requestTokens: Math.min(this.policy.requestBurst, this.policy.requestsPerMinute), requests: 0, accountedBytes: 0, blocked: 0, failures: 0 };
    if (options.stateFile && fs.existsSync(options.stateFile)) {
      if (fs.statSync(options.stateFile).size > 16 * 1024) throw new Error('Invalid registry budget state');
      const saved = JSON.parse(fs.readFileSync(options.stateFile, 'utf8')) as State;
      if (saved.version !== 1 || Object.keys(this.state).some(key => !Number.isFinite(saved[key as keyof State])
        || Number(saved[key as keyof State]) < 0)) throw new Error('Invalid registry budget state');
      this.state = Object.fromEntries(Object.keys(this.state).map(key => [key, saved[key as keyof State]])) as unknown as State;
      this.refill();
    }
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private refill() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.state.updatedAt);
    this.state.byteTokens = Math.min(this.policy.burstBytes, this.state.byteTokens + elapsed * this.policy.bytesPerHour / 3_600_000);
    this.state.requestTokens = Math.min(this.policy.requestBurst, this.policy.requestsPerMinute,
      this.state.requestTokens + elapsed * this.policy.requestsPerMinute / 60_000);
    this.state.updatedAt = Math.max(now, this.state.updatedAt);
  }
  private persist() {
    if (!this.options.stateFile) return;
    fs.mkdirSync(path.dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.options.stateFile);
  }
  private warnLimit() {
    if (this.now() - this.lastWarningAt < 60_000) return;
    this.lastWarningAt = this.now();
    console.warn('[RegistryEgressGuard] Synchronization paused by egress limits; inspect administrator diagnostics.');
  }
  async run<T>(operation: (allowance: number, charge: (bytes: number) => void) => Promise<T>,
    options: { maxResponseBytes?: number } = {}): Promise<T> {
    this.refill();
    const requested = options.maxResponseBytes ?? this.policy.maxResponseBytes;
    if (!Number.isSafeInteger(requested) || requested < 0) throw new RegistryEgressLimitError();
    const allowance = Math.min(this.policy.maxResponseBytes, requested);
    // Wait for a complete reservation. Repeated partial reads consume each
    // refill before a cold registry can fit, turning bounded backoff into an
    // indefinite outage. Refusal must consume neither byte nor request tokens.
    if (this.state.requestTokens < 1 || allowance < 4096 || this.state.byteTokens < allowance + this.policy.overheadBytes) {
      this.state.blocked++;
      this.persist();
      this.warnLimit();
      throw new RegistryEgressLimitError();
    }
    const reserved = allowance + this.policy.overheadBytes;
    this.state.byteTokens -= reserved;
    this.state.requestTokens--;
    this.state.requests++;
    this.state.accountedBytes += reserved;
    this.persist();
    let bytes = 0, measured = false;
    try {
      const result = await operation(allowance, amount => {
        if (!Number.isSafeInteger(amount) || amount < 0) throw new RegistryEgressLimitError();
        measured = true;
        bytes += amount;
        if (bytes > allowance) throw new RegistryEgressLimitError();
      });
      // Refund only after a complete response. Unknown/failed reads retain the reservation.
      const refund = measured ? allowance - bytes : 0;
      this.refill();
      this.state.byteTokens = Math.min(this.policy.burstBytes, this.state.byteTokens + refund);
      this.state.accountedBytes -= refund;
      this.persist();
      return result;
    } catch (error) {
      this.state.failures++;
      if (error instanceof RegistryEgressLimitError) { this.state.blocked++; this.warnLimit(); }
      this.persist();
      throw error;
    }
  }
  snapshot() {
    this.refill();
    return { policy: { ...this.policy }, requests: this.state.requests, accountedBytes: this.state.accountedBytes,
      failures: this.state.failures, blocked: this.state.blocked, remainingBurstBytes: Math.floor(this.state.byteTokens),
      persistent: Boolean(this.options.stateFile) };
  }
}

export async function readBoundedRegistryJson(response: Response, limit: number, charge: (bytes: number) => void,
  signal?: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new RegistryEgressLimitError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing registry response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      charge(value.byteLength);
      if (bytes > limit) throw new RegistryEgressLimitError();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
