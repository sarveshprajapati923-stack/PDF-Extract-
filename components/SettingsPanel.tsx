'use client';

import { useState } from 'react';
import type { CloudState } from '@/hooks/useLeads';
import { DEFAULT_TEMPLATE, fillTemplate } from '@/lib/message';
import type { Settings } from '@/lib/types';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  cloud: { state: CloudState; message: string };
  onConnect: (pass: string) => void;
  onDisconnect: () => void;
}

export function SettingsPanel({ settings, onChange, cloud, onConnect, onDisconnect }: Props) {
  const [pass, setPass] = useState(settings.passcode);

  return (
    <section aria-label="Settings">
      <div className="panel">
        <h2>Your WhatsApp message</h2>
        <p className="muted small">
          WhatsApp opens with this text pre-filled. You read it, edit it, and press send yourself. The app
          never sends anything.
        </p>
        <label className="field">
          <span>Your name</span>
          <input value={settings.myName} onChange={(e) => onChange({ myName: e.target.value })} maxLength={60} />
        </label>
        <label className="field">
          <span>Your business or service</span>
          <input
            value={settings.myBusiness}
            onChange={(e) => onChange({ myBusiness: e.target.value })}
            maxLength={80}
          />
        </label>
        <label className="field">
          <span>Message template</span>
          <textarea
            rows={6}
            value={settings.template}
            onChange={(e) => onChange({ template: e.target.value })}
            maxLength={800}
          />
        </label>
        <p className="muted small">
          Use <code>{'{name}'}</code> for the business name, <code>{'{myName}'}</code> and{' '}
          <code>{'{myBusiness}'}</code> for your details.
        </p>
        <div className="preview">
          <span className="small muted">Preview</span>
          <p>{fillTemplate(settings, 'Sample Restaurant')}</p>
        </div>
        <button type="button" className="btn full" onClick={() => onChange({ template: DEFAULT_TEMPLATE })}>
          Reset message to default
        </button>
        <p className="muted small">
          Send only relevant, respectful messages. Unwanted bulk messages can get a WhatsApp number
          blocked.
        </p>
      </div>

      <div className="panel">
        <h2>Cloud backup (optional)</h2>
        <p className="muted small">
          By default leads are stored only in this browser on this device. If you set up Supabase (see the
          README), enter your passcode to also keep them in the cloud and open them from other devices.
        </p>
        <label className="field">
          <span>Passcode (ADMIN_PASSCODE)</span>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={cloud.state === 'connecting'}
            onClick={() => {
              onChange({ passcode: pass });
              onConnect(pass);
            }}
          >
            {cloud.state === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPass('');
              onChange({ passcode: '' });
              onDisconnect();
            }}
          >
            Turn off
          </button>
        </div>
        {cloud.message && (
          <p className={cloud.state === 'error' ? 'status status-error' : 'muted small'} role="status">
            {cloud.message}
          </p>
        )}
        <p className="muted small">Status: {cloud.state === 'on' ? 'Cloud sync on' : 'Saved on this device only'}.</p>
      </div>
    </section>
  );
}
