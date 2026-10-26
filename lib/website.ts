import type { AutoWebsiteStatus, WebsiteCheck } from './types';

export type WebsiteLabel = 'Website Listed' | 'No Website Listed' | 'Unknown';

export interface WebsiteInfo {
  label: WebsiteLabel;
  tone: 'good' | 'warn' | 'muted';
  note: string;
}

/**
 * "No Website Listed" only means the map record has no website field.
 * It never claims the business has no website.
 */
export function websiteInfo(auto: AutoWebsiteStatus, check: WebsiteCheck): WebsiteInfo {
  if (check === 'has') {
    return { label: 'Website Listed', tone: 'good', note: 'You confirmed a website exists.' };
  }
  if (check === 'none') {
    return {
      label: 'No Website Listed',
      tone: 'warn',
      note: 'You checked and could not find a website.',
    };
  }
  if (check === 'unsure') {
    return { label: 'Unknown', tone: 'muted', note: 'You could not confirm either way.' };
  }
  if (auto === 'listed') {
    return { label: 'Website Listed', tone: 'good', note: 'A website is recorded on OpenStreetMap.' };
  }
  if (auto === 'none-listed') {
    return {
      label: 'No Website Listed',
      tone: 'warn',
      note: 'No website is recorded on OpenStreetMap. It may still have one, so verify first.',
    };
  }
  return {
    label: 'Unknown',
    tone: 'muted',
    note: 'The website value on OpenStreetMap could not be read.',
  };
}

export const CHECK_OPTIONS: { value: WebsiteCheck; label: string }[] = [
  { value: 'unchecked', label: 'Not checked yet' },
  { value: 'has', label: 'I found a website' },
  { value: 'none', label: 'I found no website' },
  { value: 'unsure', label: 'Not sure' },
];
