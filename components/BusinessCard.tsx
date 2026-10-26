'use client';

import { useState } from 'react';
import { whatsappUrl } from '@/lib/links';
import { fillTemplate } from '@/lib/message';
import { splitPhones, toTelHref } from '@/lib/phone';
import type { Business, Lead, Settings, WebsiteCheck } from '@/lib/types';
import { CHECK_OPTIONS } from '@/lib/website';
import { WebsiteBadge } from './WebsiteBadge';

interface Props {
  business: Business;
  lead: Lead | undefined;
  settings: Settings;
  onSave: (b: Business, check: WebsiteCheck) => void;
  onCheck: (id: string, check: WebsiteCheck) => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function BusinessCard({ business: b, lead, settings, onSave, onCheck }: Props) {
  const [localCheck, setLocalCheck] = useState<WebsiteCheck>('unchecked');
  const check = lead ? lead.websiteCheck : localCheck;
  const firstPhone = b.phone ? splitPhones(b.phone)[0] : null;
  const wa = b.whatsappNumber ? whatsappUrl(b.whatsappNumber, fillTemplate(settings, b.name)) : null;

  function changeCheck(v: WebsiteCheck) {
    if (lead) onCheck(lead.id, v);
    else setLocalCheck(v);
  }

  return (
    <li className="card">
      <div className="card-head">
        <h3>{b.name}</h3>
        <span className="chip">{b.category}</span>
      </div>

      <WebsiteBadge auto={b.websiteStatus} check={check} />

      <dl className="facts">
        <div>
          <dt>Address</dt>
          <dd>{b.address || 'Not listed on the map'}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{b.phone ?? 'Not listed on the map'}</dd>
        </div>
        <div>
          <dt>Website</dt>
          <dd>
            {b.website ? (
              <a href={b.website} target="_blank" rel="noopener noreferrer nofollow">
                {hostOf(b.website)}
              </a>
            ) : (
              'Not listed on the map'
            )}
          </dd>
        </div>
      </dl>

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
        <a className="btn" href={b.osmUrl} target="_blank" rel="noopener noreferrer">
          OpenStreetMap
        </a>
        <a className="btn" href={b.mapsUrl} target="_blank" rel="noopener noreferrer">
          Google Maps
        </a>
      </div>

      <details className="verify">
        <summary>Verify website manually</summary>
        <p className="muted small">
          Open these links yourself and look for a website, then record what you found.
        </p>
        <div className="actions">
          <a className="btn" href={b.mapsUrl} target="_blank" rel="noopener noreferrer">
            Search on Google Maps
          </a>
          <a className="btn" href={b.searchUrl} target="_blank" rel="noopener noreferrer">
            Search on Google
          </a>
        </div>
        <label className="field">
          <span>What did you find?</span>
          <select value={check} onChange={(e) => changeCheck(e.target.value as WebsiteCheck)}>
            {CHECK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </details>

      {lead ? (
        <p className="saved">Saved as a lead ({lead.status}). Manage it in the Leads tab.</p>
      ) : (
        <button type="button" className="btn btn-primary full" onClick={() => onSave(b, check)}>
          Save as lead
        </button>
      )}
    </li>
  );
}
