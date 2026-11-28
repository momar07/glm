import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatDuration, safePhone } from '@shared/constants';
import { crmPopIsFresh, sameCaller } from '@shared/agent';
import { useSip } from '../store/sip';
import { useCall } from '../store/call';
import { useAgent, agentNow } from '../store/agent';
import { useSettings } from '../store/settings';
import { useContacts } from '../store/contacts';
import { useDialer } from './Dialpad';
import { Settings } from './Settings';
import { Logs } from './Logs';
import { Contacts } from './Contacts';
import { audioManager } from '../audio/AudioManager';

type Drawer =
  | 'keypad'
  | 'queues'
  | 'logs'
  | 'contacts'
  | 'transfer'
  | 'settings'
  | 'applogs'
  | 'contactsFull'
  | 'whatsapp'
  | null;

const KEYS: { d: string; sub: string }[] = [
  { d: '1', sub: '' },
  { d: '2', sub: 'ABC' },
  { d: '3', sub: 'DEF' },
  { d: '4', sub: 'GHI' },
  { d: '5', sub: 'JKL' },
  { d: '6', sub: 'MNO' },
  { d: '7', sub: 'PQRS' },
  { d: '8', sub: 'TUV' },
  { d: '9', sub: 'WXYZ' },
  { d: '*', sub: '' },
  { d: '0', sub: '+' },
  { d: '#', sub: '' },
];

function fmtHMS(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function numberOf(remote: string): string {
  return remote.replace(/^sip:/, '').split('@')[0];
}

// Floating "dynamic island" phonebar: the slim pill is the primary shell.
// Idle it carries agent identity/status/queues + drawer toggles; during a
// call it morphs into the active-call bar. Everything else (keypad, queues,
// logs, contacts, transfer) unfolds as a drawer directly under the bar.
// All state comes from the existing stores — no SIP logic lives here.
export function PhoneBar({
  onFitRequest,
}: {
  // Imperative window-fit (App's useWindowFit.fitNow): measures the shell
  // and issues the resize IPC synchronously. Called from layout effects so
  // the window is sized BEFORE an overlay panel paints — no flicker.
  onFitRequest?: () => void;
}): React.ReactElement {
  const presence = useSip((s) => s.presence);
  const disconnect = useSip((s) => s.disconnect);
  const settings = useSettings((s) => s.settings);
  const calls = useCall((s) => s.calls);
  const currentId = useCall((s) => s.currentId);
  const history = useCall((s) => s.history);
  const hangup = useCall((s) => s.hangup);
  const hold = useCall((s) => s.hold);
  const resume = useCall((s) => s.resume);
  const toggleMute = useCall((s) => s.toggleMute);
  const sendDtmf = useCall((s) => s.sendDtmf);
  const blindTransfer = useCall((s) => s.blindTransfer);
  const makeCall = useCall((s) => s.makeCall);
  const agent = useAgent((s) => s.state);
  const agentSetStatus = useAgent((s) => s.setStatus);
  const chatPaused = useAgent((s) => s.chatPaused);
  const setChatPaused = useAgent((s) => s.setChatPaused);
  const agentLogout = useAgent((s) => s.logout);
  const pop = useAgent((s) => s.pop);
  const whatsapp = useAgent((s) => s.whatsapp);
  const openWhatsApp = useAgent((s) => s.openWhatsApp);
  const openWhatsAppChat = useAgent((s) => s.openWhatsAppChat);
  const sendWhatsAppReply = useAgent((s) => s.sendWhatsAppReply);
  const contacts = useContacts((s) => s.contacts);

  const [drawer, setDrawer] = useState<Drawer>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  // Two-phase open for the status dropdown: the panel first mounts hidden
  // (statusPeek) so the window can be resized to its final height before
  // it ever paints; one frame later it becomes visible (statusOpen) and
  // animates in. Painting it immediately inside the still-bar-height
  // window was the 1-frame transparent flicker.
  const [statusPeek, setStatusPeek] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [contactQ, setContactQ] = useState('');
  const [dtmfDigits, setDtmfDigits] = useState('');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [waToast, setWaToast] = useState(false);
  // WhatsApp quick reply (Phase 2): the selected ticket in the drawer
  // and the draft typed for it. The draft clears when the ticket is
  // switched or when the middleware confirms the send.
  const [waSel, setWaSel] = useState<number | null>(null);
  const [waText, setWaText] = useState('');
  useEffect(() => {
    if (waSel != null && whatsapp.replyStatus[waSel]?.state === 'sent') setWaText('');
  }, [whatsapp.replyStatus, waSel]);
  const selectWaTicket = (id: number): void => {
    setWaSel((cur) => (cur === id ? null : id));
    setWaText('');
  };
  const [now, setNow] = useState(Date.now());

  // WhatsApp assignment toast: appears when the store stamps a NEW
  // assignment (lastAssignedAt changes) and STAYS until the agent
  // clicks it (opens the chat) or dismisses it — since v5.35 an
  // assignment must never slip by unnoticed (a swept chat was lost
  // to a 6-second auto-dismiss). No focus steal; the ref guard keeps
  // re-renders from re-toasting. Since v5.37 the toast also CHIMES
  // (the bar window only — the chat window shares the store but must
  // not double the sound), unless the agent turned the sound off.
  const waToastSeenRef = useRef(0);
  useEffect(() => {
    if (!whatsapp.lastAssigned || whatsapp.lastAssignedAt <= 0) return;
    if (whatsapp.lastAssignedAt === waToastSeenRef.current) return;
    waToastSeenRef.current = whatsapp.lastAssignedAt;
    setWaToast(true);
    if (settings.audio.whatsappSound !== false) audioManager.playNotification();
  }, [whatsapp.lastAssigned, whatsapp.lastAssignedAt, settings.audio.whatsappSound]);

  // The toast is a fixed overlay like the logout card: fit the window to
  // it in a layout effect, and shrink back the frame it disappears.
  useLayoutEffect(() => {
    onFitRequest?.();
  }, [waToast, onFitRequest]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const call =
    calls.find((c) => c.id === currentId && c.status !== 'ended' && c.status !== 'failed') ??
    calls.find((c) => c.status === 'in-call' || c.status === 'held');
  const inCall = !!call && (call.status === 'in-call' || call.status === 'held');
  const ringingOut =
    !!call && call.direction === 'outgoing' && (call.status === 'ringing' || call.status === 'connecting');
  const showActiveBar = inCall || ringingOut;

  // The dialer keyboard listener must only be live while its drawer is open
  // (CallsPage owns a dialer of its own; two live listeners would double-dial).
  const dialer = useDialer(drawer === 'keypad' && !inCall);

  useEffect(() => {
    if (!inCall) setDtmfDigits('');
  }, [inCall]);

  const profile = settings.profiles.find((p) => p.id === settings.activeProfileId);
  const agentPaused = agent.loggedIn && agent.status === 'pause';
  const displayName = agent.loggedIn
    ? profile?.displayName || `Agent ${agent.extension}`
    : profile?.displayName || profile?.label || profile?.username || 'Softphone';
  const extLabel = agent.loggedIn ? agent.extension : profile?.username || '';

  const ledClass = agentPaused
    ? 'status-led-amber'
    : presence === 'online' || presence === 'on-call'
      ? 'status-led-green'
      : presence === 'connection-lost'
        ? 'status-led-rose'
        : 'status-led-slate';

  const statusLabel = agent.loggedIn
    ? agentPaused
      ? agent.reason || 'Paused'
      : 'Available'
    : presence === 'on-call'
      ? 'On Call'
      : presence === 'online'
        ? 'Online'
        : presence === 'connection-lost'
          ? 'Connection Lost'
          : presence;

  // Split pause (v5.35): with chats paused and voice live, the pill
  // says so outright (it is short enough for the fixed-width pill);
  // a voice pause keeps its reason — the menu shows both states.
  const statusText =
    chatPaused && agent.loggedIn && !agentPaused ? 'Chats paused' : statusLabel;

  const statusSecs =
    agent.loggedIn && agent.statusAtMs > 0
      ? Math.max(0, Math.round((agentNow(agent) - agent.statusAtMs) / 1000))
      : 0;

  const statusOptions: { value: string; label: string; hint: string; amber: boolean }[] = [
    { value: 'available', label: 'Available', hint: 'Ready', amber: false },
    ...agent.pauseReasons.map((r) => ({ value: r, label: r, hint: 'Paused', amber: true })),
  ];

  const pickStatus = (v: string): void => {
    setStatusOpen(false);
    setStatusPeek(false);
    if (v === 'available') void agentSetStatus('available', '');
    else void agentSetStatus('pause', v);
  };

  const toggleStatus = (): void => {
    if (!agent.loggedIn) return;
    if (statusOpen || statusPeek) {
      setStatusOpen(false);
      setStatusPeek(false);
    } else {
      // Mount hidden first; the layout effect below sizes the window,
      // then the panel is revealed next frame.
      setStatusPeek(true);
    }
  };

  // Size-before-show: while the dropdown is mounted-but-hidden, measure it
  // and issue the window resize synchronously (layout effect = before
  // paint), then reveal it on the next animation frame — by then the
  // resize IPC has reached the main process, so the panel never paints
  // inside a too-short window.
  useLayoutEffect(() => {
    if (!statusPeek || statusOpen) return;
    onFitRequest?.();
    const raf = requestAnimationFrame(() => {
      setStatusOpen(true);
      setStatusPeek(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [statusPeek, statusOpen, onFitRequest]);

  // Same-frame shrink/grow for closes and drawer switches: run the fit in
  // a layout effect (after the DOM update, before paint) instead of
  // waiting for the fit hook's observer round-trip, so closing the
  // dropdown or a drawer shrinks the window in the same frame the panel
  // disappears — no lingering transparent gap, no second step.
  const prevLayoutRef = useRef<{ open: boolean; drawer: Drawer }>({ open: false, drawer: null });
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = { open: statusOpen, drawer };
    if ((prev.open && !statusOpen) || prev.drawer !== drawer) onFitRequest?.();
  }, [statusOpen, drawer, onFitRequest]);

  const toggleDrawer = (d: Exclude<Drawer, null>): void => {
    setDrawer((cur) => (cur === d ? null : d));
    setStatusOpen(false);
    setStatusPeek(false);
  };

  const logout = (): void => {
    setLogoutOpen(true);
  };

  const confirmLogout = (): void => {
    setLogoutOpen(false);
    if (agent.loggedIn) void agentLogout();
    else void disconnect();
  };

  // The logout card is a fixed overlay (the same positioning pattern as
  // the incoming-call panel): fit in a layout effect so the window is
  // already sized to the card when it paints, and shrinks back the same
  // frame the card closes — no flicker, no second step.
  useLayoutEffect(() => {
    onFitRequest?.();
  }, [logoutOpen, onFitRequest]);

  // Escape cancels the logout card, like clicking the backdrop.
  useEffect(() => {
    if (!logoutOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLogoutOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [logoutOpen]);

  const dialNumber = (num: string): void => {
    if (!num) return;
    void makeCall(num).catch((e: any) => alert(`Call failed: ${e?.message ?? e}`));
    setDrawer(null);
  };

  const elapsed =
    call?.connectedAt && inCall ? Math.floor((now - call.connectedAt) / 1000) : 0;
  // Caller identity for the active-call bar (design D). Real sources only,
  // in order: the CRM screen pop matched to this call by caller number (the
  // same freshness + sameCaller match the VIP tag already used), the SIP
  // display name carried on the session, then a contacts match by number.
  const remoteNumber = call ? numberOf(call.remote) : '';
  const matchedPop =
    call && pop && crmPopIsFresh(pop.receivedAt, Date.now()) && sameCaller(pop.callerId, remoteNumber)
      ? pop
      : undefined;
  const callerTag = matchedPop?.customer?.tag;
  const contactName = call
    ? contacts.find((c) => sameCaller(c.number, remoteNumber))?.name
    : undefined;
  const callerName = matchedPop?.customer?.name || call?.displayName || contactName || '';
  const callerInitials = ((): string => {
    const parts = callerName.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return callerName.slice(0, 2).toUpperCase();
  })();
  // Agent initials for the logout card avatar, same rule as the caller's.
  const agentInitials = ((): string => {
    const parts = displayName.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return displayName.slice(0, 2).toUpperCase();
  })();
  // Queue attribution: the middleware sends the queue NAME with the CRM
  // screen pop (queue_name, resolved from the queue's description), and
  // matchedPop is already matched to this call by caller id — that name
  // wins. Fallback for pops without a queue: the agent's assigned queues
  // (login / state_update), shown only when attribution is unambiguous —
  // an incoming call while the agent is assigned to exactly one queue.
  const popQueueName = matchedPop?.queueName?.trim() ? matchedPop.queueName.trim() : undefined;
  const queueLabel =
    popQueueName ??
    (call && call.direction === 'incoming' && agent.loggedIn && agent.queues.length === 1
      ? agent.queues[0]
      : undefined);

  const dtmf = (d: string): void => {
    if (!call) return;
    audioManager.playDtmf(d);
    setDtmfDigits((v) => v + d);
    void sendDtmf(call.id, d);
  };

  const doTransfer = (): void => {
    if (!call || !transferTarget.trim()) return;
    void blindTransfer(call.id, transferTarget.trim());
    setTransferTarget('');
    setDrawer(null);
  };

  const filteredContacts = contacts
    .filter(
      (c) =>
        !contactQ.trim() ||
        c.name.toLowerCase().includes(contactQ.trim().toLowerCase()) ||
        c.number.includes(contactQ.trim()),
    )
    .slice(0, 12);

  const toggleBtnCls = (active: boolean): string =>
    `w-7 h-7 rounded-full flex items-center justify-center transition ${
      active
        ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40'
        : 'hover:bg-white/10 text-slate-300'
    }`;

  return (
    <div className="relative z-40 w-full flex flex-col items-center">
      {/* ======================= THE BAR ======================= */}
      <div className="app-drag w-full max-w-[740px] rounded-full bg-[#0f172a]/95 backdrop-blur-2xl border border-[#1e293b] px-3.5 py-1.5">
        {showActiveBar && call ? (
          /* ---------- ACTIVE CALL STATE ---------- */
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="flex items-center gap-2 min-w-0 pr-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-500 to-indigo-500 flex items-center justify-center text-[11px] font-extrabold text-white shrink-0">
                {callerName ? (
                  callerInitials
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24 11.4 11.4 0 003.57.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1.02l-2.2 2.2z" />
                  </svg>
                )}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[13px] font-semibold text-slate-100 truncate max-w-[150px]">
                    {callerName || remoteNumber}
                  </span>
                  {callerTag === 'VIP' && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-amber-400 text-slate-950 shrink-0">
                      ★ VIP
                    </span>
                  )}
                  {call.held && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-amber-500/20 text-amber-300 border border-amber-400/40 shrink-0">
                      HOLD
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-px min-w-0">
                  {callerName ? (
                    <span className="text-[11px] font-mono text-slate-400 truncate">{remoteNumber}</span>
                  ) : (
                    <span className="text-[10px] font-semibold text-slate-500 shrink-0">
                      {call.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
                    </span>
                  )}
                  {queueLabel && (
                    <span
                      className="px-1.5 py-px rounded-full bg-indigo-500/20 text-indigo-300 text-[10px] font-bold shrink-0 max-w-[110px] truncate"
                      title={`Queue ${queueLabel}`}
                    >
                      {popQueueName ? queueLabel : `Q ${queueLabel}`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="timer-screen justify-self-center px-3.5 py-1 rounded-xl flex items-center gap-1.5 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
              <span className="timer-screen-text font-mono text-[13px] font-extrabold tracking-widest">
                {inCall ? fmtHMS(elapsed) : call.status === 'connecting' ? 'JOINING' : 'CALLING'}
              </span>
            </div>

            <div className="app-no-drag flex items-center justify-end gap-1.5 shrink-0">
              {inCall && (
                <>
                  <BarBtn active={call.muted} onClick={() => toggleMute(call.id)}>
                    {call.muted ? 'Unmute' : 'Mute'}
                  </BarBtn>
                  <BarBtn
                    active={call.held}
                    onClick={() => void (call.held ? resume(call.id) : hold(call.id))}
                  >
                    {call.held ? 'Resume' : 'Hold'}
                  </BarBtn>
                  <BarBtn active={drawer === 'keypad'} onClick={() => toggleDrawer('keypad')}>
                    DTMF
                  </BarBtn>
                  <BarBtn
                    active={drawer === 'transfer'}
                    accent
                    onClick={() => toggleDrawer('transfer')}
                  >
                    Transfer
                  </BarBtn>
                </>
              )}
              <button
                onClick={() => void hangup(call.id)}
                className="px-3 py-1 rounded-full bg-rose-600 hover:bg-rose-500 text-[11px] font-extrabold text-white shadow transition"
              >
                End
              </button>
            </div>
          </div>
        ) : (
          /* ---------- IDLE STATE ---------- */
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 shrink-0">
              <span className={`w-2.5 h-2.5 rounded-full transition-all duration-300 shrink-0 ${ledClass}`} />
              <span className="text-xs font-extrabold text-white tracking-tight whitespace-nowrap truncate max-w-[140px]">
                {displayName}
              </span>
              {extLabel && (
                <span className="px-1.5 py-0.5 rounded-md bg-slate-800/90 border border-slate-700/80 text-[10px] font-mono font-bold text-slate-300 shrink-0">
                  {extLabel}
                </span>
              )}
              {agent.loggedIn && (
                <button
                  onClick={() => toggleDrawer('queues')}
                  className="app-no-drag flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#1e293b]/90 hover:bg-slate-700 border border-[#334155] text-[10px] font-bold text-slate-200 transition shrink-0"
                  title="Assigned queues"
                >
                  <span className="text-indigo-400">Q</span>
                  <span className="w-3.5 h-3.5 rounded-full bg-indigo-500/25 text-indigo-300 text-[9px] font-extrabold flex items-center justify-center">
                    {agent.queues.length}
                  </span>
                </button>
              )}
            </div>

            <span className="h-4 w-px bg-slate-800 shrink-0" />

            {/* Status pill + dropdown */}
            <div className="app-no-drag flex items-center shrink-0 relative">
              <div
                onClick={toggleStatus}
                className={`flex items-center rounded-full bg-[#1e293b] border border-[#334155] transition select-none ${
                  agent.loggedIn ? 'hover:border-slate-500 cursor-pointer' : ''
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ml-2 shrink-0 ${
                    agentPaused ? 'bg-amber-400' : 'bg-emerald-400'
                  }`}
                />
                <span className="w-[84px] text-white text-[11px] font-semibold pl-1.5 pr-1 py-1 truncate">
                  {statusText}
                </span>
                {agent.loggedIn && <span className="text-slate-400 text-[10px] pr-1.5">▼</span>}
                {agent.loggedIn && (
                  <span className="pr-2 pl-1.5 border-l border-slate-700/80 font-mono text-[10px] font-bold text-slate-300 tracking-tight shrink-0">
                    {fmtHMS(statusSecs)}
                  </span>
                )}
              </div>

              {(statusOpen || statusPeek) && agent.loggedIn && (
                <div
                  className={`absolute top-full left-0 mt-2.5 w-52 rounded-3xl bg-[#0f172a]/95 backdrop-blur-2xl border border-slate-700/80 p-2 shadow-2xl z-50 text-xs space-y-1 overflow-hidden ${
                    statusOpen ? 'drawer-animate' : 'invisible'
                  }`}
                >
                  {statusOptions.map((o) => (
                    <div
                      key={o.value}
                      onMouseDown={(e) => {
                        // mousedown fires before any blur/outside-click
                        // handling, so the pick can never lose a race
                        // against the dropdown closing; preventDefault
                        // also keeps focus (and the window) untouched.
                        e.preventDefault();
                        pickStatus(o.value);
                      }}
                      className={`p-2.5 rounded-2xl bg-[#1e293b]/85 border border-[#334155]/80 flex items-center justify-between cursor-pointer transition ${
                        o.amber
                          ? 'hover:bg-amber-500/15 hover:border-amber-400/50'
                          : 'hover:bg-emerald-500/15 hover:border-emerald-400/50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            o.amber
                              ? 'bg-amber-400 shadow-[0_0_8px_#f59e0b]'
                              : 'bg-emerald-400 shadow-[0_0_8px_#10b981]'
                          }`}
                        />
                        <span className="font-bold text-white">{o.label}</span>
                      </div>
                      <span className={`text-[10px] font-medium ${o.amber ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {o.hint}
                      </span>
                    </div>
                  ))}
                  {/* Split pause (v5.35): chats only — voice status above is untouched. */}
                  <div className="h-px bg-slate-700/60 my-1" />
                  <div
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setStatusOpen(false);
                      setStatusPeek(false);
                      void setChatPaused(!chatPaused);
                    }}
                    className="p-2.5 rounded-2xl bg-[#1e293b]/85 border border-[#334155]/80 flex items-center justify-between cursor-pointer transition hover:bg-emerald-500/15 hover:border-emerald-400/50"
                  >
                    <div className="flex items-center gap-2">
                      <WhatsAppGlyph className="w-3.5 h-3.5 text-emerald-300" />
                      <span className="font-bold text-white">{chatPaused ? 'Resume chats' : 'Pause chats'}</span>
                    </div>
                    <span className="text-[10px] font-medium text-emerald-400">
                      {chatPaused ? 'Chats paused' : 'Chats only'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <span className="h-4 w-px bg-slate-800 shrink-0" />

            {/* Tool toggles + window controls */}
            <div className="app-no-drag flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => toggleDrawer('keypad')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#1e293b]/80 hover:bg-white/15 border border-[#334155]/80 text-[11px] font-semibold text-slate-200 transition"
                title="Toggle keypad"
              >
                <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 24 24" fill="currentColor">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <circle key={i} cx={5 + (i % 3) * 7} cy={4.5 + Math.floor(i / 3) * 5} r={1.7} />
                  ))}
                </svg>
                <span>Keypad</span>
              </button>
              {agent.loggedIn && (
                <button
                  onClick={() => void openWhatsAppChat(whatsapp.tickets[0]?.id ?? 0)}
                  className={`${toggleBtnCls(false)} relative`}
                  title="WhatsApp — open the chat window"
                >
                  <WhatsAppGlyph className="w-4 h-4 text-emerald-400" />
                  {whatsapp.unreadTotal > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-emerald-500 text-slate-950 text-[9px] font-extrabold flex items-center justify-center ring-2 ring-[#0f172a]">
                      {whatsapp.unreadTotal > 99 ? '99+' : whatsapp.unreadTotal}
                    </span>
                  )}
                </button>
              )}
              <button onClick={() => toggleDrawer('logs')} className={toggleBtnCls(drawer === 'logs')} title="Call logs">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <button onClick={() => toggleDrawer('contacts')} className={toggleBtnCls(drawer === 'contacts')} title="Contacts">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <button
                onClick={() => toggleDrawer('settings')}
                className={toggleBtnCls(drawer === 'settings')}
                title="Settings"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <button onClick={logout} className="w-7 h-7 rounded-full hover:bg-rose-500/20 text-rose-400 flex items-center justify-center transition" title="Log out">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
              <span className="h-4 w-px bg-slate-800" />
              <button onClick={() => void window.api.minimize()} className="w-7 h-7 rounded-full hover:bg-white/10 text-slate-400 flex items-center justify-center transition" title="Minimize">
                <span className="block w-3 border-t-2 border-current" />
              </button>
              {/* No Quit (✕) button on the bar (owner's call): an
                  accidental click used to exit the app outright.
                  Minimize stays; quitting lives in the tray/menu. */}
            </div>
          </div>
        )}
      </div>

      {/* ======================= DRAWERS ======================= */}
      {drawer === 'queues' && agent.loggedIn && (
        <DrawerShell width="max-w-[360px]" title="Assigned Call Queues" dot="bg-indigo-400" onClose={() => setDrawer(null)}>
          <div className="space-y-2">
            {agent.queues.length === 0 && <div className="text-slate-500 text-xs">No queues assigned</div>}
            {agent.queues.map((q) => (
              <div key={q} className="p-3 rounded-2xl bg-[#1e293b]/85 border border-[#334155]/80 flex items-center justify-between">
                <div>
                  <div className="font-bold text-white flex items-center gap-1.5">
                    {agent.queueNames?.[q] ? (
                      <>
                        <span className="truncate">{agent.queueNames[q]}</span>
                        <span className="font-mono text-indigo-300 text-xs shrink-0">{q}</span>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-indigo-300">{q}</span> • Queue
                      </>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {agent.connected ? 'Middleware connected' : 'Middleware reconnecting…'}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Active
                </span>
              </div>
            ))}
          </div>
        </DrawerShell>
      )}

      {drawer === 'keypad' && (
        <DrawerShell
          width="max-w-[310px]"
          title={inCall ? 'DTMF Keypad' : 'Keypad / Dialer'}
          onClose={() => setDrawer(null)}
        >
          {inCall ? (
            <>
              <div className="mb-4 rounded-xl bg-[#1e293b] border border-[#334155] px-3 py-2 text-center text-base font-bold tracking-wider text-white min-h-[42px]">
                {dtmfDigits || <span className="text-slate-500 text-sm font-medium">Digits sent appear here</span>}
              </div>
              <div className="grid grid-cols-3 gap-3 place-items-center mb-1">
                {KEYS.map((k) => (
                  <button key={k.d} onClick={() => dtmf(k.d)} className="dial-key">
                    <span className="text-lg font-bold text-white">{k.d}</span>
                    <span className="text-[8px] text-slate-400">{k.sub || ' '}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mb-4">
                <input
                  ref={dialer.inputRef}
                  value={dialer.value}
                  onChange={(e) => dialer.setNumber(safePhone(e.target.value))}
                  onSelect={dialer.trackSelect}
                  onClick={dialer.trackSelect}
                  onKeyUp={dialer.trackSelect}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') dialer.call();
                  }}
                  placeholder="Enter phone or ext..."
                  className="w-full bg-[#1e293b] border border-[#334155] focus:border-emerald-400 rounded-xl px-3 py-2 text-center text-base font-bold tracking-wider text-white focus:outline-none placeholder:text-sm placeholder:font-medium"
                />
                <button
                  onClick={dialer.backspace}
                  className="px-3 py-2 rounded-xl bg-[#1e293b] hover:bg-slate-700 border border-[#334155] text-xs font-bold text-slate-300"
                >
                  ⌫
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 place-items-center mb-4">
                {KEYS.map((k) => (
                  <button key={k.d} onClick={() => dialer.press(k.d)} className="dial-key">
                    <span className="text-lg font-bold text-white">{k.d}</span>
                    <span className="text-[8px] text-slate-400">{k.sub || ' '}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => dialer.call()}
                disabled={!dialer.value || !dialer.online}
                className="w-full py-2.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-extrabold text-xs shadow-lg shadow-emerald-500/20 transition"
              >
                Call Number
              </button>
            </>
          )}
        </DrawerShell>
      )}

      {drawer === 'logs' && (
        <DrawerShell width="max-w-[400px]" title="Recent Call Logs" onClose={() => setDrawer(null)}>
          <div className="space-y-2 text-xs max-h-[320px] overflow-y-auto drawer-scroll pr-1">
            {history.length === 0 && <div className="text-slate-500">No calls yet</div>}
            {history.slice(0, 8).map((h) => {
              const num = numberOf(h.remote);
              const missed = h.direction === 'incoming' && (h.durationSec ?? 0) === 0 && h.status !== 'in-call';
              return (
                <div key={h.id} className="p-3 rounded-2xl bg-[#1e293b]/80 border border-[#334155]/70 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className={`font-bold truncate ${missed ? 'text-rose-400' : 'text-white'}`}>
                      {h.displayName || num}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                      {num} • {h.direction === 'incoming' ? 'Inbound' : 'Outbound'}
                      {missed ? ' • Missed' : ` • ${formatDuration(h.durationSec ?? 0)}`}
                    </div>
                  </div>
                  <button
                    onClick={() => dialNumber(num)}
                    className="px-3 py-1.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[11px] transition shrink-0"
                  >
                    Call
                  </button>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setDrawer('applogs')}
            className="w-full mt-3 py-2 rounded-xl bg-[#1e293b] hover:bg-slate-700 border border-[#334155] text-xs font-semibold text-white transition"
          >
            App logs
          </button>
        </DrawerShell>
      )}

      {drawer === 'contacts' && (
        <DrawerShell width="max-w-[400px]" title="Contacts & Extensions" onClose={() => setDrawer(null)}>
          <input
            value={contactQ}
            onChange={(e) => setContactQ(e.target.value)}
            placeholder="Search contacts…"
            className="w-full bg-[#1e293b] border border-[#334155] focus:border-emerald-400 rounded-xl px-3 py-2 text-sm text-white focus:outline-none mb-3"
          />
          <div className="space-y-2 text-xs max-h-[300px] overflow-y-auto drawer-scroll pr-1">
            {filteredContacts.length === 0 && <div className="text-slate-500">No contacts found</div>}
            {filteredContacts.map((c) => (
              <div key={c.id} className="p-3 rounded-2xl bg-[#1e293b]/80 border border-[#334155]/70 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: c.avatarColor || '#334155' }}
                  >
                    {c.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="font-bold text-white truncate">{c.name}</div>
                    <div className="text-[11px] text-slate-400 font-mono truncate">{c.number}</div>
                  </div>
                </div>
                <button
                  onClick={() => dialNumber(c.number)}
                  className="px-3 py-1.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[11px] transition shrink-0"
                >
                  Call
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setDrawer('contactsFull')}
            className="w-full mt-3 py-2 rounded-xl bg-[#1e293b] hover:bg-slate-700 border border-[#334155] text-xs font-semibold text-white transition"
          >
            Manage contacts
          </button>
        </DrawerShell>
      )}

      {drawer === 'transfer' && inCall && call && (
        <DrawerShell width="max-w-[360px]" title="Blind Transfer" onClose={() => setDrawer(null)}>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doTransfer();
              }}
              placeholder="Extension or number…"
              className="w-full bg-[#1e293b] border border-[#334155] focus:border-indigo-400 rounded-xl px-3 py-2 text-sm font-semibold text-white focus:outline-none"
            />
            <button
              onClick={doTransfer}
              disabled={!transferTarget.trim()}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-extrabold transition shrink-0"
            >
              Transfer
            </button>
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            The call is handed off immediately and ends on this device.
          </div>
        </DrawerShell>
      )}

      {drawer === 'settings' && (
        <DrawerShell width="max-w-[740px]" title="Settings" onClose={() => setDrawer(null)}>
          <div className="h-[480px]">
            <Settings />
          </div>
        </DrawerShell>
      )}

      {drawer === 'applogs' && (
        <DrawerShell width="max-w-[560px]" title="App Logs" onClose={() => setDrawer(null)}>
          <div className="h-[440px]">
            <Logs />
          </div>
        </DrawerShell>
      )}

      {drawer === 'contactsFull' && (
        <DrawerShell width="max-w-[560px]" title="Contacts" onClose={() => setDrawer(null)}>
          <div className="h-[440px]">
            <Contacts />
          </div>
        </DrawerShell>
      )}

      {/* WhatsApp tickets drawer — DORMANT since v5.24.1: the bar's
          WhatsApp button and the assignment toast now open the chat
          window directly, at the user's call. The drawer (with its
          Phase 2 quick reply) is kept intact on purpose — it is the
          quick-reply surface if that is ever wanted back; nothing
          routes to it today. Its ticket click still also opens the
          chat window. */}
      {drawer === 'whatsapp' && agent.loggedIn && (
        <DrawerShell width="max-w-[400px]" title="WhatsApp Tickets" dot="bg-emerald-400" onClose={() => setDrawer(null)}>
          <button
            onClick={() => void openWhatsApp()}
            className="w-full mb-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold transition"
          >
            Open in Nero
          </button>
          <div className="space-y-2 max-h-[320px] overflow-y-auto drawer-scroll pr-1">
            {whatsapp.tickets.length === 0 && (
              <div className="text-slate-500 text-xs">No open WhatsApp tickets</div>
            )}
            {whatsapp.tickets.map((t) => {
              const st = whatsapp.replyStatus[t.id];
              const selected = waSel === t.id;
              return (
              <div
                key={t.id}
                onClick={() => {
                  selectWaTicket(t.id);
                  // The full conversation lives in the chat window
                  // (v5.24): tapping a ticket opens it there. The
                  // drawer's own quick reply stays as it was.
                  void openWhatsAppChat(t.id);
                }}
                className={`p-3 rounded-2xl bg-[#1e293b]/80 border cursor-pointer transition ${
                  selected ? 'border-emerald-400/70 ring-1 ring-emerald-400/50' : 'border-[#334155]/70'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-white truncate">{t.contactName || t.phone}</span>
                  {t.unreadCount > 0 && (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-extrabold flex items-center justify-center shrink-0">
                      {t.unreadCount}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-400 font-mono truncate mt-0.5">{t.phone}</div>
                {t.preview && <div className="text-[11px] text-slate-300 truncate mt-1">{t.preview}</div>}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] font-semibold text-slate-500">
                    {t.unreadCount > 0 && t.waitingSeconds > 0
                      ? `Waiting ${fmtHMS(t.waitingSeconds)}`
                      : t.status}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void openWhatsApp();
                    }}
                    className="text-[11px] font-bold text-emerald-300 hover:text-emerald-200 transition shrink-0"
                  >
                    Open in Nero ↗
                  </button>
                </div>
                {selected && (
                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                    <textarea
                      value={waText}
                      onChange={(e) => setWaText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (waText.trim() && st?.state !== 'sending') {
                            void sendWhatsAppReply(t.id, waText);
                          }
                        }
                      }}
                      rows={2}
                      autoFocus
                      placeholder="Quick reply… (Enter to send, Shift+Enter for a new line)"
                      className="w-full rounded-xl bg-[#0f172a] border border-[#334155] text-white text-xs p-2 outline-none focus:border-emerald-400/60 resize-none"
                    />
                    <div className="flex items-center justify-between mt-1.5 min-h-[24px]">
                      <span className="text-[10px] text-slate-400">
                        {st?.state === 'sending' && 'Sending…'}
                        {st?.state === 'sent' && <span className="text-emerald-300">Queued for sending ✓</span>}
                        {st?.state === 'error' && <span className="text-red-300">{st.error}</span>}
                      </span>
                      <button
                        onClick={() => void sendWhatsAppReply(t.id, waText)}
                        disabled={!waText.trim() || st?.state === 'sending'}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-[11px] font-extrabold transition"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <div className="text-[10px] text-slate-500 mt-3">
            Tap a ticket to reply from here — replies go through the WhatsApp module's queue and guardrails, just like the web UI.
          </div>
        </DrawerShell>
      )}

      {/* ======================= WHATSAPP ASSIGNMENT TOAST ======================= */}
      {waToast && whatsapp.lastAssigned && (
        <div className="fixed inset-x-0 top-[64px] z-[70] flex justify-center px-3 pointer-events-none">
          <div
            onClick={() => {
              setWaToast(false);
              if (whatsapp.lastAssigned) void openWhatsAppChat(whatsapp.lastAssigned.id);
            }}
            className="app-no-drag pointer-events-auto w-full max-w-[340px] rounded-3xl bg-[#0f172a]/95 backdrop-blur-2xl border border-emerald-500/30 p-3 shadow-2xl drawer-animate cursor-pointer flex items-center gap-2.5"
          >
            <span className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
              <WhatsAppGlyph className="w-4 h-4 text-emerald-300" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold text-white truncate">New WhatsApp ticket assigned</div>
              <div className="text-[11px] text-slate-400 truncate">
                {whatsapp.lastAssigned.contactName || whatsapp.lastAssigned.phone}
                {whatsapp.lastAssigned.preview ? ` — ${whatsapp.lastAssigned.preview}` : ''}
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                setWaToast(false);
              }}
              className="shrink-0 w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-slate-300 text-[13px] leading-none flex items-center justify-center"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* ======================= LOGOUT CONFIRM ======================= */}
      {logoutOpen && (
        <>
          {/* Backdrop is a click-catcher ONLY — it must stay
              transparent: the bar window is transparent and grows
              to fit this card, so any tint here paints a giant dark
              rectangle over the desktop (the "big shadow"). */}
          <div
            className="app-no-drag fixed inset-0 z-[60] bg-transparent"
            onClick={() => setLogoutOpen(false)}
          />
          <div className="fixed inset-x-0 top-[64px] z-[70] flex justify-center px-3 pointer-events-none">
            <div className="app-no-drag pointer-events-auto w-full max-w-[340px] rounded-3xl bg-[#0f172a]/95 backdrop-blur-2xl border border-slate-700/80 p-4 shadow-2xl drawer-animate">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-500 to-indigo-500 flex items-center justify-center text-[13px] font-extrabold text-white shrink-0">
                  {agentInitials}
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-bold text-white truncate">
                    {displayName}
                    {extLabel && <span className="text-slate-400 font-semibold"> · ext {extLabel}</span>}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        agentPaused ? 'bg-amber-400' : 'bg-emerald-400'
                      }`}
                    />
                    <span className="truncate">{statusLabel}</span>
                    {agent.loggedIn && (
                      <span className="font-mono font-bold text-slate-300 shrink-0">
                        {fmtHMS(statusSecs)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {call && (
                <div className="mt-3 flex items-center gap-2 rounded-2xl bg-danger-600/15 border border-danger-600/30 px-3 py-2 text-[11px] font-semibold text-rose-300">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="min-w-0 truncate">
                    Call with {callerName || remoteNumber}
                    {inCall && (
                      <>
                        {' · '}
                        <span className="font-mono font-bold">{fmtHMS(elapsed)}</span>
                      </>
                    )}{' '}
                    will end
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 mt-4">
                <button
                  onClick={() => setLogoutOpen(false)}
                  className="py-2 rounded-2xl bg-[#1e293b] hover:bg-slate-700 border border-[#334155] text-slate-200 text-xs font-bold transition"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmLogout}
                  className="py-2 rounded-2xl bg-danger-600 hover:bg-danger-500 text-white text-xs font-extrabold shadow-lg shadow-danger-600/25 transition"
                >
                  Log out
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// WhatsApp-style glyph: a chat bubble (with tail) carrying the same
// handset path the active-call bar uses. Inline SVG, no emoji.
function WhatsAppGlyph({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-8.55 15.13L2 22l5.05-1.32A10 10 0 1 0 12 2Z" />
      <path
        fill="#0f172a"
        transform="translate(6.4 6.4) scale(0.483)"
        d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.4 11.4 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2Z"
      />
    </svg>
  );
}

function BarBtn({
  children,
  onClick,
  active,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  accent?: boolean;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold transition ${
        accent
          ? 'bg-indigo-600/30 hover:bg-indigo-600/50 border-indigo-400/40 text-indigo-200'
          : active
            ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-300'
            : 'bg-[#1e293b] hover:bg-slate-700 border-[#334155] text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

function DrawerShell({
  children,
  title,
  width,
  dot,
  onClose,
}: {
  children: React.ReactNode;
  title: string;
  width: string;
  dot?: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div
      className={`app-no-drag mt-2.5 w-full ${width} rounded-3xl bg-[#0f172a]/95 backdrop-blur-2xl border border-slate-700/80 p-4 shadow-2xl drawer-animate text-xs z-50`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold text-white flex items-center gap-1.5">
          {dot && <span className={`w-2 h-2 rounded-full ${dot}`} />}
          {title}
        </span>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded-lg hover:bg-white/10"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
