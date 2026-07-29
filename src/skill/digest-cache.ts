export class ImmutableDigestCache {
  private readonly entries = new Map<string, { identity: string; digest: string }>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('digest cache maxEntries must be positive');
  }

  get(key: string, identity: string): string | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    if (cached.identity !== identity) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached.digest;
  }

  set(key: string, identity: string, digest: string): void {
    this.entries.delete(key);
    this.entries.set(key, { identity, digest });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
