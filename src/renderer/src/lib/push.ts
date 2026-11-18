import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from './platform';
import { logger } from './logger';

// Native push + call notification plumbing (Android APK only; no-ops on web).
// Phase 3 gateway contract: FCM data message { type: 'incoming',
// from: '<caller>', callId: '<id>' } → loud local notification + handler fan-out.
//
// NOTE: @capacitor/push-notifications is deliberately NOT installed until FCM
// is configured — its native side crashes on register() without
// google-services.json, killing the app on every launch. It is loaded lazily
// below so Phase 3 only needs `npm i` + sync, no code changes.
export type PushHandler = (data: Record<string, string>) => void;

const CALL_CHANNEL = 'calls';
let channeled = false;

async function ensureCallChannel(): Promise<void> {
  if (!isNative() || channeled) return;
  try {
    await LocalNotifications.createChannel({
      id: CALL_CHANNEL,
      name: 'Calls',
      importance: 5,
      vibration: true,
      visibility: 1,
    });
    channeled = true;
  } catch {
    /* older Android — default channel applies */
  }
}

export async function showCallNotification(title: string, body: string, extra?: Record<string, string>): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await ensureCallChannel();
    await LocalNotifications.requestPermissions().catch(() => undefined);
    await LocalNotifications.schedule({
      notifications: [
        {
          title,
          body,
          id: Date.now() % 2147483647,
          channelId: CALL_CHANNEL,
          ongoing: false,
          autoCancel: true,
          extra: extra ?? {},
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

// Permission preflight at register time (not call time): ensures the call
// channel exists and prompts once, so a denied state is known before the
// first incoming call instead of failing silently mid-ring.
export async function ensureNotifications(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await ensureCallChannel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await LocalNotifications.requestPermissions().catch(() => undefined);
    const granted = res?.display === 'granted';
    if (granted) logger.info('push', 'notifications granted');
    else logger.warn('push', 'notifications not granted — incoming will show in-app only');
    return granted;
  } catch (e: any) {
    logger.warn('push', `notification preflight failed: ${e?.message ?? e}`);
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPushPlugin(): Promise<any | null> {
  try {
    // Variable specifier: bundlers cannot resolve this at build time, so the
    // optional Phase-3 dependency stays a pure runtime lookup. Missing → catch.
    const id = '@capacitor/push-notifications';
    const m: any = await import(id);
    return m?.PushNotifications ?? null;
  } catch {
    return null;
  }
}

const handlers = new Set<PushHandler>();

export function onPushMessage(cb: PushHandler): () => void {
  handlers.add(cb);
  return () => {
    handlers.delete(cb);
  };
}

// Registers for FCM and fans incoming data messages out. Without the Phase-3
// plugin installed this logs once and stops — never throws, never blocks launch.
export async function initPush(): Promise<void> {
  if (!isNative()) return;
  try {
    await ensureCallChannel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PushNotifications: any | null = await getPushPlugin();
    if (!PushNotifications) {
      logger.info('push', 'FCM plugin absent — closed-phone ringing needs Phase 3');
      return;
    }
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') {
      logger.warn('push', 'FCM permission not granted — closed-phone ringing unavailable');
      return;
    }
    await PushNotifications.register();
    PushNotifications.addListener('registration', (t: { value: string }) => {
      logger.info('push', `FCM registered (token ${t.value.slice(0, 12)}… — give it to the gateway)`);
    });
    PushNotifications.addListener('registrationError', (e: { error: string }) => {
      logger.error('push', `FCM registration failed: ${e.error} (missing google-services.json?)`);
    });
    PushNotifications.addListener('pushNotificationReceived', (n: { title?: string; body?: string; data?: Record<string, string> }) => {
      const data = n.data ?? {};
      logger.info('push', `received: ${n.title ?? data.type ?? 'message'}`, data);
      if (data.type === 'incoming') {
        void showCallNotification(n.title ?? 'Incoming call', n.body ?? data.from ?? '', data);
      }
      handlers.forEach((h) => {
        try {
          h(data);
        } catch {
          /* ignore */
        }
      });
    });
    PushNotifications.addListener('pushNotificationActionPerformed', () => {
      window.focus();
    });
  } catch (e: any) {
    logger.warn('push', `init failed: ${e?.message ?? e}`);
  }
}
