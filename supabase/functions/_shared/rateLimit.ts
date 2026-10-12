// A small sliding-window limiter for the PUBLIC watch endpoint. Pure code (no Deno, no network) so it is tested directly.
//
// What it is for. Link tokens are 256-bit, so guessing one is not practical; the real abuse risks are floods of requests (cost, noise) and
// hammering the lookup with made-up tokens. Two limits per client address, checked BEFORE any database work:
//   * every request:        at most `requestsPerWindow` per window (default 60 per minute)
//   * failed lookups only:   at most `failuresPerWindow` per window (default 10 per 10 minutes) - a real client with a valid link never fails
// A client over a limit gets 429 for the rest of the window. The 429 depends only on how often the ADDRESS has called, never on the token, so
// it reveals nothing about which links exist.
//
// Two implementations of the same guard:
//   * createDbWatchGuard  - THE ONE USED IN PRODUCTION. The counters live in the database (migration 20261013110000_watch_rate_limits), so every
//     function instance shares them. It FAILS OPEN: if the database cannot be reached the request is allowed, so the limiter can never take
//     the endpoint down. (An in-memory counter was tried first and measured live: Supabase Edge instances do not share or reliably keep
//     memory, so 17 consecutive failures from one address were never throttled. It is not used for the public endpoint.)
//   * createWatchGuard    - in-memory, kept for tests and local use only.
//
// The client address comes from the proxy's forwarded header. Behind Supabase's gateway the LAST entry is the one the gateway itself added
// (earlier entries can be forged by the client), so that is the one used. A distributed attacker (many addresses) still needs a front-door
// control (Cloudflare / WAF rule in front of the function) - see docs/client-video-links.md.

export interface WindowLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export class WindowLimiter {
  private hits = new Map<string, number[]>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  constructor(private readonly opts: WindowLimiterOptions) {
    this.maxKeys = opts.maxKeys ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** True when this key has already used up its allowance in the current window. Does not count. */
  isLimited(key: string): boolean {
    return this.recent(key).length >= this.opts.limit;
  }

  /** Counts one event for the key. */
  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune();
  }

  private prune(): void {
    // Drop expired keys first; if still too big, drop the oldest-inserted ones. Never throws.
    for (const key of [...this.hits.keys()]) this.recent(key);
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

export interface WatchGuard {
  /** True when the request must be refused with 429 (checked before any lookup). Counts the request. */
  shouldThrottle(key: string): Promise<boolean>;
  /** Call when a lookup failed (unknown, expired, revoked, ... - any uniform-failure outcome). */
  recordFailure(key: string): Promise<void>;
}

export function createWatchGuard(opts: { requestsPerWindow?: number; windowMs?: number; failuresPerWindow?: number; failureWindowMs?: number; now?: () => number } = {}): WatchGuard {
  const all = new WindowLimiter({ limit: opts.requestsPerWindow ?? 60, windowMs: opts.windowMs ?? 60_000, now: opts.now });
  const failures = new WindowLimiter({ limit: opts.failuresPerWindow ?? 10, windowMs: opts.failureWindowMs ?? 600_000, now: opts.now });
  return {
    async shouldThrottle(key) {
      if (all.isLimited(key) || failures.isLimited(key)) return true;
      all.record(key);
      return false;
    },
    async recordFailure(key) {
      failures.record(key);
    },
  };
}

export interface DbWatchGuardDeps {
  /** Counts the request and answers whether it may proceed (public.watch_rate_check). Throws on any database problem. */
  check: (key: string) => Promise<boolean>;
  /** Records one failed lookup (public.watch_rate_fail). Throws on any database problem. */
  fail: (key: string) => Promise<void>;
}

/** The database-backed guard. Any error from the database means "allow": the limiter must never be able to block legitimate clients. */
export function createDbWatchGuard(deps: DbWatchGuardDeps): WatchGuard {
  return {
    async shouldThrottle(key) {
      try {
        return (await deps.check(key)) === false;
      } catch {
        return false;
      }
    },
    async recordFailure(key) {
      try {
        await deps.fail(key);
      } catch {
        // fail open
      }
    },
  };
}

/**
 * The address to throttle on. cf-connecting-ip and x-real-ip are set by the platform's front proxy (a client cannot choose them), so they come
 * first. x-forwarded-for is the fallback: its LAST entry is the one a proxy itself added. NOTE (measured on Supabase Edge): the last
 * x-forwarded-for entry there is a rotating proxy-node address, not the caller, so it must not be the primary key.
 */
export function clientKey(headers: Headers): string {
  const direct = headers.get('cf-connecting-ip') ?? headers.get('x-real-ip');
  if (direct && direct.trim()) return normaliseAddress(direct.trim());
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return normaliseAddress(parts[parts.length - 1]);
  }
  return 'unknown';
}

/** IPv4 as is. IPv6 reduced to its /64 (a single subscriber can use any address inside it, so the whole /64 shares one allowance). */
export function normaliseAddress(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value.includes(':') || value.includes('.')) return value.slice(0, 64); // IPv4, or an IPv4-mapped form
  const [head, tail = ''] = value.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = value.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = value.includes('::') ? [...headGroups, ...Array(Math.max(0, missing)).fill('0'), ...tailGroups] : headGroups;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return value.slice(0, 64);
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
