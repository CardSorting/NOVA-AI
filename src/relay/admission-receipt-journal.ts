import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RequestError } from './request-policy.js';

export interface AdmissionEvidence { id: string; fingerprint: string; expires: number; state: 'pending' | 'complete' | 'unknown'; }

/** Bounded private tombstones; never persists prompts, credentials or image bodies.
 * Pending at process loss is uncertain. A completed response-cache expiry is
 * also converted to an unknown identity tombstone. A lost response is never
 * permission to dispatch again.
 */
export class AdmissionReceiptJournal {
  private poisoned = false;
  constructor(private readonly filename: string) {}
  healthy() { return !this.poisoned; }
  private fail(): never {
    this.poisoned = true;
    throw new RequestError(503, 'admission_storage_unavailable', 'Request recovery is temporarily unavailable. Preserve the existing operation identity and retry later.');
  }
  private directory() {
    const stat = fs.lstatSync(path.dirname(this.filename));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error();
  }
  load(): AdmissionEvidence[] {
    try {
      this.directory();
      let stat: fs.Stats;
      try { stat = fs.lstatSync(this.filename); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(this.filename + '.initialized')) {
          this.save([]); this.initialize(); return [];
        }
        throw e;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error();
      const value = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 1000) throw new Error();
      const seen = new Set<string>();
      const result = value.entries.map((row: AdmissionEvidence) => {
        if (!row || !/^[a-f0-9]{64}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || seen.has(row.id)
          || !Number.isSafeInteger(row.expires) || !['pending', 'complete', 'unknown'].includes(row.state)) throw new Error();
        seen.add(row.id);
        return { id: row.id, fingerprint: row.fingerprint, expires: row.expires, state: row.state === 'pending' ? 'unknown' : row.state };
      });
      this.initialize();
      return result;
    } catch { return this.fail(); }
  }
  private initialize() {
    const marker = this.filename + '.initialized';
    try { fs.writeFileSync(marker, 'galx-admissions-v1\n', { mode: 0o600, flag: 'wx', flush: true }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()
        || stat.size !== 19 || fs.readFileSync(marker, 'utf8') !== 'galx-admissions-v1\n') throw new Error();
    }
    const fd = fs.openSync(path.dirname(this.filename), fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  save(entries: AdmissionEvidence[]): void {
    if (this.poisoned) this.fail();
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      this.directory();
      if (fs.existsSync(this.filename + '.initialized')) {
        const stat = fs.lstatSync(this.filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error();
      }
      const body = JSON.stringify({ version: 1, entries });
      if (entries.length > 1000 || Buffer.byteLength(body) > 1024 * 1024) throw new Error();
      fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx', flush: true });
      fs.renameSync(temporary, this.filename);
      const fd = fs.openSync(path.dirname(this.filename), fs.constants.O_RDONLY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { this.fail(); }
    finally { try { fs.unlinkSync(temporary); } catch { /* Never delete the authoritative evidence on cleanup failure. */ } }
  }
}
