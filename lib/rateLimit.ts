const buckets = new Map<string, number[]>();

/**
 * Very small in-memory limiter. On Vercel each server instance has its own
 * memory, so this is a best-effort guard, not a hard guarantee.
 */
export function hit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)) };
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) buckets.clear();
  return { ok: true, retryAfter: 0 };
}
