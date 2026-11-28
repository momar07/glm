import { create } from 'zustand';
import { issabelModuleUrl, parseWsUrl } from '@shared/agent';
import type { WhatsAppThread, WhatsAppTicket, WhatsAppTransferOptions } from '@shared/agent';
import type { AgentPopEvent, AgentProfile, AgentState } from '@shared/types';
import { logger } from '../lib/logger';
import { useSip } from './sip';

const FORM_KEY = 'glmwebrtc:agent-form';

const BLANK_STATE: AgentState = {
  loggedIn: false,
  connected: false,
  extension: '',
  status: 'offline',
  reason: '',
  queues: [],
  queueNames: {},
  pauseReasons: [],
  loginAtMs: 0,
  statusAtMs: 0,
  serverOffsetMs: 0,
  error: null,
};

export interface AgentLoginForm {
  apiUrl: string;
  username: string;
  password: string;
  crmBaseUrl: string;
  trustCert: boolean;
  serverIp: string;
  saveCredentials: boolean;
  autoLogin: boolean;
  webrtc: boolean;
}

interface SavedForm {
  apiUrl: string;
  serverIp: string;
  username: string;
  // Only stored when saveCredentials is on; '' otherwise.
  password: string;
  crmBaseUrl: string;
  trustCert: boolean;
  webrtc: boolean;
  saveCredentials: boolean;
  autoLogin: boolean;
}

export interface AgentPrefsPatch {
  serverIp?: string;
  username?: string;
  crmBaseUrl?: string;
  trustCert?: boolean;
  webrtc?: boolean;
  saveCredentials?: boolean;
  autoLogin?: boolean;
}

// The Server IP field shows just what the agent typed; older saves only
// have the full middleware URL, so derive the field value from it
// (strip the scheme and the default :8080 port).
function deriveServerIp(apiUrl: string): string {
  return apiUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .replace(/:8080$/, '');
}

function loadForm(): SavedForm {
  const fallback: SavedForm = {
    apiUrl: 'http://192.168.2.22:8080',
    serverIp: '',
    username: '',
    password: '',
    crmBaseUrl: '',
    trustCert: true,
    webrtc: false,
    saveCredentials: false,
    autoLogin: false,
  };
  try {
    const raw = localStorage.getItem(FORM_KEY);
    const merged = raw ? { ...fallback, ...(JSON.parse(raw) as Partial<SavedForm>) } : fallback;
    if (!merged.serverIp && merged.apiUrl) merged.serverIp = deriveServerIp(merged.apiUrl);
    // A stored password only makes sense while saving is on.
    if (!merged.saveCredentials) {
      merged.password = '';
      merged.autoLogin = false;
    }
    return merged;
  } catch {
    return { ...fallback, serverIp: deriveServerIp(fallback.apiUrl) };
  }
}

function saveForm(f: SavedForm): void {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(f));
  } catch {
    /* quota */
  }
}

// WhatsApp phonebar state. `seen` stays false until the first
// whatsapp_update arrives in this session. Since Phase 2 the bar's
// WhatsApp button is permanent (the badge and drawer fill in when the
// first snapshot lands — the middleware requests one at login), so
// `seen` now only records whether any snapshot has ever arrived.
export interface WhatsAppBarState {
  seen: boolean;
  unreadTotal: number;
  tickets: WhatsAppTicket[];
  lastAssigned: WhatsAppTicket | null;
  lastAssignedAt: number;
  // Phase 2: per-ticket quick-reply outcome, keyed by ticket id. The
  // 'sending' state is set locally; 'sent'/'error' arrive with the
  // middleware's whatsapp_reply_result.
  replyStatus: Record<number, { state: 'sending' | 'sent' | 'error'; error?: string; at: number }>;
}

const BLANK_WHATSAPP: WhatsAppBarState = {
  seen: false,
  unreadTotal: 0,
  tickets: [],
  lastAssigned: null,
  lastAssignedAt: 0,
  replyStatus: {},
};

// Chat window state (v5.24). The chat window is a separate renderer
// with its own copy of this store; the bar's copy simply never opens
// the window surface. Threads are fetched per ticket over the agent
// socket and cached here; opening a thread marks it read server-side.
export interface WhatsAppChatState {
  ticketId: number | null;
  threads: Record<number, WhatsAppThread>;
  loading: Record<number, boolean>;
  errors: Record<number, string | null>;
  statusBusy: Record<number, boolean>;
  statusError: Record<number, string | null>;
  // Phase 3 (v5.30): media send outcome per ticket, and the transfer
  // menu's data + outcome per ticket.
  mediaStatus: Record<number, { state: 'sending' | 'sent' | 'error'; error?: string; at: number }>;
  transferOptions: Record<number, WhatsAppTransferOptions | null>;
  transferBusy: Record<number, boolean>;
  transferError: Record<number, string | null>;
  transferDoneAt: Record<number, number>;
}

const BLANK_CHAT: WhatsAppChatState = {
  ticketId: null,
  threads: {},
  loading: {},
  errors: {},
  statusBusy: {},
  statusError: {},
  mediaStatus: {},
  transferOptions: {},
  transferBusy: {},
  transferError: {},
  transferDoneAt: {},
};

interface AgentStore {
  state: AgentState;
  profile: AgentProfile | null;
  pop: AgentPopEvent | null;
  whatsapp: WhatsAppBarState;
  chat: WhatsAppChatState;
  apiUrl: string;
  serverIp: string;
  crmBaseUrl: string;
  username: string;
  trustCert: boolean;
  savedPassword: string;
  webrtc: boolean;
  saveCredentials: boolean;
  autoLogin: boolean;
  loggingIn: boolean;
  loginError: string | null;
  actionError: string | null;
  init: () => void;
  updatePrefs: (p: AgentPrefsPatch) => void;
  login: (form: AgentLoginForm) => Promise<boolean>;
  logout: () => Promise<void>;
  setStatus: (status: 'available' | 'pause', reason: string) => Promise<void>;
  clearPop: () => void;
  openRecord: (phone: string, uid: string) => Promise<void>;
  openWhatsApp: () => Promise<void>;
  sendWhatsAppReply: (ticketId: number, text: string) => Promise<void>;
  openWhatsAppChat: (ticketId: number) => Promise<void>;
  requestWhatsAppThread: (ticketId: number) => Promise<void>;
  setWhatsAppStatus: (ticketId: number, status: 'open' | 'pending' | 'closed') => Promise<void>;
  sendWhatsAppMedia: (
    ticketId: number,
    file: { filename: string; mime: string; caption?: string; dataBase64: string },
  ) => Promise<void>;
  requestWhatsAppTransferOptions: (ticketId: number) => Promise<void>;
  transferWhatsApp: (ticketId: number, target: { agentId?: number; teamId?: number }) => Promise<void>;
}

let bound = false;

export const useAgent = create<AgentStore>((set, get) => {
  const saved = loadForm();
  return {
    state: BLANK_STATE,
    profile: null,
    pop: null,
    whatsapp: BLANK_WHATSAPP,
    chat: BLANK_CHAT,
    apiUrl: saved.apiUrl,
    serverIp: saved.serverIp,
    crmBaseUrl: saved.crmBaseUrl,
    username: saved.username,
    trustCert: saved.trustCert,
    savedPassword: saved.password,
    webrtc: saved.webrtc,
    saveCredentials: saved.saveCredentials,
    autoLogin: saved.autoLogin,
    loggingIn: false,
    loginError: null,
    actionError: null,

    init() {
      if (bound) return;
      bound = true;
      window.api.onAgentState((s) => set({ state: s }));
      window.api.onAgentPop((p) => {
        set({ pop: p });
        logger.info('agent', `CRM pop for ${p.callerId}${p.isNew ? ' (new caller)' : ''}`);
      });
      window.api.onAgentWhatsApp((u) => {
        set((cur) => ({
          whatsapp: {
            ...cur.whatsapp,
            seen: true,
            unreadTotal: u.unreadTotal,
            tickets: u.tickets,
            lastAssigned:
              u.kind === 'assigned' && u.assignedTicket ? u.assignedTicket : cur.whatsapp.lastAssigned,
            lastAssignedAt:
              u.kind === 'assigned' && u.assignedTicket ? u.receivedAt : cur.whatsapp.lastAssignedAt,
          },
        }));
        logger.info('agent', `WhatsApp update: ${u.unreadTotal} unread across ${u.tickets.length} tickets`);
      });
      window.api.onAgentWhatsAppResult((r) => {
        set((cur) => ({
          whatsapp: {
            ...cur.whatsapp,
            replyStatus: {
              ...cur.whatsapp.replyStatus,
              [r.ticketId]: {
                state: r.ok ? 'sent' : 'error',
                error: r.ok ? undefined : r.error || 'Send failed',
                at: r.receivedAt,
              },
            },
          },
        }));
        logger.info('agent', `WhatsApp reply for ticket ${r.ticketId}: ${r.ok ? 'queued' : 'failed'}`);
      });
      window.api.onAgentWhatsAppThread((r) => {
        set((cur) => ({
          chat: {
            ...cur.chat,
            loading: { ...cur.chat.loading, [r.ticketId]: false },
            errors: {
              ...cur.chat.errors,
              [r.ticketId]: r.ok ? null : r.error || 'Could not load the conversation',
            },
            threads:
              r.ok && r.thread ? { ...cur.chat.threads, [r.ticketId]: r.thread } : cur.chat.threads,
          },
        }));
        if (!r.ok) logger.error('agent', `WhatsApp thread ${r.ticketId} failed: ${r.error || 'unknown'}`);
      });
      window.api.onAgentWhatsAppStatusResult((r) => {
        set((cur) => {
          const th = cur.chat.threads[r.ticketId];
          return {
            chat: {
              ...cur.chat,
              statusBusy: { ...cur.chat.statusBusy, [r.ticketId]: false },
              statusError: {
                ...cur.chat.statusError,
                [r.ticketId]: r.ok ? null : r.error || 'Status change failed',
              },
              threads:
                r.ok && th
                  ? { ...cur.chat.threads, [r.ticketId]: { ...th, ticket: { ...th.ticket, status: r.status } } }
                  : cur.chat.threads,
            },
            whatsapp: r.ok
              ? {
                  ...cur.whatsapp,
                  tickets: cur.whatsapp.tickets.map((t) =>
                    t.id === r.ticketId ? { ...t, status: r.status } : t,
                  ),
                }
              : cur.whatsapp,
          };
        });
        logger.info('agent', `WhatsApp status for ticket ${r.ticketId}: ${r.ok ? r.status : 'failed'}`);
      });
      window.api.onAgentWhatsAppMediaResult((r) => {
        set((cur) => ({
          chat: {
            ...cur.chat,
            mediaStatus: {
              ...cur.chat.mediaStatus,
              [r.ticketId]: {
                state: r.ok ? 'sent' : 'error',
                error: r.ok ? undefined : r.error || 'Media send failed',
                at: r.receivedAt,
              },
            },
          },
        }));
        logger.info('agent', `WhatsApp media for ticket ${r.ticketId}: ${r.ok ? 'queued' : 'failed'}`);
        // The service also pushes a fresh snapshot, whose preview
        // change refetches the open thread — but pull it directly too
        // when this window has the ticket open, so the attachment
        // shows up even if the preview text did not change.
        if (r.ok && get().chat.ticketId === r.ticketId) {
          void get().requestWhatsAppThread(r.ticketId);
        }
      });
      window.api.onAgentWhatsAppTransferOptions((r) => {
        set((cur) => ({
          chat: {
            ...cur.chat,
            transferOptions: {
              ...cur.chat.transferOptions,
              [r.ticketId]: r.ok ? r.options : cur.chat.transferOptions[r.ticketId],
            },
            transferError: {
              ...cur.chat.transferError,
              [r.ticketId]: r.ok ? cur.chat.transferError[r.ticketId] : r.error || 'Could not load transfer targets',
            },
          },
        }));
        if (!r.ok) logger.error('agent', `WhatsApp transfer options ${r.ticketId} failed: ${r.error || 'unknown'}`);
      });
      window.api.onAgentWhatsAppTransferResult((r) => {
        set((cur) => ({
          chat: {
            ...cur.chat,
            transferBusy: { ...cur.chat.transferBusy, [r.ticketId]: false },
            transferError: {
              ...cur.chat.transferError,
              [r.ticketId]: r.ok ? null : r.error || 'Transfer failed',
            },
            transferDoneAt: r.ok
              ? { ...cur.chat.transferDoneAt, [r.ticketId]: r.receivedAt }
              : cur.chat.transferDoneAt,
          },
        }));
        logger.info('agent', `WhatsApp transfer for ticket ${r.ticketId}: ${r.ok ? 'done' : 'failed'}`);
        // A transferred ticket usually leaves this agent (or comes
        // back via the queue): refresh the open thread if it is still
        // ours; the snapshot settles the list either way.
        if (r.ok && get().chat.ticketId === r.ticketId) {
          void get().requestWhatsAppThread(r.ticketId);
        }
      });
      window.api.onAgentWhatsAppFocus((f) => {
        // The main process opened (or re-focused) the chat window on
        // this ticket: select it and pull its thread.
        void get().requestWhatsAppThread(f.ticketId);
      });
    },

    updatePrefs(p) {
      const cur = get();
      // Auto login needs a saved password: turning Save off clears the
      // stored password and forces Auto off with it.
      const saveCredentials = p.saveCredentials ?? cur.saveCredentials;
      const autoLogin = saveCredentials ? (p.autoLogin ?? cur.autoLogin) : false;
      const savedPassword = saveCredentials ? cur.savedPassword : '';
      const next = {
        serverIp: p.serverIp ?? cur.serverIp,
        username: p.username ?? cur.username,
        crmBaseUrl: p.crmBaseUrl ?? cur.crmBaseUrl,
        trustCert: p.trustCert ?? cur.trustCert,
        webrtc: p.webrtc ?? cur.webrtc,
        saveCredentials,
        autoLogin,
        savedPassword,
      };
      set(next);
      saveForm({
        apiUrl: cur.apiUrl,
        serverIp: next.serverIp,
        username: next.username,
        password: savedPassword,
        crmBaseUrl: next.crmBaseUrl,
        trustCert: next.trustCert,
        webrtc: next.webrtc,
        saveCredentials,
        autoLogin,
      });
    },

    async login(form) {
      set({ loggingIn: true, loginError: null, actionError: null });
      const apiUrl = form.apiUrl.trim();
      const host = parseWsUrl(apiUrl)?.host ?? '';
      try {
        if (host) await window.api.setTrustedHost(host, form.trustCert);
        const out = await window.api.agentLogin({
          apiUrl,
          username: form.username.trim(),
          password: form.password,
          crmBaseUrl: form.crmBaseUrl.trim(),
        });
        if (!out.ok) {
          set({ loginError: out.error });
          return false;
        }
        // The password is only persisted when the agent asked to save
        // credentials; with saving off any stored password is cleared.
        const savedPassword = form.saveCredentials ? form.password : '';
        const autoLogin = form.saveCredentials && form.autoLogin;
        saveForm({
          apiUrl,
          serverIp: form.serverIp,
          username: form.username.trim(),
          password: savedPassword,
          crmBaseUrl: form.crmBaseUrl.trim(),
          trustCert: form.trustCert,
          webrtc: form.webrtc,
          saveCredentials: form.saveCredentials,
          autoLogin,
        });
        set({
          state: out.state,
          profile: out.profile,
          pop: null,
          whatsapp: BLANK_WHATSAPP,
          chat: BLANK_CHAT,
          apiUrl,
          serverIp: form.serverIp,
          username: form.username.trim(),
          crmBaseUrl: form.crmBaseUrl.trim(),
          trustCert: form.trustCert,
          savedPassword,
          webrtc: form.webrtc,
          saveCredentials: form.saveCredentials,
          autoLogin,
        });
        logger.info('agent', `logged in as ${out.profile.extension}`);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ loginError: msg });
        logger.error('agent', `login failed: ${msg}`);
        return false;
      } finally {
        set({ loggingIn: false });
      }
    },

    async logout() {
      set({ actionError: null });
      // the SIP registration of the agent goes with the agent session
      await useSip.getState().disconnect().catch(() => {});
      await window.api.agentLogout().catch(() => {});
      set({ state: BLANK_STATE, profile: null, pop: null, whatsapp: BLANK_WHATSAPP, chat: BLANK_CHAT });
      logger.info('agent', 'logged out');
    },

    async setStatus(status, reason) {
      try {
        await window.api.agentSetStatus(status, reason);
        set({ actionError: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ actionError: msg });
        logger.error('agent', `status change failed: ${msg}`);
      }
    },

    clearPop() {
      set({ pop: null });
    },

    // Opens the WhatsApp module inside Nero in the system browser. The
    // module lives on the same box the agent logged into: the URL is
    // derived from the middleware base (apiUrl), never stored separately.
    async openWhatsApp() {
      const url = issabelModuleUrl(get().apiUrl);
      if (!url) {
        logger.error('agent', 'cannot derive the Nero URL from the middleware URL');
        return;
      }
      try {
        await window.api.agentOpenWhatsApp(url);
      } catch (e) {
        logger.error('agent', `opening WhatsApp in Nero failed: ${e instanceof Error ? e.message : e}`);
      }
    },

    // Opens (or re-focuses) the separate WhatsApp chat window on a
    // ticket. The window itself pulls the thread once it is focused.
    async openWhatsAppChat(ticketId) {
      try {
        await window.api.agentOpenWhatsAppChat(ticketId);
      } catch (e) {
        logger.error('agent', `opening the WhatsApp chat window failed: ${e instanceof Error ? e.message : e}`);
      }
    },

    // Selects a ticket in the chat window and pulls its full thread.
    // Opening marks it read server-side (assignee rule), so the badge
    // snapshot that follows already shows it cleared.
    async requestWhatsAppThread(ticketId) {
      set((cur) => ({
        chat: {
          ...cur.chat,
          ticketId,
          loading: { ...cur.chat.loading, [ticketId]: true },
          errors: { ...cur.chat.errors, [ticketId]: null },
        },
      }));
      try {
        await window.api.agentWhatsAppThread(ticketId);
        // The thread itself arrives via onAgentWhatsAppThread.
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not load the conversation';
        set((cur) => ({
          chat: {
            ...cur.chat,
            loading: { ...cur.chat.loading, [ticketId]: false },
            errors: { ...cur.chat.errors, [ticketId]: msg },
          },
        }));
      }
    },

    async setWhatsAppStatus(ticketId, status) {
      set((cur) => ({
        chat: {
          ...cur.chat,
          statusBusy: { ...cur.chat.statusBusy, [ticketId]: true },
          statusError: { ...cur.chat.statusError, [ticketId]: null },
        },
      }));
      try {
        await window.api.agentWhatsAppStatus(ticketId, status);
        // The outcome arrives via onAgentWhatsAppStatusResult.
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Status change failed';
        set((cur) => ({
          chat: {
            ...cur.chat,
            statusBusy: { ...cur.chat.statusBusy, [ticketId]: false },
            statusError: { ...cur.chat.statusError, [ticketId]: msg },
          },
        }));
      }
    },

    // Phase 3 (v5.30): attach a photo/file to the conversation. The
    // file already passed the window's size check against the cap the
    // thread payload advertised; the service enforces it again.
    async sendWhatsAppMedia(ticketId, file) {
      set((cur) => ({
        chat: {
          ...cur.chat,
          mediaStatus: { ...cur.chat.mediaStatus, [ticketId]: { state: 'sending', at: Date.now() } },
        },
      }));
      try {
        await window.api.agentWhatsAppMedia(ticketId, file);
        // The outcome arrives via onAgentWhatsAppMediaResult.
      } catch (e) {
        set((cur) => ({
          chat: {
            ...cur.chat,
            mediaStatus: {
              ...cur.chat.mediaStatus,
              [ticketId]: {
                state: 'error',
                error: e instanceof Error ? e.message : 'Media send failed',
                at: Date.now(),
              },
            },
          },
        }));
      }
    },

    async requestWhatsAppTransferOptions(ticketId) {
      try {
        await window.api.agentWhatsAppTransferOptions(ticketId);
        // The options arrive via onAgentWhatsAppTransferOptions.
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not load transfer targets';
        set((cur) => ({
          chat: { ...cur.chat, transferError: { ...cur.chat.transferError, [ticketId]: msg } },
        }));
      }
    },

    async transferWhatsApp(ticketId, target) {
      set((cur) => ({
        chat: {
          ...cur.chat,
          transferBusy: { ...cur.chat.transferBusy, [ticketId]: true },
          transferError: { ...cur.chat.transferError, [ticketId]: null },
        },
      }));
      try {
        await window.api.agentWhatsAppTransfer(ticketId, target);
        // The outcome arrives via onAgentWhatsAppTransferResult.
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Transfer failed';
        set((cur) => ({
          chat: {
            ...cur.chat,
            transferBusy: { ...cur.chat.transferBusy, [ticketId]: false },
            transferError: { ...cur.chat.transferError, [ticketId]: msg },
          },
        }));
      }
    },

    async sendWhatsAppReply(ticketId, text) {
      const body = text.trim();
      if (!body) return;
      set((cur) => ({
        whatsapp: {
          ...cur.whatsapp,
          replyStatus: { ...cur.whatsapp.replyStatus, [ticketId]: { state: 'sending', at: Date.now() } },
        },
      }));
      try {
        await window.api.agentWhatsAppReply(ticketId, body);
        // The outcome itself arrives via onAgentWhatsAppResult.
      } catch (e) {
        set((cur) => ({
          whatsapp: {
            ...cur.whatsapp,
            replyStatus: {
              ...cur.whatsapp.replyStatus,
              [ticketId]: {
                state: 'error',
                error: e instanceof Error ? e.message : 'Send failed',
                at: Date.now(),
              },
            },
          },
        }));
      }
    },

    async openRecord(phone, uid) {
      try {
        await window.api.agentOpenRecord(phone, uid, get().crmBaseUrl);
      } catch (e) {
        logger.error('agent', `opening the record failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  };
});

// Server-clock timers: the wall clock may be wrong, the offset comes from the middleware.
export function agentNow(state: AgentState): number {
  return Date.now() + state.serverOffsetMs;
}
