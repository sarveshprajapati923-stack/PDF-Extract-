import type { Lead } from './types';
import { websiteInfo } from './website';

const HEADERS = [
  'Name',
  'Category',
  'Status',
  'Website label',
  'Website',
  'Phone',
  'WhatsApp number',
  'Address',
  'Location searched',
  'OpenStreetMap link',
  'Google Maps search link',
  'Notes',
  'Saved on',
  'Last updated',
  'Data source',
];

const PHONE_LIKE = /^[+-]?[\d\s()-]+$/;

/** Escapes a cell and blocks spreadsheet formula injection. */
export function cell(value: string): string {
  let v = value ?? '';
  if (/^[=@\t\r]/.test(v) || (/^[+-]/.test(v) && !PHONE_LIKE.test(v))) {
    v = "'" + v;
  }
  return '"' + v.replace(/"/g, '""') + '"';
}

export function leadsToCsv(leads: Lead[]): string {
  const rows = leads.map((l) =>
    [
      l.name,
      l.category,
      l.status,
      websiteInfo(l.websiteStatus, l.websiteCheck).label,
      l.website ?? '',
      l.phone ?? '',
      l.whatsappNumber ?? '',
      l.address,
      l.locationName,
      l.osmUrl,
      l.mapsUrl,
      l.notes,
      l.createdAt,
      l.updatedAt,
      'OpenStreetMap contributors (ODbL), via Overpass API',
    ]
      .map(cell)
      .join(','),
  );
  // BOM so Excel opens Hindi text correctly.
  return '\uFEFF' + [HEADERS.map(cell).join(','), ...rows].join('\r\n');
}
