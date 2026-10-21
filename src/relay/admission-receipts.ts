import { createHash } from 'node:crypto';
import { RequestError } from './request-policy.js';
import { AdmissionReceiptJournal } from './admission-receipt-journal.js';

export interface AdmissionReceipt {
  id: string;
  fingerprint: string;
  expires: number;
  state: 'pending' | 'complete' | 'unknown';
  response?: { status: number; headers: Record<string, string>; body: Buffer };
}
/** Bounded response cache plus optional durable admission tombstones. Never evict a live or uncertain key to admit another write. */
export class AdmissionReceipts {
  private readonly entries = new Map<string, AdmissionReceipt>();
  private bytes = 0;
  private readonly journal?: AdmissionReceiptJournal;
  private readonly onDiagnostic?: (event: { code: 'admission_storage_unavailable' }) => void;
  constructor(private readonly now = Date.now, private readonly ttlMs = 600000, private readonly capacity = 1000,
    private readonly maxBytes = 32 * 1024 * 1024, filename?: string,
    onDiagnostic?: (event: { code: 'admission_storage_unavailable' }) => void) {
    this.onDiagnostic = onDiagnostic;
    if (filename) {
      this.journal = new AdmissionReceiptJournal(filename);
      for (const entry of this.journal.load()) this.entries.set(entry.id, entry);
    }
  }
  private persist() {
    try { this.journal?.save([...this.entries.values()].map(({id,fingerprint,expires,state}) => ({id,fingerprint,expires,state}))); }
    catch (error) {
      try { this.onDiagnostic?.({ code: 'admission_storage_unavailable' }); } catch { /* Diagnostics never change the safety outcome. */ }
      throw error;
    }
  }
  diagnostics() { return { retained: this.entries.size, unknown: [...this.entries.values()].filter(r => r.state === 'unknown').length,
    durable: !!this.journal, storageHealthy: this.journal?.healthy() ?? true }; }
  begin(tenant: string, route: string, key: string, body: Record<string, unknown>) {
    this.prune();
    const id = createHash('sha256').update(JSON.stringify([tenant, route, key])).digest('hex');
    // Stable object-key ordering; message/array order remains part of request identity.
    const canonical = (value: any, depth = 0): any => {
      if (depth > 64) throw new RequestError(400, 'request_too_deep', 'Request nesting exceeds 64 levels.');
      return Array.isArray(value) ? value.map(v => canonical(v, depth + 1)) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], depth + 1)])) : value;
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
    const previous = this.entries.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new RequestError(409, 'idempotency_conflict', 'This key belongs to different request parameters. Use a new key for different work.');
      return { id, receipt: previous, existing: true };
    }
    if (this.entries.size >= this.capacity) throw new RequestError(503, 'idempotency_capacity_exhausted', 'The retry window is full. Retry this request later with the same key.');
    const receipt: AdmissionReceipt = { id, fingerprint, expires: this.now() + this.ttlMs, state: 'pending' };
    this.entries.set(id, receipt);
    try { this.persist(); } catch (error) { this.entries.delete(id); throw error; }
    return { id, receipt, existing: false };
  }
  complete(receipt: AdmissionReceipt, status: number, headers: Record<string, string>, body?: Buffer) {
    receipt.state = 'complete';
    this.persist();
    if (body && body.length <= 8 * 1024 * 1024 && this.bytes + body.length <= this.maxBytes) {
      receipt.response = { status, headers, body }; this.bytes += body.length;
    }
  }
  unknown(receipt: AdmissionReceipt) { receipt.state = 'unknown'; this.persist(); }
  capture() {
    let chunks: Buffer[] = [], size = 0, usable = true;
    const release = () => { this.bytes -= size; chunks = []; size = 0; };
    return {
      append: (chunk: Buffer) => {
        if (!usable) return;
        if (size + chunk.length > 8 * 1024 * 1024 || this.bytes + chunk.length > this.maxBytes) { usable = false; release(); return; }
        chunks.push(Buffer.from(chunk)); size += chunk.length; this.bytes += chunk.length;
      },
      finish: () => { const body = usable ? Buffer.concat(chunks) : undefined; release(); return body; },
      discard: release,
    };
  }
  forget(id: string) { const old = this.entries.get(id); if (old?.response) this.bytes -= old.response.body.length; this.entries.delete(id); this.persist(); }
  prune() {
    const now = this.now();
    let changed = false;
    for (const receipt of this.entries.values()) {
      if (receipt.state !== 'complete' || receipt.expires > now) continue;
      // A completed key that has outlived its response-cache window is still
      // evidence that work was accepted. Retain the identity permanently as
      // unknown so a late retry cannot turn an old operation into new work.
      receipt.state = 'unknown';
      if (receipt.response) {
        this.bytes -= receipt.response.body.length;
        delete receipt.response;
      }
      changed = true;
    }
    if (changed) this.persist();
  }
}
