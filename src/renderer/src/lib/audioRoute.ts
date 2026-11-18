import { isNative } from './platform';
import { logger } from './logger';

// Bridge to SystemPlugin.audioRoute: real phone audio routing on Android.
// Desktop browsers manage routing themselves — every call no-ops there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plugin(): any | null {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
      .Capacitor;
    const p = (cap?.Plugins?.System as unknown) ?? null;
    if (isNative() && !p && !warnedMissing) {
      warnedMissing = true;
      logger.error('audioroute', 'native System plugin NOT registered — reinstall the APK');
    }
    return p;
  } catch {
    return null;
  }
}

let warnedMissing = false;

async function route(mode: string, speaker: boolean): Promise<void> {
  if (!isNative() || plugin() == null) return;
  try {
    await plugin().audioRoute({ mode, speaker });
    // Rare calls only (ring/call/toggle/end) — visible in Logs to verify routing.
    logger.info('audioroute', `route(${mode}, speaker=${speaker}) applied`);
  } catch (e: any) {
    logger.warn('audioroute', `route(${mode}) failed: ${e?.message ?? e}`);
  }
}

/** Incoming ringing: loud, like a real call. */
export function setRingMode(): void {
  void route('ring', true);
}

/** In-call: earpiece by default, loudspeaker when toggled. */
export function setCallMode(speaker: boolean): void {
  void route('comm', speaker);
}

/** Call over / idle: back to normal routing. */
export function setNormalAudio(): void {
  void route('normal', false);
}
