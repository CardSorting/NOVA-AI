/** Process-local, non-queuing admission. Owners cannot occupy the entire request budget. */
export class RequestBulkhead {
  private active = 0;
  private readonly owners = new Map<string, number>();
  constructor(private readonly total = 32, private readonly perOwner = 8) {}
  reserve(owner: string): (() => void) | undefined {
    const count = this.owners.get(owner) ?? 0;
    if (this.active >= this.total || count >= this.perOwner) return;
    this.active++; this.owners.set(owner, count + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      this.active--;
      const remaining = (this.owners.get(owner) ?? 1) - 1;
      if (remaining) this.owners.set(owner, remaining); else this.owners.delete(owner);
    };
  }
}
