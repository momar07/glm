// Call Center agent helpers: the port of MicroSIP Service/AgentUtil.h.
// No imports — shared by main, renderer and the node self-check.

export interface AgentLoginResult {
  extension: string;
  password: string;
  server: string;
  port: number;
  domain: string;
  queues: string[];
  queueNames: Record<string, string>;
  pauseReasons: string[];
  token: string;
  timestamp: number;
  wsUrl: string;
}

export interface AgentCustomer {
  id: number | null;
  name: string;
  tag: string;
  company: string;
  primaryPhone: string;
  secondaryPhone: string;
  category: string;
}

export interface AgentInteraction {
  disposition: string;
  notes: string;
  createdAt: string | null;
}

export interface AgentPop {
  callerId: string;
  uid: string;
  isNew: boolean;
  queueName: string;
  customer: AgentCustomer | null;
  lastInteraction: AgentInteraction | null;
}

export interface AgentStateUpdate {
  hasStatus: boolean;
  hasReason: boolean;
  status: string;
  reason: string;
  queues?: string[];
  pauseReasons?: string[];
  timestamp?: number;
}

// WhatsApp phonebar integration, Phase 1 (notify only): the middleware
// forwards the WhatsApp service's per-agent unread snapshots as
// whatsapp_update events on this same socket. The bar shows them read-only
// (badge, assignment toast, tickets drawer) — no replies, no state changes.
export interface WhatsAppTicket {
  id: number;
  contactName: string;
  phone: string;
  preview: string;
  unreadCount: number;
  status: string;
  waitingSeconds: number;
  // Chat window identity (v5.24): the line (channel account display
  // name) the conversation came in on, and the team holding it. The
  // module has no WhatsApp queues yet — when they land, the thread
  // payload carries them and the identity badge gains its queue half.
  channelName: string;
  teamName: string;
}

// The chat window's full thread (v5.24): recent history for one ticket,
// fetched over the agent socket through the middleware. Media bytes are
// inlined as base64 by the WhatsApp service (the agent's PC cannot
// reach the service directly); oversized items arrive as metadata
// only (omitted) and the window points the agent at the web UI.
export interface WhatsAppMedia {
  mime: string | null;
  filename: string | null;
  dataBase64: string | null;
  omitted: boolean;
}

export interface WhatsAppMessage {
  id: number;
  direction: string;
  senderType: string;
  type: string;
  body: string;
  status: string;
  errorDetail: string | null;
  createdAt: string;
  media: WhatsAppMedia | null;
}

export interface WhatsAppThread {
  ticket: {
    id: number;
    status: string;
    contactName: string;
    contactNumber: string;
    assignedUsername: string | null;
    unreadCount: number;
    windowOpen: boolean;
    providerType: string;
    channel: { id: number; name: string; number: string };
    team: { id: number; name: string } | null;
    queue: { id: number; name: string } | null;
  };
  messages: WhatsAppMessage[];
}

export interface WhatsAppThreadResult {
  ticketId: number;
  ok: boolean;
  thread: WhatsAppThread | null;
  error: string | null;
}

export interface WhatsAppStatusResult {
  ticketId: number;
  ok: boolean;
  status: string;
  error: string | null;
}

export interface WhatsAppSnapshot {
  kind: 'snapshot' | 'assigned';
  unreadTotal: number;
  tickets: WhatsAppTicket[];
  assignedTicket: WhatsAppTicket | null;
}

// The middleware's answer to a quick reply sent from the bar (Phase 2):
// the reply itself travelled middleware -> WhatsApp service -> the
// module's outbound queue; this is only the outcome relay.
export interface WhatsAppReplyResult {
  ticketId: number;
  ok: boolean;
  error: string | null;
}

export type AgentServerEvent =
  | { kind: 'ping' }
  | { kind: 'state'; update: AgentStateUpdate }
  | { kind: 'pop'; pop: AgentPop }
  | { kind: 'whatsapp'; update: WhatsAppSnapshot }
  | { kind: 'whatsapp_result'; result: WhatsAppReplyResult }
  | { kind: 'whatsapp_thread'; result: WhatsAppThreadResult }
  | { kind: 'whatsapp_status'; result: WhatsAppStatusResult }
  | { kind: 'unknown'; event: string };

export function parseWsUrl(
  url: string,
): { host: string; port: number; path: string; secure: boolean } | null {
  const p = url.indexOf('://');
  if (p < 0) return null;
  const scheme = url.slice(0, p).toLowerCase();
  const secure = scheme === 'wss' || scheme === 'https';
  const rest = url.slice(p + 3);
  const slash = rest.indexOf('/');
  const hostPort = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '/' : rest.slice(slash);
  const at = hostPort.lastIndexOf('@');
  const hostOnly = at < 0 ? hostPort : hostPort.slice(at + 1);
  const colon = hostOnly.indexOf(':');
  const host = colon < 0 ? hostOnly : hostOnly.slice(0, colon);
  let port = secure ? 443 : 80;
  if (colon >= 0) {
    port = Number.parseInt(hostOnly.slice(colon + 1), 10);
    if (!Number.isFinite(port) || port <= 0) return null;
  }
  return host ? { host, port, path, secure } : null;
}

// ws url of a middleware exposing its api on http(s)://host:port.
export function deriveWsUrl(apiUrl: string, wsPath = '/ws'): string {
  const u = parseWsUrl(apiUrl);
  if (!u) return '';
  const defaultPort = u.secure ? 443 : 80;
  return `${u.secure ? 'wss' : 'ws'}://${u.host}${u.port === defaultPort ? '' : `:${u.port}`}${wsPath}`;
}

export function pongJson(): string {
  return '{"event":"pong"}';
}

export function statusChangeJson(extension: string, status: string, reason: string): string {
  return JSON.stringify({ event: 'status_change', extension, status, reason });
}

// A quick reply from the WhatsApp drawer (Phase 2). The middleware
// stamps the agent identity from the session — the payload carries
// only the ticket and the text.
export function whatsAppReplyJson(ticketId: number, text: string): string {
  return JSON.stringify({ event: 'whatsapp_reply', ticket_id: ticketId, text });
}

// The chat window (v5.24) asks for one ticket's full thread, and for
// its status actions. Same trust shape as the reply: the middleware
// stamps the agent identity from the session.
export function whatsAppThreadJson(ticketId: number): string {
  return JSON.stringify({ event: 'whatsapp_thread', ticket_id: ticketId });
}

export function whatsAppStatusJson(ticketId: number, status: string): string {
  return JSON.stringify({ event: 'whatsapp_status', ticket_id: ticketId, status });
}

// The echo of our own change must not restart the status timer.
export function statusChanged(
  update: AgentStateUpdate,
  curStatus: string,
  curReason: string,
): boolean {
  if (update.hasStatus && update.status !== curStatus) return true;
  if (update.hasReason && update.reason !== curReason) return true;
  return false;
}

// Re-anchor the server clock only on a real drift: the latency of one message
// must not make the timers jump.
export function anchorOffset(current: number | null, candidate: number): number {
  if (current == null) return candidate;
  return Math.abs(candidate - current) > 1000 ? candidate : current;
}

// Strict percent encoding (encodeURIComponent leaves !'()* alone).
export function urlEncode(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else {
      for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

// The Issabel web UI lives on the same box as the middleware: same host,
// over HTTPS on the default port (the middleware apiUrl carries its own
// port, usually :8080). The WhatsApp module is a menu item inside that UI.
export function issabelModuleUrl(apiUrl: string): string {
  const u = parseWsUrl(apiUrl);
  if (!u) return '';
  return `https://${u.host}/index.php?menu=omnichannel_whatsapp`;
}

export function workspaceUrl(baseUrl: string, phone: string, uid: string): string {
  if (!baseUrl) return baseUrl;
  let out = baseUrl;
  let sep = out.includes('?') ? '&' : '?';
  if (phone) {
    out += `${sep}phone=${urlEncode(phone)}`;
    sep = '&';
  }
  if (uid) out += `${sep}uid=${urlEncode(uid)}`;
  return out;
}

export function dashboardUrl(apiUrl: string, token: string, phone: string, uid: string): string {
  let out = apiUrl.replace(/\/+$/, '');
  out += `/?token=${urlEncode(token)}`;
  if (phone) out += `&phone=${urlEncode(phone)}`;
  if (uid) out += `&uid=${urlEncode(uid)}`;
  return `${out}#crm-customers`;
}

// The last ten digits, the same rule as the middleware: one number written in
// two ways is one caller.
export function callerDigits(s: string): string {
  const digits = s.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// A number without digits never matches: a record must not bind to a wrong call.
// Pass phone numbers, never sip uris — digits of the host would match too.
export function sameCaller(a: string, b: string): boolean {
  const da = callerDigits(a);
  const db = callerDigits(b);
  return da !== '' && db !== '' && da === db;
}

// A record is only bound to a call ringing now.
export function crmPopIsFresh(at: number, now: number, maxAgeSeconds = 30): boolean {
  if (!at || !now) return false;
  const age = now - at;
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((x) => String(x)) : undefined;
}

function strMap(v: unknown): Record<string, string> | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(r)) out[k] = String(val);
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseLoginResponse(raw: unknown, apiUrl: string, wsPath = '/ws'): AgentLoginResult | null {
  const r = asRecord(raw);
  if (!r) return null;
  const extension = String(r.sip_extension ?? '').trim();
  const token = String(r.token ?? '');
  if (!extension || !token) return null;
  const server = String(r.sip_server_ip ?? '');
  const wsUrl = String(r.ws_url ?? '') || deriveWsUrl(apiUrl, wsPath);
  if (!wsUrl) return null;
  const port = Number(r.sip_server_port);
  return {
    extension,
    password: String(r.sip_password ?? ''),
    server,
    port: Number.isFinite(port) && port > 0 ? port : 5060,
    domain: String(r.sip_domain ?? '') || server,
    queues: strArr(r.assigned_queues) ?? [],
    queueNames: strMap(r.queue_names) ?? {},
    pauseReasons: strArr(r.pause_reasons) ?? [],
    token,
    timestamp: Number(r.timestamp) || 0,
    wsUrl,
  };
}

// Defensive shaping of the chat-window thread payload: the service is
// ours, but the socket is a trust boundary all the same — a malformed
// thread degrades to null (the window shows its error state), never to
// a crash.
function parseThread(v: unknown): WhatsAppThread | null {
  const t = asRecord(v);
  if (!t) return null;
  const tk = asRecord(t.ticket);
  if (!tk) return null;
  const id = Number(tk.id);
  if (!Number.isFinite(id)) return null;
  const ch = asRecord(tk.channel);
  const tm = asRecord(tk.team);
  const qu = asRecord(tk.queue);
  const parseMessage = (mv: unknown): WhatsAppMessage | null => {
    const m = asRecord(mv);
    if (!m) return null;
    const mid = Number(m.id);
    if (!Number.isFinite(mid)) return null;
    const md = asRecord(m.media);
    return {
      id: mid,
      direction: String(m.direction ?? ''),
      senderType: String(m.sender_type ?? ''),
      type: String(m.type ?? ''),
      body: String(m.body ?? ''),
      status: String(m.status ?? ''),
      errorDetail: m.error_detail != null ? String(m.error_detail) : null,
      createdAt: String(m.created_at ?? ''),
      media: md
        ? {
            mime: md.mime != null ? String(md.mime) : null,
            filename: md.filename != null ? String(md.filename) : null,
            dataBase64: md.data_base64 != null ? String(md.data_base64) : null,
            omitted: md.omitted === true,
          }
        : null,
    };
  };
  return {
    ticket: {
      id,
      status: String(tk.status ?? ''),
      contactName: String(tk.contact_name ?? ''),
      contactNumber: String(tk.contact_number ?? ''),
      assignedUsername: tk.assigned_username != null ? String(tk.assigned_username) : null,
      unreadCount: Number(tk.unread_count) || 0,
      windowOpen: tk.window_open === true,
      providerType: String(tk.provider_type ?? ''),
      channel: {
        id: ch ? Number(ch.id) || 0 : 0,
        name: ch ? String(ch.name ?? '') : '',
        number: ch ? String(ch.number ?? '') : '',
      },
      team: tm ? { id: Number(tm.id) || 0, name: String(tm.name ?? '') } : null,
      queue: qu ? { id: Number(qu.id) || 0, name: String(qu.name ?? '') } : null,
    },
    messages: Array.isArray(t.messages)
      ? t.messages.map(parseMessage).filter((m): m is WhatsAppMessage => m !== null)
      : [],
  };
}

export function parseAgentEvent(raw: string): AgentServerEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = asRecord(v);
  if (!r) return null;
  const event = String(r.event ?? '');
  if (event === 'ping') return { kind: 'ping' };
  if (event === 'state_update') {
    return {
      kind: 'state',
      update: {
        hasStatus: typeof r.status === 'string',
        hasReason: typeof r.reason === 'string',
        status: String(r.status ?? ''),
        reason: String(r.reason ?? ''),
        queues: strArr(r.assigned_queues),
        pauseReasons: strArr(r.pause_reasons),
        timestamp: typeof r.timestamp === 'number' ? r.timestamp : undefined,
      },
    };
  }
  if (event === 'crm_screen_pop') {
    const c = asRecord(r.customer);
    const li = asRecord(r.last_interaction);
    const customer: AgentCustomer | null = c
      ? {
          id: typeof c.id === 'number' ? c.id : null,
          name: String(c.full_name ?? ''),
          tag: String(c.tag ?? ''),
          company: String(c.company ?? ''),
          primaryPhone: String(c.primary_phone ?? ''),
          secondaryPhone: String(c.secondary_phone ?? ''),
          category: String(c.category_code ?? c.tag ?? ''),
        }
      : null;
    return {
      kind: 'pop',
      pop: {
        callerId: String(r.caller_number ?? r.caller_id ?? ''),
        uid: String(r.cdr_uniqueid ?? r.uniqueid ?? ''),
        isNew: Boolean(r.is_new) || !customer,
        queueName: String(r.queue_name ?? ''),
        customer,
        lastInteraction: li
          ? {
              disposition: String(li.disposition_code ?? ''),
              notes: String(li.notes ?? ''),
              createdAt: li.created_at ? String(li.created_at) : null,
            }
          : null,
      },
    };
  }
  if (event === 'whatsapp_reply_result') {
    const ticketId = Number(r.ticket_id);
    return {
      kind: 'whatsapp_result',
      result: {
        ticketId: Number.isFinite(ticketId) ? ticketId : 0,
        ok: r.ok === true,
        error: r.error != null ? String(r.error) : null,
      },
    };
  }
  if (event === 'whatsapp_thread_result') {
    const ticketId = Number(r.ticket_id);
    return {
      kind: 'whatsapp_thread',
      result: {
        ticketId: Number.isFinite(ticketId) ? ticketId : 0,
        ok: r.ok === true,
        thread: parseThread(r.thread),
        error: r.error != null ? String(r.error) : null,
      },
    };
  }
  if (event === 'whatsapp_status_result') {
    const ticketId = Number(r.ticket_id);
    return {
      kind: 'whatsapp_status',
      result: {
        ticketId: Number.isFinite(ticketId) ? ticketId : 0,
        ok: r.ok === true,
        status: String(r.status ?? ''),
        error: r.error != null ? String(r.error) : null,
      },
    };
  }
  if (event === 'whatsapp_update') {
    const parseTicket = (v: unknown): WhatsAppTicket | null => {
      const t = asRecord(v);
      if (!t) return null;
      const id = Number(t.id);
      if (!Number.isFinite(id)) return null;
      return {
        id,
        contactName: String(t.contact_name ?? ''),
        phone: String(t.phone ?? ''),
        preview: String(t.preview ?? ''),
        unreadCount: Number(t.unread_count) || 0,
        status: String(t.status ?? ''),
        waitingSeconds: Number(t.waiting_seconds) || 0,
        channelName: String(t.channel_name ?? ''),
        teamName: String(t.team_name ?? ''),
      };
    };
    const tickets = Array.isArray(r.tickets)
      ? r.tickets.map(parseTicket).filter((t): t is WhatsAppTicket => t !== null)
      : [];
    return {
      kind: 'whatsapp',
      update: {
        kind: r.kind === 'assigned' ? 'assigned' : 'snapshot',
        unreadTotal: Number(r.unread_total) || 0,
        tickets,
        assignedTicket: parseTicket(r.assigned_ticket),
      },
    };
  }
  return { kind: 'unknown', event };
}
