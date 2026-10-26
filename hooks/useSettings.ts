'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_TEMPLATE } from '@/lib/message';
import type { Settings } from '@/lib/types';

const KEY = 'lbf.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  myName: '',
  myBusiness: '',
  template: DEFAULT_TEMPLATE,
  passcode: '',
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) });
    } catch {
      /* ignore unreadable storage */
    }
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage full or blocked */
      }
      return next;
    });
  }, []);

  return { settings, update };
}
