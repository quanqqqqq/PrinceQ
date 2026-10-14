/** Browser-local tutorial progress. This never writes workspace data or settings. */
export const ONBOARDING_STORAGE_KEY = 'princeq.onboarding.v1';
export const OPEN_ONBOARDING_EVENT = 'princeq:open-onboarding';
export type OnboardingProgress = {
  step: 0 | 1 | 2;
  phase: 'dialog' | 'configure' | 'practice' | 'done';
};
export function readOnboardingProgress(): OnboardingProgress {
  try {
    const value = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? 'null');
    if (value && [0, 1, 2].includes(value.step) && ['dialog', 'configure', 'practice', 'done'].includes(value.phase)) {
      return value as OnboardingProgress;
    }
  } catch { /* A blocked or corrupt store must not prevent entering the app. */ }
  return {step: 0, phase: 'dialog'};
}
export function saveOnboardingProgress(value: OnboardingProgress) {
  try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(value)); } catch { /* Keep this visit usable. */ }
}
export function openOnboarding() { window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT)); }
