// Shared types used across main, preload, and renderer processes.

import type { AgentCustomer, AgentInteraction } from './agent';

export type Presence =
  | 'offline'
  | 'connecting'
  | 'registering'
  | 'online'
  | 'on-call'
  | 'connection-lost';

export type CallDirection = 'incoming' | 'outgoing';

export type CallStatus =
  | 'idle'
  | 'ringing'
  | 'connecting'
  | 'in-call'
  | 'held'
  | 'ended'
  | 'failed';

export interface SipProfile {
  id: string;
  label: string;
  displayName: string;
  username: string;
  // ponytail: plaintext password in memory only; electron-store encryption-at-rest handles disk.
  password: string;
  sipDomain: string;
  wsUrl: string; // wss://host:port/ws
  autoWsUrl?: boolean; // derive wsUrl as wss://<sipDomain>:8089/ws instead of manual entry
  wsPort?: string; // custom WSS port for auto-fill; blank = 8089
  iceServers?: IceServerSpec[];
  preferredCodec?: string;
  dialPrefix?: string; // prepended to bare-number outbound dials (blank = disabled); never shown in logs
  autoAnswer?: boolean;
  dnd?: boolean;
}

export interface IceServerSpec {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface AudioPrefs {
  inputDeviceId?: string;
  outputDeviceId?: string;
  ringtoneDeviceId?: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  opusKbps: 16 | 32 | 48; // Opus quality: payload kbit/s (16 low, 32 balanced, 48 full)
  ringtone: 'classic' | 'digital' | 'office' | 'silent';
  ringtoneVolume: number; // 0..1
  ringtoneUri?: string; // device system ringtone (Android) — wins over synth type when set
}

export interface UiPrefs {
  theme: 'dark' | 'light';
  compact: boolean;
  showCallTimer: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  launchAtStartup: boolean;
  autoSignIn: boolean; // connect active profile automatically on app open
}

export interface SecurityPrefs {
  trustedHosts: string[]; // hosts whose self-signed/untrusted TLS certificate is accepted
}

export interface AppSettings {
  activeProfileId: string | null;
  profiles: SipProfile[];
  audio: AudioPrefs;
  ui: UiPrefs;
  security: SecurityPrefs;
  log: { level: LogLevel; retentionDays: number };
  history: { retentionDays: number }; // call log age cap in days; 0 = keep forever
  codecs: string[]; // preference order, e.g. ['opus','G722','PCMU','PCMA']
  transport: {
    reconnectionAttempts: number; // 0 = infinite
    reconnectionDelay: number; // seconds
    keepAliveInterval: number;
    ackTimer: number;
  };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

export interface CallRecord {
  id: string;
  profileId: string;
  remote: string;
  displayName?: string;
  direction: CallDirection;
  status: CallStatus;
  startedAt: number;
  endedAt?: number;
  durationSec?: number;
  reason?: string;
}

export interface Contact {
  id: string;
  name: string;
  number: string;
  group?: string;
  favorite?: boolean;
  speedDialKey?: string;
  avatarColor?: string;
  notes?: string;
}

export interface DeviceInfo {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput' | 'videoinput';
  label: string;
}

// Call Center agent (middleware) — owned by the main process, mirrored in the UI.
export type AgentStatus = 'available' | 'pause' | 'offline';

export interface AgentState {
  loggedIn: boolean;
  connected: boolean;
  extension: string;
  status: AgentStatus;
  reason: string;
  queues: string[];
  pauseReasons: string[];
  loginAtMs: number;
  statusAtMs: number;
  serverOffsetMs: number;
  error: string | null;
}

export interface AgentProfile {
  extension: string;
  password: string;
  server: string;
  port: number;
  domain: string;
}

export interface AgentLoginRequest {
  apiUrl: string;
  username: string;
  password: string;
  crmBaseUrl?: string;
}

export type AgentLoginOutcome =
  | { ok: true; state: AgentState; profile: AgentProfile }
  | { ok: false; error: string };

export interface AgentPopEvent {
  callerId: string;
  uid: string;
  isNew: boolean;
  customer: AgentCustomer | null;
  lastInteraction: AgentInteraction | null;
  receivedAt: number;
}

// IPC channel map — single source of truth for main<->preload<->renderer.
export const IPC = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_PROFILES: 'settings:profiles',
  LOG_WRITE: 'log:write',
  LOG_EXPORT: 'log:export',
  NOTIFY: 'notify:show',
  APP_QUIT: 'app:quit',
  APP_MINIMIZE: 'app:minimize',
  APP_LAUNCH_AT_STARTUP: 'app:launch-at-startup',
  DIALOG_OPEN_CSV: 'dialog:open-csv',
  DIALOG_SAVE_CSV: 'dialog:save-csv',
  TLS_TRUST_HOST: 'tls:trust-host',
  AGENT_LOGIN: 'agent:login',
  AGENT_LOGOUT: 'agent:logout',
  AGENT_STATUS: 'agent:status',
  AGENT_OPEN_RECORD: 'agent:open-record',
  AGENT_STATE: 'agent:state',
  AGENT_POP: 'agent:pop',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface NotifyOptions {
  title: string;
  body: string;
  urgency?: 'normal' | 'critical';
  silent?: boolean;
}

// Exposed via contextBridge as window.api
export interface MainApi {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  writeLog(entry: LogEntry): Promise<void>;
  exportLog(): Promise<string>;
  notify(opts: NotifyOptions): Promise<void>;
  quit(): Promise<void>;
  minimize(): Promise<void>;
  setLaunchAtStartup(enabled: boolean): Promise<void>;
  openCsv(): Promise<string | null>;
  saveCsv(defaultName: string): Promise<string | null>;
  agentLogin(req: AgentLoginRequest): Promise<AgentLoginOutcome>;
  agentLogout(): Promise<void>;
  agentSetStatus(status: 'available' | 'pause', reason: string): Promise<void>;
  agentOpenRecord(phone: string, uid: string, baseUrl?: string): Promise<void>;
  onAgentState(cb: (s: AgentState) => void): () => void;
  onAgentPop(cb: (p: AgentPopEvent) => void): () => void;
  setTrustedHost(host: string, trust: boolean): Promise<void>;
}

declare global {
  interface Window {
    api: MainApi;
  }
}
