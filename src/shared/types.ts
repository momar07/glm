// Shared types used across main, preload, and renderer processes.

import type {
  AgentCustomer,
  AgentInteraction,
  WhatsAppThread,
  WhatsAppTicket,
  WhatsAppTransferOptions,
} from './agent';
import type { SipEngineEvent, SipHelperAnswer, SipHelperCommand } from './sipHelper';

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
  // 'native' = the pjsua helper (SIP over UDP/TCP/TLS with G.729), desktop
  // Windows only; undefined or 'webrtc' = SIP.js over WSS.
  engine?: 'webrtc' | 'native';
  sipPort?: number; // the SIP port of the native engine, 5060 by default
  transport?: 'udp' | 'tcp' | 'tls'; // the transport of the native engine
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
  queueNames: Record<string, string>;
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
  queueName: string;
  customer: AgentCustomer | null;
  lastInteraction: AgentInteraction | null;
  receivedAt: number;
}

// A whatsapp_update forwarded by the middleware (Phase 1, read-only).
export interface AgentWhatsAppEvent {
  kind: 'snapshot' | 'assigned';
  unreadTotal: number;
  tickets: WhatsAppTicket[];
  assignedTicket: WhatsAppTicket | null;
  receivedAt: number;
}

// The outcome of a quick reply sent from the bar (Phase 2), relayed by
// the middleware after the WhatsApp service accepted or refused it.
export interface AgentWhatsAppResultEvent {
  ticketId: number;
  ok: boolean;
  error: string | null;
  receivedAt: number;
}

// The chat window's thread fetch outcome (v5.24), relayed by the
// middleware after the WhatsApp service answered.
export interface AgentWhatsAppThreadEvent {
  ticketId: number;
  ok: boolean;
  thread: WhatsAppThread | null;
  error: string | null;
  receivedAt: number;
}

// The chat window's status action outcome (v5.24).
export interface AgentWhatsAppStatusEvent {
  ticketId: number;
  ok: boolean;
  status: string;
  error: string | null;
  receivedAt: number;
}

// The chat window's media send outcome (Phase 3, v5.30).
export interface AgentWhatsAppMediaEvent {
  ticketId: number;
  ok: boolean;
  error: string | null;
  receivedAt: number;
}

// The chat window's transfer outcome (Phase 3, v5.30).
export interface AgentWhatsAppTransferEvent {
  ticketId: number;
  ok: boolean;
  error: string | null;
  receivedAt: number;
}

// The chat window's unassign outcome (v5.32, supervisors only).
export interface AgentWhatsAppUnassignEvent {
  ticketId: number;
  ok: boolean;
  assignedUserId: number | null;
  error: string | null;
  receivedAt: number;
}

// The chat window's transfer menu data (Phase 3, v5.30): the module's
// agents and queues, with the ticket's current owner marked.
export interface AgentWhatsAppTransferOptionsEvent {
  ticketId: number;
  ok: boolean;
  options: WhatsAppTransferOptions | null;
  error: string | null;
  receivedAt: number;
}

// Main -> chat window: show this ticket (the window was opened or
// re-focused on a ticket from the bar's drawer).
export interface AgentWhatsAppFocusEvent {
  ticketId: number;
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
  WIN_SET_SIZE: 'win:set-size',
  APP_LAUNCH_AT_STARTUP: 'app:launch-at-startup',
  DIALOG_OPEN_CSV: 'dialog:open-csv',
  DIALOG_SAVE_CSV: 'dialog:save-csv',
  TLS_TRUST_HOST: 'tls:trust-host',
  AGENT_LOGIN: 'agent:login',
  AGENT_LOGOUT: 'agent:logout',
  AGENT_STATUS: 'agent:status',
  AGENT_OPEN_RECORD: 'agent:open-record',
  AGENT_OPEN_WHATSAPP: 'agent:open-whatsapp',
  AGENT_STATE: 'agent:state',
  AGENT_POP: 'agent:pop',
  AGENT_WHATSAPP: 'agent:whatsapp',
  AGENT_WHATSAPP_REPLY: 'agent:whatsapp-reply',
  AGENT_WHATSAPP_RESULT: 'agent:whatsapp-result',
  AGENT_WHATSAPP_THREAD: 'agent:whatsapp-thread',
  AGENT_WHATSAPP_THREAD_RESULT: 'agent:whatsapp-thread-result',
  AGENT_WHATSAPP_STATUS: 'agent:whatsapp-status',
  AGENT_WHATSAPP_STATUS_RESULT: 'agent:whatsapp-status-result',
  AGENT_WHATSAPP_MEDIA: 'agent:whatsapp-media',
  AGENT_WHATSAPP_MEDIA_RESULT: 'agent:whatsapp-media-result',
  AGENT_WHATSAPP_TRANSFER_OPTIONS: 'agent:whatsapp-transfer-options',
  AGENT_WHATSAPP_TRANSFER_OPTIONS_RESULT: 'agent:whatsapp-transfer-options-result',
  AGENT_WHATSAPP_TRANSFER: 'agent:whatsapp-transfer',
  AGENT_WHATSAPP_TRANSFER_RESULT: 'agent:whatsapp-transfer-result',
  AGENT_WHATSAPP_UNASSIGN: 'agent:whatsapp-unassign',
  AGENT_WHATSAPP_UNASSIGN_RESULT: 'agent:whatsapp-unassign-result',
  AGENT_WHATSAPP_OPEN_CHAT: 'agent:whatsapp-open-chat',
  AGENT_WHATSAPP_FOCUS: 'agent:whatsapp-focus',
  AGENT_WHATSAPP_CLOSE_CHAT: 'agent:whatsapp-close-chat',
  AGENT_WHATSAPP_MIN_CHAT: 'agent:whatsapp-min-chat',
  SIP_AVAILABLE: 'sip:available',
  SIP_COMMAND: 'sip:command',
  SIP_EVENT: 'sip:event',
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
  // Resize the frameless window so it hugs the rendered shell (bar + any
  // open drawer). Height is required; width optional (login card vs bar).
  setWindowSize(size: { width?: number; height: number }): Promise<void>;
  setLaunchAtStartup(enabled: boolean): Promise<void>;
  openCsv(): Promise<string | null>;
  saveCsv(defaultName: string): Promise<string | null>;
  agentLogin(req: AgentLoginRequest): Promise<AgentLoginOutcome>;
  agentLogout(): Promise<void>;
  agentSetStatus(status: 'available' | 'pause', reason: string): Promise<void>;
  agentOpenRecord(phone: string, uid: string, baseUrl?: string): Promise<void>;
  agentOpenWhatsApp(url: string): Promise<void>;
  agentWhatsAppReply(ticketId: number, text: string): Promise<void>;
  // The WhatsApp chat window (v5.24): a separate BrowserWindow with the
  // customer list and the full conversation. Thread/status ride the
  // agent socket through the middleware, like the quick reply.
  agentWhatsAppThread(ticketId: number): Promise<void>;
  agentWhatsAppStatus(ticketId: number, status: string): Promise<void>;
  // Phase 3 (v5.30): media sending + transfer from the chat window.
  agentWhatsAppMedia(
    ticketId: number,
    file: { filename: string; mime: string; caption?: string; dataBase64: string },
  ): Promise<void>;
  agentWhatsAppTransferOptions(ticketId: number): Promise<void>;
  agentWhatsAppTransfer(ticketId: number, target: { agentId?: number; teamId?: number }): Promise<void>;
  agentWhatsAppUnassign(ticketId: number): Promise<void>;
  agentOpenWhatsAppChat(ticketId: number): Promise<void>;
  agentCloseWhatsAppChat(): Promise<void>;
  agentMinimizeWhatsAppChat(): Promise<void>;
  onAgentState(cb: (s: AgentState) => void): () => void;
  onAgentPop(cb: (p: AgentPopEvent) => void): () => void;
  onAgentWhatsApp(cb: (u: AgentWhatsAppEvent) => void): () => void;
  onAgentWhatsAppResult(cb: (r: AgentWhatsAppResultEvent) => void): () => void;
  onAgentWhatsAppThread(cb: (r: AgentWhatsAppThreadEvent) => void): () => void;
  onAgentWhatsAppStatusResult(cb: (r: AgentWhatsAppStatusEvent) => void): () => void;
  onAgentWhatsAppMediaResult(cb: (r: AgentWhatsAppMediaEvent) => void): () => void;
  onAgentWhatsAppTransferOptions(cb: (r: AgentWhatsAppTransferOptionsEvent) => void): () => void;
  onAgentWhatsAppTransferResult(cb: (r: AgentWhatsAppTransferEvent) => void): () => void;
  onAgentWhatsAppUnassignResult(cb: (r: AgentWhatsAppUnassignEvent) => void): () => void;
  onAgentWhatsAppFocus(cb: (f: AgentWhatsAppFocusEvent) => void): () => void;
  setTrustedHost(host: string, trust: boolean): Promise<void>;
  // The native engine (the sip-helper.exe of Windows). Available only when the
  // helper was built for this install.
  sipAvailable(): Promise<boolean>;
  sipCommand(command: SipHelperCommand): Promise<SipHelperAnswer>;
  onSipEvent(cb: (e: SipEngineEvent) => void): () => void;
}

declare global {
  interface Window {
    api: MainApi;
  }
}
