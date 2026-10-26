export interface Preset {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * Approximate town centres. Coordinates come from public gazetteer-style
 * sources and may be a few hundred metres off. Use "Custom coordinates"
 * (or "Use my location") if you want an exact centre.
 */
export const PRESETS: Preset[] = [
  { id: 'fazilnagar', name: 'Fazilnagar', lat: 26.6827, lon: 84.0498 },
  { id: 'kasia', name: 'Kasia', lat: 26.7475, lon: 83.9149 },
  { id: 'padrauna', name: 'Padrauna', lat: 26.8984, lon: 83.9797 },
  { id: 'kushinagar', name: 'Kushinagar', lat: 26.741, lon: 83.888 },
];

export const RADIUS_OPTIONS = [1000, 2000, 3000, 5000];
export const MIN_RADIUS = 300;
export const MAX_RADIUS = 5000;
