/** Split an OSM phone value such as "+91 98765 43210; 05564 123456" into parts. */
export function splitPhones(raw: string): string[] {
  return raw
    .split(/[;,/]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Returns a WhatsApp-ready number (digits only, with country code) or null.
 * Rules are India-focused: a bare 10-digit number must start with 6-9 (mobile).
 * Landlines are rejected because WhatsApp needs a mobile number.
 * Numbers with another "+country" prefix are accepted if they have 10-15 digits.
 */
export function toWhatsAppNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');

  if (hasPlus) {
    if (trimmed.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('91')) {
      return /^91[6-9]\d{9}$/.test(digits) ? digits : null;
    }
    return /^\d{10,15}$/.test(digits) ? digits : null;
  }

  if (/^[6-9]\d{9}$/.test(digits)) return '91' + digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return '91' + digits.slice(1);
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}

/** Value for a tel: link. */
export function toTelHref(raw: string): string {
  const t = raw.trim();
  return 'tel:' + (t.startsWith('+') ? '+' : '') + t.replace(/\D/g, '');
}
