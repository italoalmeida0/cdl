import { LIMITS } from "./config";

interface Bucket {
  used: number;
  resetAt: number;
}

class TokenBucket {
  private buckets = new Map<string, Bucket>();
  constructor(
    private maxTokens: number,
    private windowMs: number,
  ) {
    const timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    timer.unref();
  }

  hit(key: string, cost = 1, maxTokens = this.maxTokens): number {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { used: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    if (b.used + cost > maxTokens) {
      return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    }
    b.used += cost;
    return 0;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
    if (this.buckets.size > 50_000) {
      let count = 0;
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        count++;
        if (count >= 10_000) break;
      }
    }
  }
}

let ipLimiter = new TokenBucket(LIMITS.ipPerMin, 60_000);
let authLimiter = new TokenBucket(LIMITS.authPerMinPerIp, 60_000);
let downloadFailLimiter = new TokenBucket(LIMITS.downloadFailPerMinPerIp, 60_000);

export function configureLimits(opts: { ipPerMin?: number; authPerMin?: number; downloadFailPerMin?: number }): void {
  if (opts.ipPerMin) ipLimiter = new TokenBucket(opts.ipPerMin, 60_000);
  if (opts.authPerMin) authLimiter = new TokenBucket(opts.authPerMin, 60_000);
  if (opts.downloadFailPerMin) downloadFailLimiter = new TokenBucket(opts.downloadFailPerMin, 60_000);
}

export const limits = {
  ipPerMin: (ip: string) => ipLimiter.hit(ip),
  authPerMin: (ip: string) => authLimiter.hit(ip),
  downloadFailPerMin: (ip: string) => downloadFailLimiter.hit(ip),
};

// ===== Brute-force tracker =====

interface FailRecord {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const failures = new Map<string, FailRecord>();
const failSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, r] of failures) {
    if (r.lockedUntil < now && r.windowStart + 30 * 60_000 < now) {
      failures.delete(k);
    }
  }
  if (failures.size > 50_000) {
    let count = 0;
    for (const k of failures.keys()) {
      failures.delete(k);
      count++;
      if (count >= 10_000) break;
    }
  }
}, 60_000);
failSweep.unref();

export function bruteforceLocked(scope: string): number {
  const r = failures.get(scope);
  if (!r) return 0;
  const now = Date.now();
  if (r.lockedUntil > now) return Math.ceil((r.lockedUntil - now) / 1000);
  if (r.windowStart + LIMITS.loginFailWindowMs < now) failures.delete(scope);
  return 0;
}

export function bruteforceFail(
  scope: string,
  max = LIMITS.loginFailMax,
  windowMs = LIMITS.loginFailWindowMs,
  lockoutMs = LIMITS.loginLockoutMs,
): void {
  const now = Date.now();
  let r = failures.get(scope);
  if (!r || r.windowStart + windowMs < now) {
    r = { count: 0, windowStart: now, lockedUntil: 0 };
    failures.set(scope, r);
  }
  r.count++;
  if (r.count >= max) {
    r.lockedUntil = now + lockoutMs;
    r.count = 0;
    r.windowStart = now;
  }
}

export function bruteforceClear(scope: string): void {
  failures.delete(scope);
}

// ===== TOTP anti-replay =====

const usedTotpCodes = new Map<string, number>();
const totpSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of usedTotpCodes) {
    if (exp < now) usedTotpCodes.delete(k);
  }
}, 60_000);
totpSweep.unref();

export function consumeTotpCode(digest: string): boolean {
  if (usedTotpCodes.has(digest)) return false;
  usedTotpCodes.set(digest, Date.now() + 90_000);
  return true;
}
