import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { createMoneyFormatter } from '../utils/money.js';
import { useAuth } from './AuthContext.jsx';

const SettingsContext = createContext(null);

export const DEFAULT_SETTINGS = {
  event_name: 'School Bazaar',
  currency_code: 'EGP',
  locale: 'en-EG',
  timezone: 'Africa/Cairo',
  low_stock_default: 5,
  receipt_header: '',
  receipt_footer: 'Thank you for supporting our school!',
  receipt_show_cashier: true,
};

export function SettingsProvider({ children }) {
  const { status } = useAuth();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [sections, setSections] = useState([]);

  const load = useCallback(async () => {
    if (status !== 'ready') {
      // before sign-in only the public, non-sensitive info is available
      const { data } = await supabase.rpc('public_app_info');
      if (data) setSettings((s) => ({ ...s, ...data }));
      return;
    }
    const [{ data: s }, { data: secs }] = await Promise.all([
      supabase.from('app_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('sections').select('*').order('sort_order'),
    ]);
    if (s) setSettings({ ...DEFAULT_SETTINGS, ...s });
    if (secs) setSections(secs);
  }, [status]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const value = useMemo(() => {
    const money = createMoneyFormatter(settings);
    return {
      settings,
      sections,
      money,
      tz: settings.timezone,
      dateOpts: { locale: settings.locale, timeZone: settings.timezone },
      reload: load,
    };
  }, [settings, sections, load]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
