import { DEFAULT_SETTINGS } from '@shared/constants';
import type { AppSettings, LogEntry, MainApi, NotifyOptions } from '@shared/types';
import { isNative } from './platform';
import { showCallNotification } from './push';

// Web fallback for window.api when no desktop shell (PWA / Capacitor WebView).
// Same MainApi shape, browser-backed: settings + logs in localStorage,
// notifications via Web Notifications, CSV via direct file handling in UI.
// Phase 2 (Capacitor): route notify/filesystem through native plugins here
// behind `(window as any).Capacitor?.isNativePlatform()`.
const SETTINGS_KEY = 'glmwebrtc:web-settings';
const LOG_KEY = 'glmwebrtc:web-logs';
const MAX_LOG_LINES = 800;

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      audio: { ...DEFAULT_SETTINGS.audio, ...s.audio },
      ui: { ...DEFAULT_SETTINGS.ui, ...s.ui },
      security: { ...DEFAULT_SETTINGS.security, ...s.security },
      log: { ...DEFAULT_SETTINGS.log, ...s.log },
      transport: { ...DEFAULT_SETTINGS.transport, ...s.transport },
      history: { ...DEFAULT_SETTINGS.history, ...s.history },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

function logLine(e: LogEntry): string {
  const data = e.data != null ? ` ${safeJson(e.data)}` : '';
  return `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.scope}: ${e.msg}${data}`;
}

async function notify(opts: NotifyOptions): Promise<void> {
  // Native shell: loud call-channel notification (works from background).
  if (isNative()) {
    const shown = await showCallNotification(opts.title, opts.body);
    if (shown) return;
  }
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return;
    const n = new Notification(opts.title, { body: opts.body, silent: opts.silent });
    n.onclick = () => window.focus();
  } catch {
    /* notifications unavailable — call UI still shows state */
  }
}

export function createWebApi(): MainApi {
  return {
    getSettings: async () => loadSettings(),
    setSettings: async (patch) => {
      const next: AppSettings = { ...loadSettings(), ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* quota — keep in-memory state */
      }
      return next;
    },
    writeLog: async (entry) => {
      try {
        const raw = localStorage.getItem(LOG_KEY);
        const lines = raw ? raw.split('\n') : [];
        lines.push(logLine(entry));
        while (lines.length > MAX_LOG_LINES) lines.shift();
        localStorage.setItem(LOG_KEY, lines.join('\n'));
      } catch {
        /* ignore */
      }
    },
    exportLog: async () => {
      try {
        return localStorage.getItem(LOG_KEY) ?? '';
      } catch {
        return '';
      }
    },
    notify,
    // No-ops on web — related buttons are hidden via isNativeShell.
    quit: async () => {},
    minimize: async () => {},
    setWindowSize: async () => {},
    setLaunchAtStartup: async () => {},
    // CSV picking needs a file input; Contacts.tsx branches on isNativeShell.
    openCsv: async () => null,
    saveCsv: async () => null,
    // Agent mode talks to the middleware from the Electron main process only.
    agentLogin: async () => ({ ok: false as const, error: 'Agent mode needs the desktop app' }),
    agentLogout: async () => {},
    agentSetStatus: async () => {},
    agentOpenRecord: async () => {},
    agentOpenWhatsApp: async () => {},
    agentWhatsAppReply: async () => {},
    // The chat window is a desktop-only surface; on web these no-op.
    agentWhatsAppThread: async () => {},
    agentWhatsAppStatus: async () => {},
    agentWhatsAppMedia: async () => {},
    agentWhatsAppTransferOptions: async () => {},
    agentWhatsAppTransfer: async () => {},
    agentWhatsAppUnassign: async () => {},
    agentOpenWhatsAppChat: async () => {},
    agentCloseWhatsAppChat: async () => {},
    agentMinimizeWhatsAppChat: async () => {},
    onAgentState: () => () => {},
    onAgentPop: () => () => {},
    onAgentWhatsApp: () => () => {},
    onAgentWhatsAppResult: () => () => {},
    onAgentWhatsAppThread: () => () => {},
    onAgentWhatsAppStatusResult: () => () => {},
    onAgentWhatsAppMediaResult: () => () => {},
    onAgentWhatsAppTransferOptions: () => () => {},
    onAgentWhatsAppTransferResult: () => () => {},
    onAgentWhatsAppUnassignResult: () => () => {},
    onAgentWhatsAppFocus: () => () => {},
    setTrustedHost: async () => {},
    // The native engine is a Windows helper of the desktop app.
    sipAvailable: async () => false,
    sipCommand: async () => {
      throw new Error('The native engine needs the desktop app');
    },
    onSipEvent: () => () => {},
  };
}
