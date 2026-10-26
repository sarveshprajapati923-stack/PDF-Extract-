export type CategoryId =
  | 'restaurant'
  | 'cafe'
  | 'hotel'
  | 'salon'
  | 'gym'
  | 'coaching'
  | 'shop'
  | 'medical'
  | 'other';

/** What the OpenStreetMap record says. "none-listed" is NOT proof of no website. */
export type AutoWebsiteStatus = 'listed' | 'none-listed' | 'unknown';

/** What the user found by checking manually. */
export type WebsiteCheck = 'unchecked' | 'has' | 'none' | 'unsure';

export interface Business {
  id: string; // e.g. "node/123456"
  name: string;
  category: string;
  searchCategory: CategoryId;
  address: string; // may be empty
  phone: string | null; // display text, may hold several numbers
  whatsappNumber: string | null; // digits with country code, only if it looks like a mobile
  website: string | null;
  websiteStatus: AutoWebsiteStatus;
  lat: number;
  lon: number;
  osmUrl: string;
  mapsUrl: string;
  searchUrl: string;
}

export const LEAD_STATUSES = [
  'New',
  'Verified',
  'Contacted',
  'Interested',
  'Not Interested',
  'Client',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface Lead extends Business {
  locationName: string;
  websiteCheck: WebsiteCheck;
  status: LeadStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResponse {
  results: Business[];
  count: number;
  truncated: boolean;
  cached: boolean;
  fetchedAt: string;
  attribution: string;
}

export interface Settings {
  myName: string;
  myBusiness: string;
  template: string;
  passcode: string;
}
