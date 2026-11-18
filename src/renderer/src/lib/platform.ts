// ponytail: evaluated at import time. main.tsx installs the web shim AFTER
// imports run, so this is true only under Electron preload (desktop shell).
export const isNativeShell: boolean =
  typeof window !== 'undefined' &&
  typeof (window as unknown as { api?: unknown }).api !== 'undefined';

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  if (cap?.isNativePlatform?.()) return true;
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

// True only inside the Capacitor native shell (Android APK). PWA/desktop browser → false.
export function isNative(): boolean {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
      .Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}
