// Middleware client (Call Center agent). Lives in the main process: the
// middleware sends no CORS headers and the agent token must stay a header,
// which a renderer WebSocket cannot do. The token never leaves this process.
import { shell } from 'electron';
import WebSocket from 'ws';
import {
  anchorOffset,
  dashboardUrl,
  parseAgentEvent,
  parseLoginResponse,
  pongJson,
  statusChangeJson,
  statusChanged,
  whatsAppMediaJson,
  whatsAppReplyJson,
  whatsAppStatusJson,
  whatsAppThreadJson,
  whatsAppTransferJson,
  whatsAppTransferOptionsJson,
  whatsAppUnassignJson,
  workspaceUrl,
} from '../shared/agent';
import type {
  AgentLoginOutcome,
  AgentLoginRequest,
  AgentPopEvent,
  AgentProfile,
  AgentState,
  AgentWhatsAppEvent,
  AgentWhatsAppMediaEvent,
  AgentWhatsAppResultEvent,
  AgentWhatsAppStatusEvent,
  AgentWhatsAppThreadEvent,
  AgentWhatsAppTransferEvent,
  AgentWhatsAppTransferOptionsEvent,
  AgentWhatsAppUnassignEvent,
} from '../shared/types';
import { mainLog } from './logger';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

interface Session {
  apiUrl: string;
  token: string;
  wsUrl: string;
  extension: string;
  profile: AgentProfile;
  crmBaseUrl: string;
}

function blankState(): AgentState {
  return {
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
}

export class AgentService {
  private session: Session | null = null;
  private ws: WebSocket | null = null;
  private state: AgentState = blankState();
  private intentional = false;
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private offset: number | null = null;

  constructor(
    private emitState: (s: AgentState) => void,
    private emitPop: (p: AgentPopEvent) => void,
    private emitWhatsApp: (u: AgentWhatsAppEvent) => void,
    private emitWhatsAppResult: (r: AgentWhatsAppResultEvent) => void = () => {},
    private emitWhatsAppThread: (r: AgentWhatsAppThreadEvent) => void = () => {},
    private emitWhatsAppStatus: (r: AgentWhatsAppStatusEvent) => void = () => {},
    private emitWhatsAppMedia: (r: AgentWhatsAppMediaEvent) => void = () => {},
    private emitWhatsAppTransferOptions: (r: AgentWhatsAppTransferOptionsEvent) => void = () => {},
    private emitWhatsAppTransfer: (r: AgentWhatsAppTransferEvent) => void = () => {},
    private emitWhatsAppUnassign: (r: AgentWhatsAppUnassignEvent) => void = () => {},
  ) {}

  snapshot(): AgentState {
    return this.state;
  }

  async login(req: AgentLoginRequest): Promise<AgentLoginOutcome> {
    const apiUrl = String(req.apiUrl || '').trim().replace(/\/+$/, '');
    const username = String(req.username || '').trim();
    const password = String(req.password || '');
    if (!apiUrl || !username || !password) {
      return { ok: false, error: 'Server, username and password are required' };
    }

    this.teardown();
    this.state = blankState();
    this.emitState(this.state);

    let res: Response;
    try {
      res = await fetch(`${apiUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      mainLog('warn', 'agent', `login failed: ${msg}`);
      return { ok: false, error: `Cannot reach the middleware: ${msg}` };
    }

    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON answer (proxy page, empty 502) */
    }
    if (!res.ok) {
      const err =
        body && typeof body === 'object' && 'error' in body
          ? String((body as Record<string, unknown>).error || '')
          : '';
      const msg = err || `HTTP ${res.status}`;
      mainLog('warn', 'agent', `login rejected: ${msg}`);
      return { ok: false, error: msg };
    }

    const lr = parseLoginResponse(body, apiUrl);
    if (!lr) {
      return { ok: false, error: 'The middleware answer is not a valid login (no extension/token)' };
    }

    const serverMs = lr.timestamp ? lr.timestamp * 1000 : Date.now();
    this.offset = serverMs - Date.now();
    this.session = {
      apiUrl,
      token: lr.token,
      wsUrl: lr.wsUrl,
      extension: lr.extension,
      crmBaseUrl: String(req.crmBaseUrl || '').trim(),
      profile: {
        extension: lr.extension,
        password: lr.password,
        server: lr.server,
        port: lr.port,
        domain: lr.domain,
      },
    };
    this.state = {
      loggedIn: true,
      connected: false,
      extension: lr.extension,
      status: 'available',
      reason: '',
      queues: lr.queues,
      queueNames: lr.queueNames,
      pauseReasons: lr.pauseReasons,
      loginAtMs: serverMs,
      statusAtMs: serverMs,
      serverOffsetMs: this.offset,
      error: null,
    };
    this.emitState(this.state);
    mainLog('info', 'agent', `logged in as ${username} (extension ${lr.extension})`);
    this.connect();
    return { ok: true, state: this.state, profile: this.session.profile };
  }

  async logout(): Promise<void> {
    if (this.session) this.sendRaw(statusChangeJson(this.session.extension, 'offline', ''));
    this.teardown();
    this.state = blankState();
    this.emitState(this.state);
    mainLog('info', 'agent', 'logged out');
  }

  setStatus(status: 'available' | 'pause', reason: string): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(statusChangeJson(this.session.extension, status, reason));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  // Quick reply from the WhatsApp drawer (Phase 2): rides the same
  // session socket; the middleware stamps the agent identity from the
  // session and the WhatsApp service runs its own send path. The
  // outcome comes back asynchronously as a whatsapp_reply_result.
  whatsAppReply(ticketId: number, text: string): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppReplyJson(ticketId, text));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  // Chat window (v5.24): fetch one ticket's full thread, and run its
  // status actions. Same socket, same relay pattern as the reply; the
  // answers come back as whatsapp_thread_result / whatsapp_status_result.
  whatsAppThread(ticketId: number): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppThreadJson(ticketId));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  whatsAppStatus(ticketId: number, status: string): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppStatusJson(ticketId, status));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  // Chat window Phase 3 (v5.30): media send + transfer. Same socket,
  // same relay pattern; the answers come back as
  // whatsapp_media_result / whatsapp_transfer_options_result /
  // whatsapp_transfer_result.
  whatsAppMedia(
    ticketId: number,
    file: { filename: string; mime: string; caption?: string; dataBase64: string },
  ): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppMediaJson(ticketId, file));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  whatsAppTransferOptions(ticketId: number): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppTransferOptionsJson(ticketId));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  whatsAppTransfer(ticketId: number, target: { agentId?: number; teamId?: number }): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppTransferJson(ticketId, target));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  // Chat window unassign (v5.32): supervisors only — the module
  // enforces it; the answer comes back as whatsapp_unassign_result.
  whatsAppUnassign(ticketId: number): void {
    if (!this.session) throw new Error('not logged in');
    const ok = this.sendRaw(whatsAppUnassignJson(ticketId));
    if (!ok) throw new Error('the agent socket is disconnected');
  }

  // Opens the WhatsApp module inside Issabel (system browser). The URL is
  // built by the renderer from the middleware base (issabelModuleUrl);
  // only http(s) URLs are ever handed to the shell.
  async openWhatsApp(url: string): Promise<void> {
    if (!this.session) throw new Error('not logged in');
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('invalid url');
    await shell.openExternal(u);
    mainLog('info', 'agent', 'opened the WhatsApp module in Nero');
  }

  async openRecord(phone: string, uid: string, baseUrl?: string): Promise<void> {
    if (!this.session) throw new Error('not logged in');
    const page = workspaceUrl(String(baseUrl ?? this.session.crmBaseUrl).trim(), phone, uid);
    const url = page || dashboardUrl(this.session.apiUrl, this.session.token, phone, uid);
    await shell.openExternal(url);
    mainLog('info', 'agent', `opened record ${phone}`, { dashboard: !page });
  }

  dispose(): void {
    this.teardown();
  }

  private connect(): void {
    if (!this.session) return;
    this.intentional = false;
    const { wsUrl, token } = this.session;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      mainLog('warn', 'agent', `cannot open the socket: ${e instanceof Error ? e.message : e}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.retryMs = RECONNECT_MIN_MS;
      this.update({ connected: true, error: null });
      mainLog('info', 'agent', `socket open ${wsUrl}`);
    });

    ws.on('message', (data) => {
      if (this.ws === ws) this.onMessage(String(data));
    });

    ws.on('unexpected-response', (_req, res) => {
      if (this.ws !== ws) return;
      if (res.statusCode === 401) {
        this.intentional = true;
        this.update({ connected: false, error: 'Session expired — log in again' });
        mainLog('warn', 'agent', 'socket refused: token expired');
      }
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });

    ws.on('error', (e) => {
      if (this.ws === ws) mainLog('warn', 'agent', `socket error: ${e.message}`);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.update({ connected: false });
      if (!this.intentional) this.scheduleReconnect();
    });
  }

  private onMessage(raw: string): void {
    const ev = parseAgentEvent(raw);
    if (!ev) return;
    if (ev.kind === 'ping') {
      // Two missed pongs make the middleware drop the agent from the queues.
      this.sendRaw(pongJson());
      return;
    }
    if (ev.kind === 'pop') {
      this.emitPop({ ...ev.pop, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp') {
      // Phase 1: forwarded to the renderer store as-is; the bar renders
      // it read-only (badge / toast / drawer), nothing is sent back.
      this.emitWhatsApp({ ...ev.update, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_result') {
      // Phase 2: the outcome of a quick reply sent from the drawer.
      this.emitWhatsAppResult({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_thread') {
      // Chat window: one ticket's full thread, fetched on open/refresh.
      this.emitWhatsAppThread({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_status') {
      // Chat window: the outcome of a status action.
      this.emitWhatsAppStatus({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_media') {
      // Chat window: the outcome of a media send.
      this.emitWhatsAppMedia({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_transfer_options') {
      // Chat window: the transfer menu's data.
      this.emitWhatsAppTransferOptions({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_transfer') {
      // Chat window: the outcome of a transfer.
      this.emitWhatsAppTransfer({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind === 'whatsapp_unassign') {
      // Chat window: the outcome of an unassign.
      this.emitWhatsAppUnassign({ ...ev.result, receivedAt: Date.now() });
      return;
    }
    if (ev.kind !== 'state') return;

    const u = ev.update;
    const next: AgentState = { ...this.state };
    if (u.queues) next.queues = u.queues;
    if (u.pauseReasons) next.pauseReasons = u.pauseReasons;
    if (u.timestamp) {
      this.offset = anchorOffset(this.offset, u.timestamp * 1000 - Date.now());
      next.serverOffsetMs = this.offset;
    }
    if (statusChanged(u, this.state.status, this.state.reason)) {
      if (u.hasStatus) next.status = u.status === 'pause' ? 'pause' : 'available';
      if (u.hasReason) next.reason = u.reason;
      next.statusAtMs = u.timestamp ? u.timestamp * 1000 : Date.now() + next.serverOffsetMs;
    }
    this.update(next);
  }

  private sendRaw(payload: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(payload);
      return true;
    } catch {
      // A failed send means a dead socket: drop it so the reconnect runs.
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      return false;
    }
  }

  private update(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    this.emitState(this.state);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || !this.session) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    mainLog('info', 'agent', `socket reconnect in ${delay}ms`);
  }

  private teardown(): void {
    this.intentional = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    this.session = null;
    this.retryMs = RECONNECT_MIN_MS;
    this.offset = null;
  }
}
