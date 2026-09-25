import { describe, test, expect } from 'bun:test';
import { RateLimiter } from '../src/lib/rate-limit.ts';

describe('RateLimiter', () => {
  test('allows up to max hits per key inside the window, then rejects', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(2, 60_000, () => now);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('a')).toBe(false);
  });

  test('keys are independent', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(1, 60_000, () => now);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('b')).toBe(true);
    expect(rl.allow('b')).toBe(false);
  });

  test('hits expire after the window', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(1, 60_000, () => now);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    now += 60_001;
    expect(rl.allow('a')).toBe(true);
  });

  test('retryAfterMs reports time until the oldest hit expires', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(1, 60_000, () => now);
    expect(rl.retryAfterMs('a')).toBe(0);
    rl.allow('a');
    now += 10_000;
    expect(rl.retryAfterMs('a')).toBe(50_000);
  });

  test('once-per-window limiter (analyze per raise): one pass, then blocked for 10 minutes', () => {
    let now = 0;
    const rl = new RateLimiter(1, 10 * 60_000, () => now);
    expect(rl.allow('raise-1')).toBe(true);
    now += 9 * 60_000;
    expect(rl.allow('raise-1')).toBe(false);
    now += 60_001;
    expect(rl.allow('raise-1')).toBe(true);
  });
});
