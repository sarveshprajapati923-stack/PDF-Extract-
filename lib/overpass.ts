import { CATEGORIES } from './categories';
import { mapsSearchUrl, normalizeWebsite, osmUrl, webSearchUrl } from './links';
import { splitPhones, toWhatsAppNumber } from './phone';
import type { Business, CategoryId } from './types';

export const MAX_RESULTS = 100;
export const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';

export class OverpassError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function buildQuery(lat: number, lon: number, radius: number, category: CategoryId): string {
  const cat = CATEGORIES.find((c) => c.id === category);
  if (!cat) throw new Error('Unknown category');
  const around = `(around:${Math.round(radius)},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const lines = cat.selectors.map((s) => `  nwr${s}["name"]${around};`).join('\n');
  return `[out:json][timeout:20];\n(\n${lines}\n);\nout tags center ${MAX_RESULTS};`;
}

const CATEGORY_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft', 'healthcare'];

function humanize(v: string): string {
  const s = v.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function categoryLabel(tags: Record<string, string>): string {
  for (const k of CATEGORY_KEYS) {
    const v = tags[k];
    if (v && v !== 'yes') return humanize(v);
  }
  return 'Business';
}

function buildAddress(tags: Record<string, string>): string {
  if (tags['addr:full']) return tags['addr:full'].trim();
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:place'],
    tags['addr:suburb'],
    tags['addr:village'],
    tags['addr:city'],
    tags['addr:subdistrict'],
    tags['addr:district'],
    tags['addr:postcode'],
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(', ');
}

export function parseElements(
  elements: OsmElement[],
  category: CategoryId,
  areaHint: string,
): Business[] {
  const seen = new Set<string>();
  const out: Business[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = (tags.name ?? '').trim();
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || typeof lat !== 'number' || typeof lon !== 'number') continue;

    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const phoneRaw = [tags.phone, tags['contact:phone'], tags.mobile, tags['contact:mobile']]
      .filter(Boolean)
      .join(';');
    const phones = Array.from(new Set(splitPhones(phoneRaw)));
    const whatsappNumber = phones.map(toWhatsAppNumber).find((n) => n !== null) ?? null;

    const rawSite = (tags.website ?? tags['contact:website'] ?? tags.url ?? '').trim();
    const website = rawSite ? normalizeWebsite(rawSite) : null;

    const address = buildAddress(tags);
    const area = address || areaHint || `${lat.toFixed(4)},${lon.toFixed(4)}`;

    out.push({
      id,
      name,
      category: categoryLabel(tags),
      searchCategory: category,
      address,
      phone: phones.length ? phones.join(', ') : null,
      whatsappNumber,
      website,
      websiteStatus: website ? 'listed' : rawSite ? 'unknown' : 'none-listed',
      lat,
      lon,
      osmUrl: osmUrl(id),
      mapsUrl: mapsSearchUrl(name, area),
      searchUrl: webSearchUrl(name, area),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Sends ONE query to the configured Overpass server. Server-side only. */
export async function runOverpass(query: string): Promise<OsmElement[]> {
  const endpoint = process.env.OVERPASS_URL || DEFAULT_ENDPOINT;
  const contact = process.env.OVERPASS_CONTACT || 'contact-not-set';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': `LocalBusinessFinder/1.0 (${contact})`,
      },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (res.status === 429) {
      throw new OverpassError(
        'The public map server is rate limiting requests. Wait a minute and try again.',
        429,
      );
    }
    if (res.status === 503 || res.status === 504) {
      throw new OverpassError(
        'The public map server is busy or timed out. Try a smaller radius or try again in a few minutes.',
        503,
      );
    }
    if (!res.ok) {
      throw new OverpassError(`The map server returned an error (HTTP ${res.status}).`, 502);
    }
    let json: { elements?: OsmElement[]; remark?: string };
    try {
      json = await res.json();
    } catch {
      throw new OverpassError('The map server sent an unreadable response. Try again later.', 502);
    }
    const elements = Array.isArray(json.elements) ? json.elements : [];
    if (elements.length === 0 && json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
      throw new OverpassError(
        'The map server could not finish this search. Try a smaller radius.',
        503,
      );
    }
    return elements;
  } catch (e) {
    if (e instanceof OverpassError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new OverpassError('The map server took too long to answer. Try a smaller radius.', 504);
    }
    throw new OverpassError(
      'Could not reach the map server. Check your internet or try again later.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}
