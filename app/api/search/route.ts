import { NextResponse } from 'next/server';
import { isCategoryId } from '@/lib/categories';
import { MAX_RADIUS, MIN_RADIUS } from '@/lib/locations';
import { buildQuery, MAX_RESULTS, OverpassError, parseElements, runOverpass } from '@/lib/overpass';
import { hit } from '@/lib/rateLimit';
import type { Business, SearchResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 100;
const cache = new Map<string, { at: number; results: Business[]; truncated: boolean }>();

const ATTRIBUTION = 'Map data © OpenStreetMap contributors (ODbL), via the Overpass API';

function fail(message: string, status: number, retryAfter?: number) {
  const headers: Record<string, string> = {};
  if (retryAfter) headers['Retry-After'] = String(retryAfter);
  return NextResponse.json({ error: message }, { status, headers });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail('Invalid request.', 400);
  }

  const lat = Number(body.lat);
  const lon = Number(body.lon);
  const radius = Math.round(Number(body.radius));
  const category = body.category;
  const locationName =
    typeof body.locationName === 'string'
      ? body.locationName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60)
      : '';

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return fail('Enter valid coordinates.', 400);
  }
  if (!Number.isFinite(radius) || radius < MIN_RADIUS || radius > MAX_RADIUS) {
    return fail(`Radius must be between ${MIN_RADIUS} and ${MAX_RADIUS} metres.`, 400);
  }
  if (!isCategoryId(category)) return fail('Unknown category.', 400);

  const key = `${lat.toFixed(3)}|${lon.toFixed(3)}|${radius}|${category}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    const payload: SearchResponse = {
      results: cached.results,
      count: cached.results.length,
      truncated: cached.truncated,
      cached: true,
      fetchedAt: new Date(cached.at).toISOString(),
      attribution: ATTRIBUTION,
    };
    return NextResponse.json(payload);
  }

  // Only live Overpass calls count against the limits.
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  const mine = hit(`ip:${ip}`, 6, 60_000);
  if (!mine.ok) {
    return fail(`Too many searches. Please wait ${mine.retryAfter} seconds.`, 429, mine.retryAfter);
  }
  const all = hit('global', 30, 60_000);
  if (!all.ok) {
    return fail('This app is making too many map requests right now. Try again shortly.', 429, all.retryAfter);
  }

  try {
    const elements = await runOverpass(buildQuery(lat, lon, radius, category));
    const results = parseElements(elements, category, locationName);
    const truncated = elements.length >= MAX_RESULTS;
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const at = Date.now();
    cache.set(key, { at, results, truncated });
    const payload: SearchResponse = {
      results,
      count: results.length,
      truncated,
      cached: false,
      fetchedAt: new Date(at).toISOString(),
      attribution: ATTRIBUTION,
    };
    return NextResponse.json(payload);
  } catch (e) {
    if (e instanceof OverpassError) return fail(e.message, e.status === 429 ? 429 : 502);
    return fail('Something went wrong while searching. Try again.', 500);
  }
}
