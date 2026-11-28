import React, { useEffect, useRef, useState } from 'react';
import type { WhatsAppMessage, WhatsAppTicket } from '@shared/agent';
import { useAgent } from '../store/agent';

// The WhatsApp chat window (v5.24): a separate BrowserWindow (loaded
// with ?wa=chat) holding ONE surface — the customer list on the left,
// the open conversation on the right — so agents rarely need the web
// UI. The phonebar itself is untouched by this surface. Everything
// rides the agent socket through the middleware into the WhatsApp
// module's own paths: opening a thread marks it read (assignee rule),
// replies go through the outbound queue and every guardrail, and
// status actions apply the web UI's exact rules.
//
// Identity badge: the circle beside each customer name carries the
// LINE (channel account — color + two-letter code) the conversation
// came in on, with the queue code under it, so with several WhatsApp
// lines an agent sees at a glance which line a conversation belongs
// to — like the queue badge on a call. (Queues landed in v5.25; the
// lower half falls back to the team for pre-queue tickets.)
//
// Phase 3 (v5.30): the composer can attach a photo/file (the thread
// payload advertises the Settings media cap and whether this channel
// supports media at all — unofficial only for now), and the header's
// Transfer menu hands the conversation to another agent or back to a
// queue, through the module's own transfer rules.

const CHANNEL_COLORS = ['#0d9488', '#7c3aed', '#d97706', '#2563eb', '#db2777', '#059669', '#9333ea', '#0891b2'];

function channelCode(name: string): string {
  const c = (name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return c || 'WA';
}

function channelColor(name: string): string {
  const s = name || 'WA';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CHANNEL_COLORS[h % CHANNEL_COLORS.length];
}

function lowerCode(name: string): string {
  const c = (name || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
  return c || '—';
}

function initials(name: string, phone: string): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const digits = (phone || '').replace(/\D/g, '');
  return digits ? digits.slice(-2) : 'WA';
}

function fmtTime(s: string): string {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtWaiting(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function IdentityCircle({
  channelName,
  lowerName,
  lowerCodeText,
  size,
}: {
  channelName: string;
  lowerName: string;
  // The queue's own badge code from the module (v5.25). When present
  // it is shown verbatim; otherwise the lower half is derived from the
  // queue/team name as before.
  lowerCodeText?: string;
  size: 'sm' | 'lg';
}): React.ReactElement {
  const dims = size === 'lg' ? 'w-[46px] h-[46px]' : 'w-[38px] h-[38px]';
  const title = `${channelName || 'WhatsApp'} line${lowerName ? ` · ${lowerName}` : ''}`;
  return (
    <div
      title={title}
      className={`${dims} rounded-full flex flex-col items-center justify-center shrink-0 text-white border-2 border-white/25 leading-none select-none`}
      style={{ background: channelColor(channelName) }}
    >
      <span className={size === 'lg' ? 'text-[13px] font-black' : 'text-[10px] font-black'}>
        {channelCode(channelName)}
      </span>
      <span className={size === 'lg' ? 'text-[8px] font-bold opacity-85' : 'text-[7px] font-bold opacity-85'}>
        {lowerCodeText ? lowerCodeText.toUpperCase() : lowerCode(lowerName)}
      </span>
    </div>
  );
}

function WhatsAppGlyph({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm5.2 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.4-.7-2.9-1.2-4.7-4.1-4.9-4.3-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.5c-.1.1-.3.3-.1.6.2.3.8 1.4 1.8 2.2 1.2 1.1 2.3 1.5 2.6 1.6.3.1.5.1.7-.1l1-1.2c.2-.3.4-.2.7-.1l2.1 1c.3.2.5.3.6.4 0 .1 0 .7-.2 1.2z" />
    </svg>
  );
}

function MessageMedia({ m }: { m: WhatsAppMessage }): React.ReactElement | null {
  const media = m.media;
  if (!media) return null;
  if (media.dataBase64 && media.mime) {
    const src = `data:${media.mime};base64,${media.dataBase64}`;
    if (media.mime.startsWith('image/')) {
      return <img src={src} alt={media.filename || 'image'} className="rounded-lg max-w-[240px] max-h-[180px] object-cover mb-1" />;
    }
    if (media.mime.startsWith('audio/')) {
      return <audio controls src={src} className="w-[220px] max-w-full mb-1" />;
    }
    if (media.mime.startsWith('video/')) {
      return <video controls src={src} className="rounded-lg max-w-[240px] max-h-[180px] mb-1" />;
    }
  }
  // Metadata only (too large to inline, or the file is gone): name the
  // attachment and point at the web UI, where it streams natively.
  return (
    <div className="rounded-lg bg-slate-950/40 border border-slate-600/50 px-2.5 py-2 mb-1 text-[11px] text-slate-300">
      Attachment{media.filename ? `: ${media.filename}` : ''}
      <span className="text-slate-500"> — open in Nero to view</span>
    </div>
  );
}

function MessageBubble({ m }: { m: WhatsAppMessage }): React.ReactElement {
  const out = m.direction === 'out';
  const ticks =
    m.status === 'read' || m.status === 'delivered'
      ? '✓✓'
      : m.status === 'sent'
        ? '✓'
        : m.status === 'failed'
          ? '✕'
          : '…';
  const hasMedia = !!m.media;
  const showBody = !!m.body && !(m.type !== 'text' && m.body === `[${m.type}]` && hasMedia);
  return (
    <div
      className={`max-w-[78%] px-2.5 py-2 rounded-2xl text-xs leading-relaxed shadow ${
        out
          ? 'self-end bg-[#065f46] text-emerald-50 rounded-br-md'
          : 'self-start bg-[#1e293b] border border-[#334155] text-slate-100 rounded-bl-md'
      }`}
    >
      <MessageMedia m={m} />
      {showBody ? (
        <div className="whitespace-pre-wrap break-words">{m.body}</div>
      ) : !hasMedia ? (
        <div className="whitespace-pre-wrap break-words">{m.body || `[${m.type}]`}</div>
      ) : null}
      <div
        className={`text-[9px] mt-1 text-right ${out ? 'text-emerald-300/80' : 'text-slate-500'} ${
          m.status === 'failed' ? 'text-red-300' : ''
        }`}
        title={m.status === 'failed' && m.errorDetail ? m.errorDetail : m.status}
      >
        {fmtTime(m.createdAt)} {out ? ticks : ''}
      </div>
    </div>
  );
}

export function WhatsAppChatApp(): React.ReactElement {
  const init = useAgent((s) => s.init);
  const loggedIn = useAgent((s) => s.state.loggedIn);
  const whatsapp = useAgent((s) => s.whatsapp);
  const chat = useAgent((s) => s.chat);
  const openWhatsApp = useAgent((s) => s.openWhatsApp);
  const sendWhatsAppReply = useAgent((s) => s.sendWhatsAppReply);
  const requestWhatsAppThread = useAgent((s) => s.requestWhatsAppThread);
  const setWhatsAppStatus = useAgent((s) => s.setWhatsAppStatus);
  const sendWhatsAppMedia = useAgent((s) => s.sendWhatsAppMedia);
  const requestWhatsAppTransferOptions = useAgent((s) => s.requestWhatsAppTransferOptions);
  const transferWhatsApp = useAgent((s) => s.transferWhatsApp);
  const unassignWhatsApp = useAgent((s) => s.unassignWhatsApp);
  const clearWhatsAppSelection = useAgent((s) => s.clearWhatsAppSelection);

  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sigRef = useRef<string>('');
  const prevTicketRef = useRef<number | null>(null);
  const suppressTopRef = useRef(0);

  useEffect(() => {
    init();
  }, [init]);

  const ticketId = chat.ticketId;
  const thread = ticketId != null ? chat.threads[ticketId] : undefined;
  const snapTicket: WhatsAppTicket | undefined =
    ticketId != null ? whatsapp.tickets.find((t) => t.id === ticketId) : undefined;
  const loading = ticketId != null ? !!chat.loading[ticketId] : false;
  const loadError = ticketId != null ? chat.errors[ticketId] : null;
  const replyState = ticketId != null ? whatsapp.replyStatus[ticketId] : undefined;

  // A fresh draft per conversation.
  useEffect(() => {
    setText('');
    setTransferOpen(false);
    setAttachError(null);
    sigRef.current = '';
  }, [ticketId]);

  // Clear the composer once the module accepted the reply.
  useEffect(() => {
    if (replyState?.state === 'sent') setText('');
  }, [replyState]);

  const mediaState = ticketId != null ? chat.mediaStatus[ticketId] : undefined;
  const transferOptions = ticketId != null ? chat.transferOptions[ticketId] : undefined;
  const transferBusy = ticketId != null ? !!chat.transferBusy[ticketId] : false;
  const transferError = ticketId != null ? chat.transferError[ticketId] : null;
  const transferDoneAt = ticketId != null ? chat.transferDoneAt[ticketId] : undefined;
  const unassignBusy = ticketId != null ? !!chat.unassignBusy[ticketId] : false;
  const unassignError = ticketId != null ? chat.unassignError[ticketId] : null;

  // The composer text rides as the media caption; clear it once the
  // module accepted the attachment.
  useEffect(() => {
    if (mediaState?.state === 'sent') setText('');
  }, [mediaState]);

  // Close the transfer menu once a transfer lands.
  useEffect(() => {
    if (transferDoneAt) setTransferOpen(false);
  }, [transferDoneAt]);

  // Assignment banner (v5.35): a chat that lands on this agent while
  // the window is open — above all one the sweep delivers — is
  // announced here too, not only by the bar toast, and stays until
  // opened or dismissed. The bar toast alone was missed in testing.
  const [assignBannerAt, setAssignBannerAt] = useState(0);
  useEffect(() => {
    if (whatsapp.lastAssigned && whatsapp.lastAssignedAt > 0 && whatsapp.lastAssigned.id !== ticketId) {
      setAssignBannerAt(whatsapp.lastAssignedAt);
    }
  }, [whatsapp.lastAssigned, whatsapp.lastAssignedAt, ticketId]);
  const showAssignBanner =
    !!whatsapp.lastAssigned && assignBannerAt === whatsapp.lastAssignedAt && whatsapp.lastAssigned.id !== ticketId;

  // v5.32: after the pane is zeroed by a close / unassign / transfer,
  // do not immediately auto-select the next conversation — the agent
  // picks one, or a genuinely new ticket (higher id) arrives.
  useEffect(() => {
    if (ticketId == null && prevTicketRef.current != null) {
      suppressTopRef.current = whatsapp.tickets.reduce((m, t) => Math.max(m, t.id), 0);
    }
    if (ticketId != null) suppressTopRef.current = 0;
    prevTicketRef.current = ticketId;
  }, [ticketId, whatsapp.tickets]);

  // Opened without a specific ticket (the bar's WhatsApp button):
  // land on the most recent conversation as soon as the list is in.
  useEffect(() => {
    if (ticketId == null && whatsapp.tickets.length > 0) {
      const top = whatsapp.tickets[0];
      if (suppressTopRef.current && top.id <= suppressTopRef.current) return;
      void requestWhatsAppThread(top.id);
    }
  }, [ticketId, whatsapp.tickets, requestWhatsAppThread]);

  // Backstop (v5.32): the open ticket vanished from a NON-full list
  // — it was closed or taken elsewhere — so zero the pane too. A
  // full list (10, the module's snapshot cap) is ambiguous: the
  // ticket may only have been pushed out by newer ones; leave it.
  useEffect(() => {
    if (ticketId == null || !whatsapp.seen || loading || snapTicket) return;
    if (whatsapp.tickets.length >= 10) return;
    clearWhatsAppSelection();
  }, [ticketId, whatsapp.seen, whatsapp.tickets, snapTicket, loading, clearWhatsAppSelection]);

  // Live refresh: when the snapshot says the open conversation moved
  // (new inbound, new preview, status change elsewhere), pull the
  // thread again. The fetch marks it read, so this settles instead of
  // looping.
  useEffect(() => {
    if (ticketId == null || !snapTicket || loading) return;
    const sig = `${snapTicket.unreadCount}|${snapTicket.preview}|${snapTicket.status}`;
    if (sigRef.current && sigRef.current !== sig) {
      void requestWhatsAppThread(ticketId);
    }
    sigRef.current = sig;
  }, [snapTicket, ticketId, loading, requestWhatsAppThread]);

  // Keep the newest message in view.
  const msgCount = thread?.messages.length ?? 0;
  const lastMsgId = thread?.messages[msgCount - 1]?.id ?? 0;
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgCount, lastMsgId, ticketId]);

  const tickets = whatsapp.tickets.filter((t) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      t.contactName.toLowerCase().includes(q) ||
      t.phone.toLowerCase().includes(q) ||
      t.channelName.toLowerCase().includes(q)
    );
  });

  const status = thread?.ticket.status ?? snapTicket?.status ?? 'open';
  const statusBusy = ticketId != null ? !!chat.statusBusy[ticketId] : false;
  const statusError = ticketId != null ? chat.statusError[ticketId] : null;
  const channelName = thread?.ticket.channel.name ?? snapTicket?.channelName ?? '';
  const teamName = thread?.ticket.team?.name ?? snapTicket?.teamName ?? '';
  const queueName = thread?.ticket.queue?.name ?? snapTicket?.queueName ?? '';
  const queueCode = thread?.ticket.queue?.code ?? snapTicket?.queueCode ?? '';
  const lowerName = queueName || teamName;
  const contactName = thread?.ticket.contactName || snapTicket?.contactName || snapTicket?.phone || '';
  const contactNumber = thread?.ticket.contactNumber || snapTicket?.phone || '';

  // Phase 3: what this conversation's composer may attach. The cap
  // and the unofficial-only rule come from the thread payload (the
  // module's Settings); the service enforces both again server-side.
  const mediaSupported = thread?.ticket.mediaSupported ?? false;
  const mediaMaxMb = thread?.ticket.mediaMaxMb ?? 10;

  const onFilePicked = (f: File | null): void => {
    if (!f || ticketId == null) return;
    setAttachError(null);
    if (f.size > mediaMaxMb * 1024 * 1024) {
      setAttachError(
        `That file is ${(f.size / (1024 * 1024)).toFixed(1)} MB — the limit is ${mediaMaxMb} MB.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      const dataBase64 = comma >= 0 ? url.slice(comma + 1) : '';
      if (!dataBase64) {
        setAttachError('Could not read that file.');
        return;
      }
      void sendWhatsAppMedia(ticketId, {
        filename: f.name,
        mime: f.type || 'application/octet-stream',
        caption: text.trim() || undefined,
        dataBase64,
      });
    };
    reader.onerror = () => setAttachError('Could not read that file.');
    reader.readAsDataURL(f);
  };

  const toggleTransfer = (): void => {
    if (ticketId == null) return;
    const next = !transferOpen;
    setTransferOpen(next);
    if (next) void requestWhatsAppTransferOptions(ticketId);
  };

  const doUnassign = (): void => {
    if (ticketId == null) return;
    void unassignWhatsApp(ticketId);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0f172a] text-slate-100 overflow-hidden">
      {showAssignBanner && whatsapp.lastAssigned && (
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-600/90 text-white text-[12px]">
          <span className="flex-1 truncate">
            New chat assigned to you: {whatsapp.lastAssigned.contactName || whatsapp.lastAssigned.phone}
          </span>
          <button
            type="button"
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 font-semibold"
            onClick={() => {
              setAssignBannerAt(0);
              if (whatsapp.lastAssigned) void requestWhatsAppThread(whatsapp.lastAssigned.id);
            }}
          >
            Open
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/25"
            onClick={() => setAssignBannerAt(0)}
          >
            ×
          </button>
        </div>
      )}
      {/* Window frame bar (drag region) */}
      <div className="app-drag h-11 shrink-0 flex items-center gap-2 px-4 bg-[#1e293b] border-b border-[#334155] select-none">
        <WhatsAppGlyph className="w-4.5 h-4.5 w-[18px] h-[18px] text-emerald-400" />
        <span className="text-xs font-extrabold">WhatsApp</span>
        <span className="text-[11px] text-slate-400 font-semibold">— Nero</span>
        <div className="ml-auto flex items-center gap-1.5 app-no-drag">
          <button
            onClick={() => void window.api.agentMinimizeWhatsAppChat()}
            className="w-7 h-7 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-600/60 text-slate-300 text-xs flex items-center justify-center transition"
            title="Minimize"
          >
            –
          </button>
          <button
            onClick={() => void window.api.agentCloseWhatsAppChat()}
            className="w-7 h-7 rounded-full bg-slate-800 hover:bg-rose-500/25 border border-slate-600/60 text-slate-300 hover:text-rose-300 text-xs flex items-center justify-center transition"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {!loggedIn ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <WhatsAppGlyph className="w-10 h-10 text-emerald-500/60 mx-auto mb-3" />
            <div className="text-sm font-bold text-slate-300">Not logged in</div>
            <div className="text-xs text-slate-500 mt-1">Log in from the phonebar to use the WhatsApp chat window.</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Customer list — left */}
          <div className="w-[292px] shrink-0 border-r border-[#334155] bg-[#111c30] flex flex-col min-h-0">
            <div className="p-3 pb-1">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations…"
                className="w-full rounded-full bg-[#1e293b] border border-[#334155] text-xs text-slate-200 px-3 py-2 outline-none focus:border-emerald-400/60 placeholder:text-slate-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {tickets.length === 0 && (
                <div className="text-slate-500 text-xs p-3">No open WhatsApp tickets</div>
              )}
              {tickets.map((t) => {
                const selected = t.id === ticketId;
                return (
                  <div
                    key={t.id}
                    onClick={() => void requestWhatsAppThread(t.id)}
                    className={`flex items-center gap-2.5 p-2.5 mt-1.5 rounded-2xl border cursor-pointer transition ${
                      selected
                        ? 'bg-[#1e293b] border-emerald-400/60 ring-1 ring-emerald-400/40'
                        : 'border-transparent hover:bg-[#1e293b]/60'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-teal-900 text-teal-200 text-[11px] font-extrabold flex items-center justify-center shrink-0">
                      {initials(t.contactName, t.phone)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-white truncate">{t.contactName || t.phone}</span>
                        {t.unreadCount > 0 ? (
                          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-extrabold flex items-center justify-center shrink-0">
                            {t.unreadCount}
                          </span>
                        ) : t.waitingSeconds > 0 ? (
                          <span className="text-[9px] text-slate-500 shrink-0">{fmtWaiting(t.waitingSeconds)}</span>
                        ) : null}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">{t.preview || t.phone}</div>
                    </div>
                    <IdentityCircle channelName={t.channelName} lowerName={t.queueName || t.teamName} lowerCodeText={t.queueCode || undefined} size="sm" />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Conversation — right */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {ticketId == null ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="text-center">
                  <WhatsAppGlyph className="w-10 h-10 text-emerald-500/50 mx-auto mb-3" />
                  <div className="text-sm font-bold text-slate-300">Select a conversation</div>
                  <div className="text-xs text-slate-500 mt-1">Pick a customer from the list to open the full chat here.</div>
                </div>
              </div>
            ) : (
              <>
                <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-[#1e293b]">
                  <div className="w-8 h-8 rounded-full bg-teal-900 text-teal-200 text-[11px] font-extrabold flex items-center justify-center shrink-0">
                    {initials(contactName, contactNumber)}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-extrabold text-white truncate">{contactName}</div>
                    <div className="text-[10px] text-slate-400 font-mono truncate">{contactNumber}</div>
                    <div className="text-[10px] text-sky-300 font-bold truncate">
                      {channelName ? `${channelName} line` : ''}
                      {queueName ? ` · ${queueName} queue` : teamName ? ` · ${teamName} team` : ''}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2.5 shrink-0">
                    <IdentityCircle channelName={channelName} lowerName={lowerName} lowerCodeText={queueCode || undefined} size="lg" />
                    <select
                      value={status}
                      disabled={statusBusy}
                      onChange={(e) =>
                        void setWhatsAppStatus(ticketId, e.target.value as 'open' | 'pending' | 'closed')
                      }
                      className="bg-[#1e293b] border border-[#475569] text-amber-300 text-[11px] font-extrabold rounded-full px-2.5 py-1.5 outline-none cursor-pointer disabled:opacity-50"
                      title="Ticket status"
                    >
                      {status === 'new' && (
                        <option value="new" disabled>
                          New
                        </option>
                      )}
                      <option value="open">Open</option>
                      <option value="pending">Waiting</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                </div>
                <div className="relative shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[#1e293b]">
                  <button
                    onClick={() => void openWhatsApp()}
                    className="px-3 py-1.5 rounded-full bg-[#1e293b] border border-sky-500/60 text-sky-300 text-[11px] font-bold hover:bg-slate-700 transition"
                  >
                    Open in Nero ↗
                  </button>
                  <button
                    onClick={toggleTransfer}
                    disabled={status === 'closed'}
                    className="px-3 py-1.5 rounded-full bg-[#1e293b] border border-violet-500/60 text-violet-300 text-[11px] font-bold hover:bg-slate-700 transition disabled:opacity-40"
                    title={status === 'closed' ? 'This ticket is closed' : 'Transfer this conversation'}
                  >
                    Transfer ⇄
                  </button>
                  {thread?.ticket.canUnassign && thread?.ticket.assignedUsername && status !== 'closed' && (
                    <button
                      onClick={doUnassign}
                      disabled={unassignBusy}
                      className="px-3 py-1.5 rounded-full bg-[#1e293b] border border-amber-500/60 text-amber-300 text-[11px] font-bold hover:bg-slate-700 transition disabled:opacity-40"
                      title="Return this conversation to its queue (supervisors only)"
                    >
                      {unassignBusy ? 'Unassigning…' : 'Unassign'}
                    </button>
                  )}
                  {statusError && <span className="text-[11px] text-red-300">{statusError}</span>}
                  {unassignError && <span className="text-[11px] text-red-300">{unassignError}</span>}
                  {thread?.ticket.assignedUsername && (
                    <span className="text-[10px] text-slate-500 ml-auto">
                      Assigned: {thread.ticket.assignedUsername}
                    </span>
                  )}
                  {transferOpen && (
                    <div className="absolute left-4 top-full z-20 mt-1 w-[264px] max-h-[320px] overflow-y-auto rounded-2xl bg-[#1e293b] border border-[#475569] shadow-2xl p-2">
                      <div className="text-[10px] font-extrabold text-slate-400 px-2 py-1">TRANSFER TO</div>
                      {transferError && (
                        <div className="text-[11px] text-red-300 px-2 py-1">{transferError}</div>
                      )}
                      {transferBusy && (
                        <div className="text-[11px] text-slate-400 px-2 py-1">Transferring…</div>
                      )}
                      {!transferOptions && !transferError && (
                        <div className="text-[11px] text-slate-400 px-2 py-1">Loading targets…</div>
                      )}
                      {transferOptions && (
                        <>
                          {transferOptions.agents.length > 0 && (
                            <div className="text-[9px] font-bold text-slate-500 px-2 pt-1.5">AGENTS</div>
                          )}
                          {transferOptions.agents.map((a) => (
                            <button
                              key={'a' + a.uid}
                              disabled={transferBusy || a.uid === transferOptions.currentAgent}
                              onClick={() => void transferWhatsApp(ticketId, { agentId: a.uid })}
                              className="w-full text-left px-2 py-1.5 rounded-lg text-[12px] text-slate-200 hover:bg-slate-700/70 transition disabled:opacity-40"
                            >
                              {a.uname}
                              {a.uid === transferOptions.currentAgent && (
                                <span className="text-slate-500 text-[10px]"> · current</span>
                              )}
                            </button>
                          ))}
                          {transferOptions.teams.length > 0 && (
                            <div className="text-[9px] font-bold text-slate-500 px-2 pt-2">QUEUES</div>
                          )}
                          {transferOptions.teams.map((t) => (
                            <button
                              key={'q' + t.id}
                              disabled={transferBusy || t.id === transferOptions.currentTeam}
                              onClick={() => void transferWhatsApp(ticketId, { teamId: t.id })}
                              className="w-full text-left px-2 py-1.5 rounded-lg text-[12px] text-slate-200 hover:bg-slate-700/70 transition disabled:opacity-40 flex items-center gap-2"
                            >
                              <span className="flex-1 truncate">{t.name}</span>
                              {t.code && (
                                <span className="text-[9px] font-extrabold text-emerald-300 bg-emerald-500/15 border border-emerald-500/40 rounded px-1 py-0.5">
                                  {t.code}
                                </span>
                              )}
                              {t.id === transferOptions.currentTeam && (
                                <span className="text-slate-500 text-[10px]">current</span>
                              )}
                            </button>
                          ))}
                          {transferOptions.agents.length === 0 && transferOptions.teams.length === 0 && (
                            <div className="text-[11px] text-slate-400 px-2 py-1">No transfer targets</div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2 bg-[#0b1220]">
                  {loading && !thread && <div className="text-slate-500 text-xs m-auto">Loading conversation…</div>}
                  {loadError && !thread && (
                    <div className="m-auto text-center">
                      <div className="text-red-300 text-xs font-bold">{loadError}</div>
                      <button
                        onClick={() => void requestWhatsAppThread(ticketId)}
                        className="mt-2 px-3 py-1.5 rounded-full bg-[#1e293b] border border-[#334155] text-slate-200 text-[11px] font-bold"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {thread && thread.messages.length === 0 && (
                    <div className="text-slate-500 text-xs m-auto">No messages yet</div>
                  )}
                  {thread?.messages.map((m) => <MessageBubble key={m.id} m={m} />)}
                </div>

                <div className="shrink-0 flex items-end gap-2 px-3 py-2.5 border-t border-[#1e293b]">
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      onFilePicked(e.target.files && e.target.files[0] ? e.target.files[0] : null);
                      e.target.value = '';
                    }}
                  />
                  <button
                    disabled={!mediaSupported || mediaState?.state === 'sending'}
                    onClick={() => fileRef.current?.click()}
                    title={
                      mediaSupported
                        ? `Attach a photo or file (max ${mediaMaxMb} MB) — the message text goes as its caption`
                        : 'Media sending works on unofficial channels for now'
                    }
                    className="w-8 h-8 rounded-full bg-[#1e293b] border border-[#334155] text-slate-300 text-sm flex items-center justify-center shrink-0 hover:bg-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (text.trim() && replyState?.state !== 'sending') {
                          void sendWhatsAppReply(ticketId, text);
                        }
                      }
                    }}
                    rows={1}
                    placeholder="Type a reply… (Enter to send, Shift+Enter for a new line)"
                    className="flex-1 rounded-2xl bg-[#1e293b] border border-[#334155] text-white text-xs px-3 py-2.5 outline-none focus:border-emerald-400/60 resize-none max-h-[90px]"
                  />
                  <button
                    onClick={() => void sendWhatsAppReply(ticketId, text)}
                    disabled={!text.trim() || replyState?.state === 'sending'}
                    className="px-4 py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-extrabold transition shrink-0"
                  >
                    Send
                  </button>
                </div>
                <div className="shrink-0 px-4 pb-2 -mt-0.5 min-h-[14px]">
                  {replyState?.state === 'sending' && <span className="text-[10px] text-slate-400">Sending…</span>}
                  {replyState?.state === 'sent' && (
                    <span className="text-[10px] text-emerald-300">Queued for sending ✓</span>
                  )}
                  {replyState?.state === 'error' && (
                    <span className="text-[10px] text-red-300">{replyState.error}</span>
                  )}
                  {mediaState?.state === 'sending' && (
                    <span className="text-[10px] text-slate-400"> Sending attachment…</span>
                  )}
                  {mediaState?.state === 'sent' && (
                    <span className="text-[10px] text-emerald-300"> Attachment queued ✓</span>
                  )}
                  {mediaState?.state === 'error' && (
                    <span className="text-[10px] text-red-300"> {mediaState.error}</span>
                  )}
                  {attachError && <span className="text-[10px] text-red-300"> {attachError}</span>}
                  {thread && !mediaSupported && (
                    <span className="text-[10px] text-slate-500">
                      {' '}
                      Media sending works on unofficial channels for now.
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
