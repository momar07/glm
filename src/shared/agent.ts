// Call Center agent helpers: the port of MicroSIP Service/AgentUtil.h.
// No imports — shared by main, renderer and the node self-check.

export interface AgentLoginResult {
  extension: string;
  password: string;
  server: string;
  port: number;
  domain: string;
  queues: string[];
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

export type AgentServerEvent =
  | { kind: 'ping' }
  | { kind: 'state'; update: AgentStateUpdate }
  | { kind: 'pop'; pop: AgentPop }
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
    pauseReasons: strArr(r.pause_reasons) ?? [],
    token,
    timestamp: Number(r.timestamp) || 0,
    wsUrl,
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
  return { kind: 'unknown', event };
}
