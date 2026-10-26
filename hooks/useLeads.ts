'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Business, Lead, WebsiteCheck } from '@/lib/types';

const KEY = 'lbf.leads.v1';

export type CloudState = 'off' | 'connecting' | 'on' | 'error';

function mergeLeads(a: Lead[], b: Lead[]): Lead[] {
  const map = new Map<string, Lead>();
  for (const l of [...a, ...b]) {
    const prev = map.get(l.id);
    if (!prev || l.updatedAt > prev.updatedAt) map.set(l.id, l);
  }
  return Array.from(map.values()).sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

export function useLeads(passcode: string) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [cloud, setCloud] = useState<{ state: CloudState; message: string }>({
    state: 'off',
    message: '',
  });
  const leadsRef = useRef<Lead[]>([]);
  const passRef = useRef<string | null>(null);
  const triedAuto = useRef(false);

  const commit = useCallback((next: Lead[]) => {
    leadsRef.current = next;
    setLeads(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage full or blocked */
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Lead[];
        if (Array.isArray(parsed)) {
          leadsRef.current = parsed;
          setLeads(parsed);
        }
      }
    } catch {
      /* ignore unreadable storage */
    }
  }, []);

  const cloudFail = useCallback((message: string) => {
    setCloud({ state: 'error', message });
  }, []);

  const push = useCallback(
    (items: Lead[]) => {
      const pass = passRef.current;
      if (pass === null || items.length === 0) return;
      fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-passcode': pass },
        body: JSON.stringify({ leads: items }),
      })
        .then((res) => {
          if (!res.ok) cloudFail('Could not sync to the cloud. Your lead is still saved on this device.');
        })
        .catch(() => cloudFail('Could not reach the cloud. Your lead is still saved on this device.'));
    },
    [cloudFail],
  );

  const connect = useCallback(
    async (pass: string, silent = false) => {
      if (!pass.trim()) {
        setCloud({ state: 'off', message: 'Enter your passcode first.' });
        return;
      }
      setCloud({ state: 'connecting', message: 'Connecting…' });
      try {
        const res = await fetch('/api/leads', { headers: { 'x-admin-passcode': pass } });
        if (res.status === 501) {
          setCloud({
            state: 'off',
            message: silent ? '' : 'Cloud storage is not set up on this deployment. Leads stay on this device.',
          });
          return;
        }
        if (res.status === 401) {
          setCloud({ state: 'error', message: 'Wrong passcode.' });
          return;
        }
        if (!res.ok) {
          setCloud({ state: 'error', message: 'Cloud storage is not responding. Try again later.' });
          return;
        }
        const json = (await res.json()) as { leads?: Lead[] };
        const remote = Array.isArray(json.leads) ? json.leads : [];
        const merged = mergeLeads(leadsRef.current, remote);
        commit(merged);
        passRef.current = pass;
        setCloud({ state: 'on', message: `Connected. ${merged.length} leads in sync.` });
        // Upload anything that only exists on this device.
        const remoteIds = new Set(remote.map((l) => l.id));
        push(merged.filter((l) => !remoteIds.has(l.id)));
      } catch {
        setCloud({ state: 'error', message: 'Could not reach the server.' });
      }
    },
    [commit, push],
  );

  const disconnect = useCallback(() => {
    passRef.current = null;
    setCloud({ state: 'off', message: 'Cloud sync turned off on this device.' });
  }, []);

  useEffect(() => {
    if (passcode && !triedAuto.current) {
      triedAuto.current = true;
      void connect(passcode, true);
    }
  }, [passcode, connect]);

  const save = useCallback(
    (b: Business, locationName: string, websiteCheck: WebsiteCheck) => {
      if (leadsRef.current.some((l) => l.id === b.id)) return;
      const now = new Date().toISOString();
      const lead: Lead = {
        ...b,
        locationName,
        websiteCheck,
        status: websiteCheck === 'unchecked' ? 'New' : 'Verified',
        notes: '',
        createdAt: now,
        updatedAt: now,
      };
      commit([lead, ...leadsRef.current]);
      push([lead]);
    },
    [commit, push],
  );

  const patch = useCallback(
    (id: string, changes: Partial<Pick<Lead, 'status' | 'notes' | 'websiteCheck'>>) => {
      const target = leadsRef.current.find((l) => l.id === id);
      if (!target) return;
      const updated: Lead = { ...target, ...changes, updatedAt: new Date().toISOString() };
      commit(leadsRef.current.map((l) => (l.id === id ? updated : l)));
      push([updated]);
    },
    [commit, push],
  );

  const remove = useCallback(
    (id: string) => {
      commit(leadsRef.current.filter((l) => l.id !== id));
      const pass = passRef.current;
      if (pass !== null) {
        fetch(`/api/leads?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { 'x-admin-passcode': pass },
        }).catch(() => cloudFail('Could not delete from the cloud. Try again when online.'));
      }
    },
    [commit, cloudFail],
  );

  return { leads, save, patch, remove, cloud, connect, disconnect };
}
