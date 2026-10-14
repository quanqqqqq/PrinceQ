import { useEffect, useState, useSyncExternalStore, type FocusEvent, type ChangeEvent } from 'react';
import { SettingsAutosave } from '@/lib/settings-autosave';

function isTextInput(target: EventTarget | null) {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit'].includes(target.type);
}
export function useSettingsAutosave(value: unknown, valid: boolean, save: () => Promise<unknown>, enabled = true) {
  const key = JSON.stringify(value);
  const [model] = useState(() => new SettingsAutosave(key));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => { model.update(key, valid, save, enabled); }, [model, key, valid, save, enabled]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (model.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); model.leave(); };
  }, [model]);
  return {
    state, message: model.message,
    flush: () => { model.update(key, valid, save, enabled); return model.flush(); }, retry: () => model.retry(),
    reset: (next: unknown) => model.reset(JSON.stringify(next)),
    events: {
      onFocusCapture: (event: FocusEvent<HTMLElement>) => { if (isTextInput(event.target)) model.focus(true); },
      onBlurCapture: (event: FocusEvent<HTMLElement>) => { if (isTextInput(event.target)) model.focus(isTextInput(event.relatedTarget) && event.currentTarget.contains(event.relatedTarget as Node)); },
      onChangeCapture: (_event: ChangeEvent<HTMLElement>) => model.activity(),
      onPointerDownCapture: () => model.activity(),
      onKeyDownCapture: () => model.activity(),
    },
  };
}
