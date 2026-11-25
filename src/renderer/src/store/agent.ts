import { create } from 'zustand';
import { issabelModuleUrl, parseWsUrl } from '@shared/agent';
import type { WhatsAppTicket } from '@shared/agent';
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

interface AgentStore {
  state: AgentState;
  profile: AgentProfile | null;
  pop: AgentPopEvent | null;
  whatsapp: WhatsAppBarState;
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
}

let bound = false;

export const useAgent = create<AgentStore>((set, get) => {
  const saved = loadForm();
  return {
    state: BLANK_STATE,
    profile: null,
    pop: null,
    whatsapp: BLANK_WHATSAPP,
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
      set({ state: BLANK_STATE, profile: null, pop: null, whatsapp: BLANK_WHATSAPP });
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

    // Opens the WhatsApp module inside Issabel in the system browser. The
    // module lives on the same box the agent logged into: the URL is
    // derived from the middleware base (apiUrl), never stored separately.
    async openWhatsApp() {
      const url = issabelModuleUrl(get().apiUrl);
      if (!url) {
        logger.error('agent', 'cannot derive the Issabel URL from the middleware URL');
        return;
      }
      try {
        await window.api.agentOpenWhatsApp(url);
      } catch (e) {
        logger.error('agent', `opening WhatsApp in Issabel failed: ${e instanceof Error ? e.message : e}`);
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
