import { App as CapApp } from '@capacitor/app';
import { isNative } from './platform';

// Fires cb when the app returns to foreground or regains network. Debounced —
// some platforms emit both a resume event and visibilitychange for one return,
// and network switches can flap online/offline in pairs.
export function onForeground(cb: () => void): () => void {
  let last = 0;
  let capSub: { remove: () => Promise<void> } | null = null;
  const fire = (): void => {
    const now = Date.now();
    if (now - last < 3000) return;
    last = now;
    cb();
  };
  if (isNative()) {
    CapApp.addListener('resume', fire)
      .then((s) => {
        capSub = s;
      })
      .catch(() => {});
  }
  const onVis = (): void => {
    if (document.visibilityState === 'visible') fire();
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', fire);
  window.addEventListener('offline', fire);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('online', fire);
    window.removeEventListener('offline', fire);
    void capSub?.remove().catch(() => {});
  };
}
