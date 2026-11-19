import { create } from 'zustand';
import { parseWsUrl } from '@shared/agent';
import type { AgentPopEvent, AgentProfile, AgentState } from '@shared/types';
import { logger } from '../lib/logger';

const FORM_KEY = 'glmwebrtc:agent-form';

const BLANK_STATE: AgentState = {
  loggedIn: false,
  connected: false,
  extension: '',
  status: 'offline',
  reason: '',
  queues: [],
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
}

interface SavedForm {
  apiUrl: string;
  username: string;
  crmBaseUrl: string;
  trustCert: boolean;
}

function loadForm(): SavedForm {
  const fallback: SavedForm = {
    apiUrl: 'http://192.168.2.22:8080',
    username: '',
    crmBaseUrl: '',
    trustCert: true,
  };
  try {
    const raw = localStorage.getItem(FORM_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<SavedForm>) } : fallback;
  } catch {
    return fallback;
  }
}

function saveForm(f: SavedForm): void {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(f));
  } catch {
    /* quota */
  }
}

interface AgentStore {
  state: AgentState;
  profile: AgentProfile | null;
  pop: AgentPopEvent | null;
  apiUrl: string;
  crmBaseUrl: string;
  username: string;
  trustCert: boolean;
  loggingIn: boolean;
  loginError: string | null;
  actionError: string | null;
  init: () => void;
  login: (form: AgentLoginForm) => Promise<boolean>;
  logout: () => Promise<void>;
  setStatus: (status: 'available' | 'pause', reason: string) => Promise<void>;
  clearPop: () => void;
  openRecord: (phone: string, uid: string) => Promise<void>;
}

let bound = false;

export const useAgent = create<AgentStore>((set, get) => {
  const saved = loadForm();
  return {
    state: BLANK_STATE,
    profile: null,
    pop: null,
    apiUrl: saved.apiUrl,
    crmBaseUrl: saved.crmBaseUrl,
    username: saved.username,
    trustCert: saved.trustCert,
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
        saveForm({
          apiUrl,
          username: form.username.trim(),
          crmBaseUrl: form.crmBaseUrl.trim(),
          trustCert: form.trustCert,
        });
        set({
          state: out.state,
          profile: out.profile,
          pop: null,
          apiUrl,
          username: form.username.trim(),
          crmBaseUrl: form.crmBaseUrl.trim(),
          trustCert: form.trustCert,
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
      await window.api.agentLogout().catch(() => {});
      set({ state: BLANK_STATE, profile: null, pop: null });
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
