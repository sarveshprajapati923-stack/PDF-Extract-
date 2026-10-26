'use client';

import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES } from '@/lib/categories';
import { PRESETS, RADIUS_OPTIONS } from '@/lib/locations';
import type {
  Business,
  CategoryId,
  Lead,
  SearchResponse,
  Settings,
  WebsiteCheck,
} from '@/lib/types';
import { websiteInfo } from '@/lib/website';
import { Attribution } from './Attribution';
import { BusinessCard } from './BusinessCard';

interface Props {
  leads: Lead[];
  settings: Settings;
  onSave: (b: Business, locationName: string, check: WebsiteCheck) => void;
  onCheck: (id: string, check: WebsiteCheck) => void;
}

const COOLDOWN_SECONDS = 5;
type WebFilter = 'all' | 'No Website Listed' | 'Website Listed' | 'Unknown';

export function SearchPanel({ leads, settings, onSave, onCheck }: Props) {
  const [loc, setLoc] = useState<string>(PRESETS[0].id);
  const [customName, setCustomName] = useState('');
  const [customLat, setCustomLat] = useState('');
  const [customLon, setCustomLon] = useState('');
  const [radius, setRadius] = useState(2000);
  const [category, setCategory] = useState<CategoryId>('restaurant');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [searchedName, setSearchedName] = useState('');
  const [wait, setWait] = useState(0);
  const [geoBusy, setGeoBusy] = useState(false);

  const [webFilter, setWebFilter] = useState<WebFilter>('all');
  const [phoneOnly, setPhoneOnly] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  function fillMyLocation() {
    if (!('geolocation' in navigator)) {
      setError('This browser cannot share your location. Enter coordinates instead.');
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLoc('custom');
        setCustomLat(pos.coords.latitude.toFixed(5));
        setCustomLon(pos.coords.longitude.toFixed(5));
        if (!customName.trim()) setCustomName('My location');
        setGeoBusy(false);
        setError(null);
      },
      () => {
        setGeoBusy(false);
        setError('Could not get your location. Allow location access or enter coordinates.');
      },
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }

  async function search() {
    setError(null);
    let lat: number;
    let lon: number;
    let name: string;
    if (loc === 'custom') {
      lat = parseFloat(customLat);
      lon = parseFloat(customLon);
      name = customName.trim() || 'Custom location';
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        setError('Enter valid coordinates, for example 26.8984 and 83.9797.');
        return;
      }
    } else {
      const p = PRESETS.find((x) => x.id === loc);
      if (!p) return;
      lat = p.lat;
      lon = p.lon;
      name = p.name;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lat, lon, radius, category, locationName: name }),
      });
      const json = (await res.json().catch(() => null)) as (SearchResponse & { error?: string }) | null;
      if (!res.ok || !json) {
        throw new Error(json?.error ?? `Search failed (HTTP ${res.status}).`);
      }
      setData(json);
      setSearchedName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed. Check your connection and try again.');
    } finally {
      setLoading(false);
      setWait(COOLDOWN_SECONDS);
    }
  }

  const leadById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);

  const shown = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.results.filter((b) => {
      const lead = leadById.get(b.id);
      const label = websiteInfo(b.websiteStatus, lead ? lead.websiteCheck : 'unchecked').label;
      if (webFilter !== 'all' && label !== webFilter) return false;
      if (phoneOnly && !b.phone) return false;
      if (needle && !`${b.name} ${b.address} ${b.category}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, q, webFilter, phoneOnly, leadById]);

  const busy = loading || wait > 0;

  return (
    <section aria-label="Search businesses">
      <div className="panel">
        <label className="field">
          <span>Location</span>
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="custom">Custom coordinates</option>
          </select>
        </label>

        {loc === 'custom' && (
          <div className="custom">
            <label className="field">
              <span>Name for your notes</span>
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Hata market"
                maxLength={60}
              />
            </label>
            <div className="row2">
              <label className="field">
                <span>Latitude</span>
                <input
                  inputMode="decimal"
                  value={customLat}
                  onChange={(e) => setCustomLat(e.target.value)}
                  placeholder="26.8984"
                />
              </label>
              <label className="field">
                <span>Longitude</span>
                <input
                  inputMode="decimal"
                  value={customLon}
                  onChange={(e) => setCustomLon(e.target.value)}
                  placeholder="83.9797"
                />
              </label>
            </div>
            <button type="button" className="btn full" onClick={fillMyLocation} disabled={geoBusy}>
              {geoBusy ? 'Getting location…' : 'Use my current location'}
            </button>
            <p className="muted small">
              Tip: in Google Maps or OpenStreetMap, long-press a spot to see its coordinates.
            </p>
          </div>
        )}

        <div className="row2">
          <label className="field">
            <span>Business type</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as CategoryId)}>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Radius</span>
            <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
              {RADIUS_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r / 1000} km
                </option>
              ))}
            </select>
          </label>
        </div>

        <button type="button" className="btn btn-primary full" onClick={search} disabled={busy}>
          {loading ? 'Searching…' : wait > 0 ? `Search again in ${wait}s` : 'Search businesses'}
        </button>
      </div>

      {loading && (
        <div className="status" role="status">
          <span className="spinner" aria-hidden="true" />
          Asking the public map server. This can take up to 25 seconds.
        </div>
      )}

      {error && (
        <div className="status status-error" role="alert">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          <div className="results-head">
            <h2>
              {data.count} {data.count === 1 ? 'business' : 'businesses'} near {searchedName}
            </h2>
            <p className="muted small">
              {data.cached ? 'Saved result from the last 15 minutes.' : 'Fresh result.'} Only places with a
              name on OpenStreetMap are shown.
            </p>
            {data.truncated && (
              <p className="notice small">
                Showing the first {data.count} places. Pick a smaller radius or a narrower type to see
                others.
              </p>
            )}
          </div>

          {data.count > 0 && (
            <div className="filters">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by name or address"
                aria-label="Filter results"
              />
              <div className="row2">
                <select
                  value={webFilter}
                  onChange={(e) => setWebFilter(e.target.value as WebFilter)}
                  aria-label="Website filter"
                >
                  <option value="all">All website labels</option>
                  <option value="No Website Listed">No Website Listed</option>
                  <option value="Website Listed">Website Listed</option>
                  <option value="Unknown">Unknown</option>
                </select>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={phoneOnly}
                    onChange={(e) => setPhoneOnly(e.target.checked)}
                  />
                  <span>Has phone</span>
                </label>
              </div>
            </div>
          )}

          {data.count === 0 ? (
            <div className="empty">
              <p>
                Nothing found. OpenStreetMap coverage is thin in some small towns, so this does not mean
                there are no businesses here. Try a larger radius, another type, or the Shops category.
              </p>
            </div>
          ) : (
            <>
              <p className="muted small">
                Showing {shown.length} of {data.count}.
              </p>
              <ul className="cards">
                {shown.map((b) => (
                  <BusinessCard
                    key={b.id}
                    business={b}
                    lead={leadById.get(b.id)}
                    settings={settings}
                    onSave={(biz, check) => onSave(biz, searchedName, check)}
                    onCheck={onCheck}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <Attribution />
    </section>
  );
}
