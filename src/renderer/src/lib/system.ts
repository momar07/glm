import { isNative } from './platform';
import { logger } from './logger';

// Bridge to the local System plugin (android/.../SystemPlugin.java):
// battery-exemption intents + foreground call service. Absent on web — no-ops.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plugin(): any | null {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
      .Capacitor;
    const p = (cap?.Plugins?.System as unknown) ?? null;
    // A missing System plugin on native means MainActivity registration broke —
    // every call below would silently no-op. Say so once, loudly.
    if (isNative() && !p && !warnedMissing) {
      warnedMissing = true;
      logger.error('system', 'native System plugin NOT registered — reinstall the APK');
    }
    return p;
  } catch {
    return null;
  }
}

let warnedMissing = false;

function active(): boolean {
  return isNative() && plugin() != null;
}

export async function isIgnoringBattery(): Promise<boolean | null> {
  if (!active()) return null;
  try {
    const r = await plugin().isIgnoringBattery();
    return !!r?.ignoring;
  } catch (e: any) {
    logger.warn('system', `battery check failed: ${e?.message ?? e}`);
    return null;
  }
}

export async function requestBatteryExemption(): Promise<void> {
  if (!active()) return;
  try {
    await plugin().requestBatteryExemption();
  } catch (e: any) {
    logger.warn('system', `battery request failed: ${e?.message ?? e}`);
  }
}

export async function startCallService(): Promise<void> {
  if (!active()) return;
  try {
    await plugin().startCallService();
    logger.info('system', 'foreground call service started');
  } catch (e: any) {
    logger.warn('system', `call service start failed: ${e?.message ?? e}`);
  }
}

export async function stopCallService(): Promise<void> {
  if (!active()) return;
  try {
    await plugin().stopCallService();
  } catch {
    /* already stopped */
  }
}

// Ear sensor: blanks the screen while the phone is at the ear (native only).
// No-op on sensor-less devices and on web.
export async function proximityOn(): Promise<void> {
  if (!active()) return;
  try {
    await plugin().proximityOn();
  } catch (e: any) {
    logger.warn('system', `proximity on failed: ${e?.message ?? e}`);
  }
}

export async function proximityOff(): Promise<void> {
  if (!active()) return;
  try {
    await plugin().proximityOff();
  } catch {
    /* already released */
  }
}

// Microphone preflight: resolve when granted, throw a human message otherwise.
// getUserMedia without this rejects (NotAllowedError, sometimes messageless),
// which surfaces downstream as a bare "invite failed".
export async function ensureMic(): Promise<void> {
  if (!active()) return; // desktop browser prompts on its own
  try {
    const checked = await plugin().checkMic();
    if (checked?.granted) return;
    await plugin().requestMic();
  } catch (e: any) {
    throw new Error(e?.message || 'Microphone permission denied.');
  }
}
