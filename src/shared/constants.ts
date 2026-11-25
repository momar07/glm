import type { AppSettings, LogLevel } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  activeProfileId: null,
  profiles: [],
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    opusKbps: 32,
    ringtone: 'classic',
    ringtoneVolume: 0.6,
  },
  ui: {
    theme: 'dark',
    compact: false,
    showCallTimer: true,
    minimizeToTray: false,
    startMinimized: false,
    launchAtStartup: false,
    autoSignIn: true,
  },
  security: { trustedHosts: [] },
  log: { level: 'info', retentionDays: 7 },
  history: { retentionDays: 1 }, // call log age cap; 0 = keep forever
  codecs: ['opus', 'telephone-event'], // opus-only default: ~32kbps+DTX vs ~87kbps G.711; stored prefs win on upgrade
  transport: {
    reconnectionAttempts: 0,
    reconnectionDelay: 4,
    keepAliveInterval: 25,
    ackTimer: 30,
  },
};

export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const CODEC_LABELS: Record<string, string> = {
  opus: 'Opus',
  G729: 'G.729',
  G722: 'G.722',
  PCMU: 'PCMU (ulaw)',
  PCMA: 'PCMA (alaw)',
  GSM: 'GSM',
  'telephone-event': 'DTMF (telephone-event)',
};

export function genId(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function formatDuration(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function normalizeSipUri(input: string, domain: string): string {
  const s = input.trim();
  if (s.startsWith('sip:')) return s;
  if (s.includes('@')) return `sip:${s}`;
  // strip non-dialable chars, keep +, digits, *, #
  const cleaned = s.replace(/[^\d*#+]/g, '');
  return `sip:${cleaned}@${domain}`;
}

export function safePhone(input: string): string {
  return input.replace(/[^\d*#+]/g, '');
}

// Timestamp coercion for stored records — older builds may hold date strings
// or garbage. Returns epoch ms, or 0 when unparseable (sorts last, pruned first).
export function historyTs(v: unknown): number {
  const n = typeof v === 'number' ? v : Date.parse(v as string);
  return Number.isFinite(n) ? (n as number) : 0;
}
