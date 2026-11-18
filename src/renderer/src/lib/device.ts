import { isNative } from './platform';
import { logger } from './logger';

// Device-side features via the local System plugin (Android only).
// Everything here degrades gracefully on web/desktop.
export interface DeviceRingtone {
  title: string;
  uri: string;
}

export interface DeviceContact {
  name: string;
  number: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plugin(): any | null {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
      .Capacitor;
    return (cap?.Plugins?.System as unknown) ?? null;
  } catch {
    return null;
  }
}

function active(): boolean {
  return isNative() && plugin() != null;
}

export async function listSystemRingtones(): Promise<DeviceRingtone[]> {
  if (!active()) return [];
  try {
    const r = await plugin().listRingtones();
    const arr = r?.ringtones;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.uri === 'string')
      .map((x) => ({ title: String(x.title ?? 'Unknown'), uri: String(x.uri) }));
  } catch (e: any) {
    logger.warn('device', `list ringtones failed: ${e?.message ?? e}`);
    return [];
  }
}

export async function playSystemRingtone(uri: string): Promise<void> {
  if (!active()) return;
  try {
    await plugin().playRingtone({ uri });
  } catch (e: any) {
    logger.warn('device', `play ringtone failed: ${e?.message ?? e}`);
  }
}

export async function stopSystemRingtone(): Promise<void> {
  if (!active()) return;
  try {
    await plugin().stopRingtone();
  } catch {
    /* already stopped */
  }
}

// Resolves with the phone's contacts (system permission dialog on first use).
export async function ensurePhoneContacts(): Promise<DeviceContact[]> {
  if (!active()) return [];
  try {
    const checked = await plugin().checkContacts();
    if (!checked?.granted) await plugin().requestContacts();
    const r = await plugin().listContacts();
    const arr = r?.contacts;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.number === 'string' && x.number.trim())
      .map((x) => ({ name: String(x.name || x.number), number: String(x.number) }));
  } catch (e: any) {
    throw new Error(e?.message || 'Contacts permission denied.');
  }
}
