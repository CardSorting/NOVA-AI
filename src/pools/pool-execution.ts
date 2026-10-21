import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { CentralClient, hash, requestWorkload, type PoolId, type Workload } from './pool-protocol.js';
import { RequestError } from '../relay/request-policy.js';
import { cooldownDeadline } from '../relay/quota-policy.js';
import { performance } from 'node:perf_hooks';

export interface ExecutionGrant {
  signal: AbortSignal;
  assert(): void;
  // null is no confirmed provider result, never a negative health observation.
  complete(success: boolean | null, actualTokens?: number): Promise<void>;
}
export interface ExecutionPolicy {
  pool: PoolId;
  admit(req: IncomingMessage, body: Record<string, any>, tenant: string, executionId: string): Promise<ExecutionGrant>;
}
export interface AssignedAccount {
  id: string; revision: number; assignmentRevision: number; credentialRevision: string;
  state: 'enabled' | 'paused' | 'revoked'; desktopId: string; models: string[]; expiresAtMs: number;
  cooldownUntilMs?: number;
  credential?: { accessToken: string; accountId: string };
}
export interface ExecutionRecord {
  requestKey: string; requestSha256: string; tenantSha256: string; accountId: string; epoch: string;
  executionId: string; workload: Workload; leaseId?: string; state: 'reserved' | 'running' | 'completed' | 'unknown';
  success?: boolean | null; actualTokens?: number; settled: boolean;
}
export interface ExecutionStore {
  call(action: string, body?: Record<string, unknown>): Promise<any>;
}
export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly db: Pick<Pool,'query'>, private readonly pool: PoolId, private readonly installationId: string) {}
  async call(action: string, body: Record<string, unknown> = {}) {
    return (await this.db.query('SELECT private.relay_execution($1,$2::uuid,$3,$4::jsonb) AS result',[this.pool,this.installationId,action,JSON.stringify(body)])).rows[0].result;
  }
}
export class MemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, any>();
  async call(action: string, b: Record<string, any> = {}) {
    if (action === 'reserve') {
      if (!this.records.has(b.requestKey)) this.records.set(b.requestKey, { ...b, state: 'reserved', settled: false });
      return this.records.get(b.requestKey);
    }
    if (action === 'pending') return [...this.records.values()].filter(rec => ['completed', 'unknown'].includes(rec.state) && !rec.settled && rec.leaseId);
    const r = this.records.get(b.requestKey);
    if (!r) throw new Error('Record not found');
    if (action === 'bind') { r.state = 'running'; r.leaseId = b.leaseId; return r; }
    if (action === 'finish') { r.state = b.success ? 'completed' : 'unknown'; r.success = b.success; return r; }
    if (action === 'settled') { r.settled = true; return r; }
    throw new Error(`Unknown action: ${action}`);
  }
}
/** Short grants, independent expiry timers, durable reservations and retained settlement. */
export class PoolExecution {
  private grants = new Set<ExecutionGrant>();
  private finishes = new Map<string, Record<string, unknown>>();
  private readonly activeAccounts = new Map<string, number>();
  private readonly admissionDenials = new Map<string, { failures: number; until: number }>();
  private flushing?: Promise<void>;
  private settling?: Promise<void>;
  private settlementRetryAt = 0;
  private settlementFailures = 0;
  private readonly unboundLeases = new Map<string, Record<string, unknown>>();
  constructor(readonly central: CentralClient, readonly store: ExecutionStore, readonly epoch = randomUUID(),
    private readonly clock = { now: () => performance.now(), random: () => Math.random() }) {}
  private async flushFinishes(): Promise<void> {
    const flush = async () => {
    // A database outage at completion retains the terminal intent for this process.
    // A crash is recovered as unknown from the previously persisted reservation.
    for (const [key, body] of this.finishes) {
      await this.store.call('finish',body);
      if (this.finishes.get(key) === body) this.finishes.delete(key);
    }
    };
    while (this.finishes.size) {
      if (!this.flushing) this.flushing = flush().finally(() => { this.flushing = undefined; });
      await this.flushing;
      // Include completions added while the previous pass was finishing its final await.
    }
  }
  settlePending(): Promise<void> {
    if (this.settling) return this.settling;
    this.settling = this.settleBatch().finally(() => { this.settling = undefined; });
    return this.settling;
  }
  private async settleBatch() {
    await this.flushFinishes();
    if (this.clock.now() < this.settlementRetryAt) return;
    // Completion bursts share one bounded sweep. A stalled settlement cannot fan out.
    this.settlementRetryAt = this.clock.now() + 1000;
    try {
    let remaining = 8;
    for (const [leaseId,body] of this.unboundLeases) {
      if (!remaining--) break;
      const result = await this.central.call('/runtime/settle',body);
      if (result.success !== true) throw Error('Settlement unconfirmed.');
      this.unboundLeases.delete(leaseId);
    }
    const pending: ExecutionRecord[] = await this.store.call('pending');
    for (const row of pending.filter(row => row.leaseId).slice(0,Math.max(0,remaining))) {
        const result = await this.central.call('/runtime/settle',{epoch:row.epoch,leaseId:row.leaseId,success:row.success ?? null,actualTokens:row.actualTokens ?? null});
        if (result.success !== true) throw Error('Settlement unconfirmed.');
        await this.store.call('settled',{requestKey:row.requestKey,leaseId:row.leaseId});
    }
    this.settlementFailures = 0;
    } catch {
      this.settlementFailures = Math.min(10,this.settlementFailures + 1);
      this.settlementRetryAt = this.clock.now() + Math.min(60000,1000 * 2 ** (this.settlementFailures - 1)) + this.clock.random() * 1000;
      // Preserve original receipts. A dependency failure ends the batch, never retries execution.
    }
  }
  stop() { for (const grant of this.grants) void grant.complete(null).catch(()=>{}); }
  accountAvailable(accountId: string, now = Date.now()) {
    return (this.activeAccounts.get(accountId) ?? 0) < 4
      && (this.admissionDenials.get(accountId)?.until ?? 0) <= now;
  }
  accountRecovering(accountId: string) { return this.admissionDenials.has(accountId); }
  reconcileAccounts(ids: ReadonlySet<string>) {
    for (const id of this.admissionDenials.keys()) if (!ids.has(id) && !this.activeAccounts.has(id)) this.admissionDenials.delete(id);
  }
  policy(account: AssignedAccount): ExecutionPolicy {
    return {pool:this.central.identity.pool,admit:async(req,body,tenant,executionId)=>{
      if (!this.accountAvailable(account.id)) throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
      this.activeAccounts.set(account.id, (this.activeAccounts.get(account.id) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return; released = true;
        const remaining = (this.activeAccounts.get(account.id) ?? 1) - 1;
        if (remaining) this.activeAccounts.set(account.id, remaining); else this.activeAccounts.delete(account.id);
      };
      try { return await this.admit(account,req,body,tenant,executionId,release); }
      catch (error) { release(); throw error; }
    }};
  }
  private async admit(account: AssignedAccount, req: IncomingMessage, body: Record<string, any>, tenant: string, executionId: string, release: () => void): Promise<ExecutionGrant> {
    if (this.finishes.size || this.unboundLeases.size) throw new RequestError(503,'service_unavailable','This service is temporarily unavailable.');
    const workload = requestWorkload(this.central.identity.pool,req.url ?? '',body);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new RequestError(400,'request_key_required','Supply an Idempotency-Key for this request.');
    const tenantSha256 = hash(tenant), requestKey = hash(JSON.stringify([tenantSha256,workload,key]));
    const requestSha256 = hash(JSON.stringify(body));
    const reserved: ExecutionRecord = await this.store.call('reserve',{requestKey,requestSha256,tenantSha256,accountId:account.id,epoch:this.epoch,executionId,workload});
    if (reserved.executionId !== executionId || reserved.state !== 'reserved') throw new RequestError(409,'request_already_recorded','This request has already been recorded. Check its existing result.');
    const common = {epoch:this.epoch,accountId:account.id,revision:account.revision,credentialRevision:account.credentialRevision};
    let authorization: any;
    const previousDenial = this.admissionDenials.get(account.id);
    try {
      authorization = await this.central.call('/runtime/acquire',{...common,workload,requestKey,requestSha256,tenantSha256,
        estimatedTokens:Math.min(1_000_000,Math.max(2000,Buffer.byteLength(JSON.stringify(body))+1024+(Number.isSafeInteger(body.max_tokens)?body.max_tokens:4096)))});
      if (authorization.denied === true) {
        const failures = (this.admissionDenials.get(account.id)?.failures ?? 0) + 1;
        this.admissionDenials.set(account.id,{failures,until:cooldownDeadline(failures,Date.now())});
      }
      if (authorization.denied || typeof authorization.leaseId !== 'string') throw Error('Admission unavailable.');
      // Bind before any upstream I/O. A crash between acquisition and binding leaves a reserved identity, never permission to repeat.
      await this.store.call('bind',{requestKey,executionId,leaseId:authorization.leaseId});
      // A success started before a concurrent denial cannot clear that newer evidence.
      if (this.admissionDenials.get(account.id) === previousDenial) this.admissionDenials.delete(account.id);
    } catch {
      this.finishes.set(requestKey,{requestKey,executionId,success:null});
      // Acquisition may have succeeded before the execution database became unavailable.
      // If binding failed, retain the exact acquired lease for the shared paced settlement path.
      if (authorization?.leaseId) this.unboundLeases.set(authorization.leaseId, { epoch:this.epoch,leaseId:authorization.leaseId,success:null,actualTokens:null });
      await this.settlePending().catch(()=>{});
      throw new RequestError(503,'service_unavailable','This request could not be authorized. Check its status before retrying.');
    }
    const abort = new AbortController(); let expires = 0, deadline: NodeJS.Timeout, renewal: NodeJS.Timeout, done = false;
    const update = (value: any) => {
      if (value.leaseId !== authorization.leaseId || !Number.isSafeInteger(Number(value.expiresAtMs)) || Number(value.expiresAtMs) <= Date.now() + 1000 || Number(value.expiresAtMs) > Date.now()+35000) throw Error('Invalid grant.');
      expires = Number(value.expiresAtMs); authorization = value; clearTimeout(deadline);
      deadline = setTimeout(()=>abort.abort(new Error('Authorization expired.')),Math.max(1,expires-Date.now()-500)); deadline.unref();
    };
    const grant: ExecutionGrant = {
      signal:abort.signal,
      assert:()=>{ if (done || Date.now() >= expires-500) abort.abort(); abort.signal.throwIfAborted(); },
      complete:async(success,actualTokens)=>{
        if (done) return; done=true; clearTimeout(deadline); clearTimeout(renewal); this.grants.delete(grant); abort.abort();
        this.finishes.set(requestKey,{requestKey,executionId,success,...(actualTokens !== undefined ? {actualTokens}: {})});
        try { await this.flushFinishes(); } finally { release(); }
        // Remote settlement is recoverable maintenance, not a dependency of delivering a completed result.
        void this.settlePending().catch(()=>{});
      },
    };
    try { update(authorization); } catch { await grant.complete(null); throw new RequestError(503,'service_unavailable','This request could not be authorized.'); }
    const renew = () => { renewal = setTimeout(async()=>{
      if (done || abort.signal.aborted) return;
      try { update(await this.central.call('/runtime/renew',{...common,leaseId:authorization.leaseId,fencingToken:authorization.fencingToken})); }
      catch { abort.abort(new Error('Authorization unavailable.')); }
      if (!done && !abort.signal.aborted) renew();
    },8000); renewal.unref(); };
    this.grants.add(grant); renew(); return grant;
  }
}

export const NovaExecution = PoolExecution;
export type NovaExecution = PoolExecution;
