/**
 * Tiny TTL cache + in-flight de-dupe. Replaces the per-module cache pattern.
 *
 * The de-dupe is critical: when a tool fans out 30 parallel get_fx_rate calls
 * with the same arguments, we collapse them to one upstream request.
 */
export class TtlCache<V> {
  private store = new Map<string, { at: number; value: V }>();
  private inflight = new Map<string, Promise<V>>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, miss: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = miss().then(
      (value) => {
        this.store.set(key, { at: Date.now(), value });
        this.inflight.delete(key);
        return value;
      },
      (err) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  clear() {
    this.store.clear();
    this.inflight.clear();
  }
}
