import type { CategoryId } from './types';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  /** Overpass tag filters. Each one becomes one query line. */
  selectors: string[];
}

export const CATEGORIES: CategoryDef[] = [
  {
    id: 'restaurant',
    label: 'Restaurants and food',
    selectors: ['["amenity"~"^(restaurant|fast_food|food_court)$"]'],
  },
  { id: 'cafe', label: 'Cafes', selectors: ['["amenity"="cafe"]'] },
  {
    id: 'hotel',
    label: 'Hotels and guest houses',
    selectors: ['["tourism"~"^(hotel|guest_house|hostel|motel)$"]'],
  },
  {
    id: 'salon',
    label: 'Salons and beauty',
    selectors: ['["shop"~"^(hairdresser|beauty)$"]'],
  },
  {
    id: 'gym',
    label: 'Gyms and fitness',
    selectors: ['["leisure"~"^(fitness_centre|sports_centre)$"]', '["amenity"="gym"]'],
  },
  {
    id: 'coaching',
    label: 'Coaching, training, schools',
    selectors: [
      '["amenity"~"^(training|language_school|prep_school|music_school|driving_school|college)$"]',
      '["office"="educational_institution"]',
    ],
  },
  { id: 'shop', label: 'Shops (any type)', selectors: ['["shop"]'] },
  {
    id: 'medical',
    label: 'Medical and pharmacy',
    selectors: ['["amenity"~"^(pharmacy|clinic|doctors|dentist|hospital)$"]', '["healthcare"]'],
  },
  {
    id: 'other',
    label: 'Other services (offices, crafts, banks)',
    selectors: ['["office"]', '["craft"]', '["amenity"~"^(bank|veterinary|fuel|car_wash)$"]'],
  },
];

export function isCategoryId(v: unknown): v is CategoryId {
  return typeof v === 'string' && CATEGORIES.some((c) => c.id === v);
}
