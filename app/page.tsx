'use client';

import { useState } from 'react';
import { LeadsPanel } from '@/components/LeadsPanel';
import { SearchPanel } from '@/components/SearchPanel';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useLeads } from '@/hooks/useLeads';
import { useSettings } from '@/hooks/useSettings';

type Tab = 'search' | 'leads' | 'settings';

export default function Home() {
  const { settings, update } = useSettings();
  const { leads, save, patch, remove, cloud, connect, disconnect } = useLeads(settings.passcode);
  const [tab, setTab] = useState<Tab>('search');

  return (
    <div className="app">
      <header className="top">
        <h1>Local Business Finder</h1>
        <p className="small">Find nearby businesses on OpenStreetMap, check them, and keep your leads.</p>
      </header>

      <main className="main">
        <div hidden={tab !== 'search'}>
          <SearchPanel leads={leads} settings={settings} onSave={save} onCheck={(id, c) => patch(id, { websiteCheck: c })} />
        </div>
        <div hidden={tab !== 'leads'}>
          <LeadsPanel leads={leads} settings={settings} onPatch={patch} onRemove={remove} />
        </div>
        <div hidden={tab !== 'settings'}>
          <SettingsPanel
            settings={settings}
            onChange={update}
            cloud={cloud}
            onConnect={(p) => void connect(p)}
            onDisconnect={disconnect}
          />
        </div>
      </main>

      <nav className="tabs" aria-label="Sections">
        <button type="button" aria-current={tab === 'search' ? 'page' : undefined} onClick={() => setTab('search')}>
          Search
        </button>
        <button type="button" aria-current={tab === 'leads' ? 'page' : undefined} onClick={() => setTab('leads')}>
          Leads
          {leads.length > 0 && <span className="pill">{leads.length}</span>}
        </button>
        <button type="button" aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>
    </div>
  );
}
