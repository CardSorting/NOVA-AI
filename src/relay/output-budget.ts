/** Conservative local output units: one UTF-8 byte consumes one unit. This
 * bounds observed data, not unreported provider reasoning or remote spending. */
export class OutputBudget {
  private bytes = 0;
  private argumentBytes = 0;
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw Error('Invalid output budget.');
  }
  observe(text: string, argumentsDelta = false): boolean {
    const bytes = Buffer.byteLength(text);
    this.bytes += bytes;
    if (argumentsDelta) this.argumentBytes += bytes;
    return this.bytes <= this.limit;
  }
  finishTools(calls: unknown[]): boolean {
    // Final calls can arrive without argument deltas. Include their envelope,
    // but do not double-charge arguments already observed on the wire.
    const bytes = calls.length ? Buffer.byteLength(JSON.stringify(calls)) : 0;
    this.bytes += Math.max(0, bytes - this.argumentBytes);
    return this.bytes <= this.limit;
  }
}
