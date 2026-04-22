// Simple in-memory LRU with TTL. No external dependency, no persistence.
// Upstream IWG calls are rate-limited and some (especially Urkunde downloads)
// can be large; caching by input key keeps the UI snappy for repeat views.

export class LruCache {
  constructor({ max = 500, ttlMs = 10 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttl = ttlMs;
    this.store = new Map(); // key -> { value, expires }
  }
  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }
  set(key, value, ttlMs = this.ttl) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }
  async wrap(key, loader, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    this.set(key, value, ttlMs);
    return value;
  }
  clear() { this.store.clear(); }
}
