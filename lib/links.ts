export function osmUrl(id: string): string {
  return `https://www.openstreetmap.org/${id}`;
}

/** A plain Google Maps search link that YOU open. Nothing is fetched from Google. */
export function mapsSearchUrl(name: string, area: string): string {
  return (
    'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(`${name} ${area}`.trim())
  );
}

export function webSearchUrl(name: string, area: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(`${name} ${area} website`.trim());
}

export function whatsappUrl(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

/** Returns a clean http(s) URL, or null if the value is not a usable website. */
export function normalizeWebsite(raw: string): string | null {
  const first = raw.split(';')[0].trim();
  if (!first) return null;
  const withScheme = /^https?:\/\//i.test(first) ? first : 'https://' + first;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}
