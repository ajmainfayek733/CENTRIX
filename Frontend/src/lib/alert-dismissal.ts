import { useSyncExternalStore } from 'react';

/**
 * The bell's dismissal watermark: the server timestamp of the newest alert the operator had
 * acknowledged when they pressed "Dismiss alerts". The bell counts only alerts created after it.
 *
 * Stored per browser, not per account. The backend keeps no read-state and adding one is a schema
 * change; a watermark in localStorage answers "what is new to me, here" without inventing shared
 * state that two operators would then fight over. The value is a server timestamp (see
 * reportService.getAlertCount), so this machine's clock never enters the comparison.
 */
const STORAGE_KEY = 'centrix.alerts.dismissedBefore';
const CHANGE_EVENT = 'centrix:alerts-dismissed';

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, policy). The bell degrades to counting every open alert.
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  // `storage` covers other tabs; the custom event covers this one, where `storage` never fires.
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** ISO watermark, or null when nothing was dismissed. `undefined` never leaks out. */
export function useDismissedBefore(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** Returns false when the watermark could not be persisted, so the caller can say so. */
export function setDismissedBefore(isoTimestamp: string): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, isoTimestamp);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return true;
}
