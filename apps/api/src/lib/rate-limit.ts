/**
 * Tiny sliding-window rate limiter (in-memory, per key). Used to throttle the public
 * path of costly endpoints (e.g. POST /analyze for callers who are neither admin nor
 * builder). The clock is injectable for tests.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    /** max allowed hits per key inside the window */
    readonly max: number,
    /** window length in milliseconds */
    readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when the hit is allowed (and records it); false when the key is over the limit. */
  allow(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Milliseconds until the oldest hit in the current window expires (for Retry-After). */
  retryAfterMs(key: string): number {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length < this.max || recent.length === 0) return 0;
    return Math.max(0, recent[0] + this.windowMs - now);
  }

  reset(): void {
    this.hits.clear();
  }
}
