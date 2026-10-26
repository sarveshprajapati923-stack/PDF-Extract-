'use client';

import { useMemo, useState } from 'react';
import { leadsToCsv } from '@/lib/csv';
import { whatsappUrl } from '@/lib/links';
import { fillTemplate } from '@/lib/message';
import { splitPhones, toTelHref } from '@/lib/phone';
import { LEAD_STATUSES, type Lead, type LeadStatus, type Settings, type WebsiteCheck } from '@/lib/types';
import { CHECK_OPTIONS } from '@/lib/website';
import { Attribution } from './Attribution';
import { WebsiteBadge } from './WebsiteBadge';

interface Props {
  leads: Lead[];
  settings: Settings;
  onPatch: (id: string, changes: Partial<Pick<Lead, 'status' | 'notes' | 'websiteCheck'>>) => void;
  onRemove: (id: string) => void;
}

export function LeadsPanel({ leads, settings, onPatch, onRemove }: Props) {
  const [filter, setFilter] = useState<'All' | LeadStatus>('All');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of leads) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (filter !== 'All' && l.status !== filter) return false;
      if (!needle) return true;
      return `${l.name} ${l.address} ${l.locationName} ${l.notes} ${l.category}`.toLowerCase().includes(needle);
    });
  }, [leads, filter, q]);

  function exportCsv() {
    const blob = new Blob([leadsToCsv(leads)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function confirmRemove(l: Lead) {
    if (window.confirm(`Delete "${l.name}" from your leads?`)) onRemove(l.id);
  }

  if (leads.length === 0) {
    return (
      <section aria-label="Saved leads">
        <div className="empty">
          <h2>No leads yet</h2>
          <p>
            Search for businesses, then tap <strong>Save as lead</strong> on the ones you want to follow up.
          </p>
        </div>
        <Attribution />
      </section>
    );
  }

  return (
    <section aria-label="Saved leads">
      <div className="results-head">
        <h2>
          {leads.length} saved {leads.length === 1 ? 'lead' : 'leads'}
        </h2>
        <button type="button" className="btn btn-primary full" onClick={exportCsv}>
          Export all leads as CSV
        </button>
      </div>

      <div className="status-strip" aria-label="Lead counts">
        {LEAD_STATUSES.map((s) => (
          <span key={s} className="count">
            {s}: <strong>{counts[s] ?? 0}</strong>
          </span>
        ))}
      </div>

      <div className="filters">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your leads"
          aria-label="Search your leads"
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as 'All' | LeadStatus)} aria-label="Status filter">
          <option value="All">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <ul className="cards">
        {shown.map((l) => {
          const firstPhone = l.phone ? splitPhones(l.phone)[0] : null;
          const wa = l.whatsappNumber ? whatsappUrl(l.whatsappNumber, fillTemplate(settings, l.name)) : null;
          return (
            <li className="card" key={l.id}>
              <div className="card-head">
                <h3>{l.name}</h3>
                <span className="chip">{l.category}</span>
              </div>
              <p className="muted small">
                {l.address || 'No address on the map'} · found near {l.locationName}
              </p>

              <WebsiteBadge auto={l.websiteStatus} check={l.websiteCheck} />
              {l.website && (
                <p className="small">
                  <a href={l.website} target="_blank" rel="noopener noreferrer nofollow">
                    {l.website}
                  </a>
                </p>
              )}
              {l.phone && <p className="small">Phone: {l.phone}</p>}

              <div className="row2">
                <label className="field">
                  <span>Status</span>
                  <select
                    className={`status-select s-${l.status.replace(/\s/g, '').toLowerCase()}`}
                    value={l.status}
                    onChange={(e) => onPatch(l.id, { status: e.target.value as LeadStatus })}
                  >
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Website check</span>
                  <select
                    value={l.websiteCheck}
                    onChange={(e) => onPatch(l.id, { websiteCheck: e.target.value as WebsiteCheck })}
                  >
                    {CHECK_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Notes</span>
                <textarea
                  rows={2}
                  defaultValue={l.notes}
                  placeholder="Call back Monday, owner is Mr. Singh…"
                  onBlur={(e) => {
                    if (e.target.value !== l.notes) onPatch(l.id, { notes: e.target.value });
                  }}
                />
              </label>

              <div className="actions">
                {wa && (
                  <a className="btn btn-wa" href={wa} target="_blank" rel="noopener noreferrer">
                    WhatsApp
                  </a>
                )}
                {firstPhone && (
                  <a className="btn" href={toTelHref(firstPhone)}>
                    Call
                  </a>
                )}
                <a className="btn" href={l.osmUrl} target="_blank" rel="noopener noreferrer">
                  OpenStreetMap
                </a>
                <a className="btn" href={l.mapsUrl} target="_blank" rel="noopener noreferrer">
                  Google Maps
                </a>
                <a className="btn" href={l.searchUrl} target="_blank" rel="noopener noreferrer">
                  Search web
                </a>
                <button type="button" className="btn btn-danger" onClick={() => confirmRemove(l)}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && (
        <div className="empty">
          <p>No leads match this filter.</p>
        </div>
      )}
      <Attribution />
    </section>
  );
}
