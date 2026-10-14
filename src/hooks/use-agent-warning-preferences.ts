import { useMemo, useSyncExternalStore } from 'react';

const KEY = 'princeq.dismissed-agent-warnings.v1';
const EVENT = 'princeq:agent-warning-preferences';
let volatileSnapshot: string | null = null;
function snapshot() {
  if (volatileSnapshot !== null) return volatileSnapshot;
  try { return localStorage.getItem(KEY) ?? '[]'; } catch { return '[]'; }
}
function parse(raw: string): Set<string> {
  try {
    const values: unknown = JSON.parse(raw);
    return new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : []);
  } catch { return new Set(); }
}
function subscribe(listener: () => void) {
  const external = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) { volatileSnapshot = null; listener(); }
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener('storage', external);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', external); };
}
export function useAgentWarningPreferences() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => '[]');
  const dismissed = useMemo(() => parse(raw), [raw]);
  return {dismissed, dismiss: (code: string) => {
    // Only informational model mapping notices are dismissible; execution errors stay visible.
    if (code !== 'model_config_warning') return;
    const next = parse(snapshot()); next.add(code);
    const serialized = JSON.stringify([...next].sort());
    try { localStorage.setItem(KEY, serialized); volatileSnapshot = null; }
    catch { volatileSnapshot = serialized; }
    window.dispatchEvent(new Event(EVENT));
  }};
}
