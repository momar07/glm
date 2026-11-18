import type { SipProfile, AppSettings, IceServerSpec } from '@shared/types';
import { isMobile } from '../lib/platform';
import { applyCodecPrefs, tuneOpus, opusTuning, senderMaxBitrate } from '../lib/sdp';

// ============================================================
// Registration State Machine
// ============================================================
//
//   disconnected → connecting → connected → registering → registered
//          ↑                                                       ↓
//          ← ← ← ← ← disconnecting ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
//                                                               ↓
//   registration-failed ← ← ← reconnecting ← ← ← ← ← registered
//          ↓                                                       ↑
//        connecting (retry)                            (transport drop)

export type SipServiceState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'registering'
  | 'registered'
  | 'registration-failed'
  | 'reconnecting'
  | 'disconnecting';

// Presence reported to UI — derived from SipServiceState + active call flag.
export type SoftphoneStatus = 'offline' | 'registering' | 'registered' | 'connection-lost' | 'on-call';

// ============================================================
// Call Session
// ============================================================

export interface CallSession {
  id: string;
  direction: 'incoming' | 'outgoing';
  remote: string;
  displayName?: string;
  status: 'ringing' | 'connecting' | 'in-call' | 'held' | 'ended' | 'failed';
  startedAt: number;
  connectedAt?: number;
  endedAt?: number;
  reason?: string;
  held: boolean;
  muted: boolean;
  internal: unknown;
}

// ============================================================
// Events
// ============================================================

export interface SipEngineEvents {
  presence: (status: SoftphoneStatus) => void;
  stateChange: (state: SipServiceState) => void;
  registered: () => void;
  unregistered: () => void;
  registrationFailed: (reason: string) => void;
  transport: (connected: boolean) => void;
  incoming: (call: CallSession) => void;
  outgoing: (call: CallSession) => void;
  callUpdate: (call: CallSession) => void;
  callEnded: (call: CallSession, reason: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

// ============================================================
// Emitter
// ============================================================

type Listener<K extends keyof SipEngineEvents> = SipEngineEvents[K];

class Emitter {
  private map = new Map<keyof SipEngineEvents, Set<(payload: any) => void>>();

  on<K extends keyof SipEngineEvents>(ev: K, cb: Listener<K>): () => void {
    let set = this.map.get(ev);
    if (!set) {
      set = new Set();
      this.map.set(ev, set);
    }
    set.add(cb as (p: any) => void);
    return () => this.map.get(ev)?.delete(cb as (p: any) => void);
  }

  emit<K extends keyof SipEngineEvents>(ev: K, ...args: Parameters<Listener<K>>): void {
    this.map.get(ev)?.forEach((cb) => {
      try {
        (cb as (...a: Parameters<Listener<K>>) => void)(...args);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[SIP] listener threw', e);
      }
    });
  }
}

// ============================================================
// SipService — singleton, exactly one UA + one Registerer
// ============================================================

type AnyUA = any;
type AnySession = any;

// Global counter — every UA created gets a unique id for log tracing.
let uaInstanceCounter = 0;

class SipService {
  private em = new Emitter();

  // ---- State machine ----
  private _state: SipServiceState = 'disconnected';

  // ---- SIP.js objects (exactly one of each) ----
  private ua: AnyUA | null = null;
  private registerer: any = null;
  private uaInstanceId = 0;

  // ---- Configuration ----
  private profile: SipProfile | null = null;
  private settings: AppSettings | null = null;

  // ---- Sessions ----
  private sessions = new Map<string, CallSession>();

  // ---- In-flight answer guards (double-tap protection) ----
  private pendingAnswer = new Set<string>();

  // ---- Audio ----
  private remoteAudio: HTMLAudioElement | null = null;
  private statsTimer: number | null = null;

  // ---- Reconnect ----
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 2000; // 2s
  private readonly maxReconnectDelay = 60000; // 60s cap

  // ---- Shutdown flag — prevents reconnect during intentional disconnect ----
  private shuttingDown = false;

  // ---- Init guard — dedupes concurrent initialize() calls ----
  private initPromise: Promise<void> | null = null;

  // ---- Generation counter — invalidates stale async initialize() after shutdown ----
  private generation = 0;

  // ---- SIP.js module cache (lazy loaded) ----
  private sipjs: any | null = null;

  // ================== Public API ==================

  get state(): SipServiceState {
    return this._state;
  }

  get presence(): SoftphoneStatus {
    return this.stateToPresence(this._state);
  }

  // True while a foreground recovery is rebuilding the connection.
  get recovering(): boolean {
    return this.recoverPromise !== null;
  }

  get activeCalls(): CallSession[] {
    return [...this.sessions.values()].filter((c) => c.status !== 'ended' && c.status !== 'failed');
  }

  getCall(id: string): CallSession | undefined {
    return this.sessions.get(id);
  }

  get currentProfileId(): string | null {
    return this.profile?.id ?? null;
  }

  on<K extends keyof SipEngineEvents>(ev: K, cb: Listener<K>): () => void {
    return this.em.on(ev, cb);
  }

  setRemoteAudio(el: HTMLAudioElement): void {
    this.remoteAudio = el;
  }

  // Live-sync settings changed after connect (codec order, Opus quality,
  // audio devices). initialize() snapshots them once; without this every
  // Settings edit silently needs a logout/login to take effect.
  // Takes effect on the next call — never touches an active session.
  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    if (this.ua) {
      this.log('info', 'settings updated live — codecs/opus quality apply on next call');
    }
  }

  // ================== State Machine ==================

  private canTransition(from: SipServiceState, to: SipServiceState): boolean {
    const allowed: Record<SipServiceState, SipServiceState[]> = {
      disconnected: ['connecting'],
      connecting: ['connected', 'registering', 'disconnected', 'disconnecting'],
      connected: ['registering', 'reconnecting', 'disconnecting'],
      registering: ['registered', 'registration-failed', 'reconnecting', 'disconnecting'],
      registered: ['reconnecting', 'disconnecting'],
      'registration-failed': ['connecting', 'disconnecting'],
      reconnecting: ['connected', 'registering', 'registered', 'registration-failed', 'disconnecting'],
      disconnecting: ['disconnected'],
    };
    return (allowed[from] ?? []).includes(to);
  }

  private transition(to: SipServiceState): void {
    if (this._state === to) return;
    if (!this.canTransition(this._state, to)) {
      this.log('warn', `invalid state transition: ${this._state} → ${to} — blocked`);
      return;
    }
    this.log('debug', `state: ${this._state} → ${to}`);
    this._state = to;
    this.em.emit('stateChange', to);
    this.em.emit('presence', this.stateToPresence(to));
  }

  private stateToPresence(state: SipServiceState): SoftphoneStatus {
    if (state === 'registered' && this.activeCalls.length > 0) return 'on-call';
    switch (state) {
      case 'disconnected':
      case 'disconnecting':
        return 'offline';
      case 'connecting':
      case 'connected':
      case 'registering':
        return 'registering';
      case 'registered':
        return 'registered';
      case 'registration-failed':
      case 'reconnecting':
        return 'connection-lost';
    }
  }

  // ================== Initialize ==================

  /**
   * Initialize the SIP service. Creates exactly one UserAgent and one Registerer.
   * If already initialized or currently initializing, returns immediately.
   * After shutdown(), can be called again to create a fresh UA.
   */
  async initialize(profile: SipProfile, settings: AppSettings): Promise<void> {
    // Guard: only allow init from disconnected or registration-failed
    if (this._state !== 'disconnected' && this._state !== 'registration-failed') {
      this.log('info', `initialize() called but state is ${this._state} — ignoring (already active)`);
      return this.initPromise ?? Promise.resolve();
    }

    // Guard: dedupe concurrent calls
    if (this.initPromise) {
      this.log('info', 'initialize() already in progress — joining existing promise');
      return this.initPromise;
    }

    this.initPromise = this.doInitialize(profile, settings);
    try {
      await this.initPromise;
    } catch (e) {
      // Never strand the machine mid-connect (connecting with no live attempt =
      // UI parked on Reconnecting forever with no way back). Force idle.
      this.forceIdle();
      throw e;
    } finally {
      this.initPromise = null;
    }
  }

  // Best-effort return to 'disconnected' from any non-final state.
  private forceIdle(): void {
    if (this._state === 'disconnected' || this._state === 'registered') return;
    try {
      if (this.canTransition(this._state, 'disconnecting')) this.transition('disconnecting');
      if (this.canTransition(this._state, 'disconnected')) this.transition('disconnected');
    } catch {
      /* transition logs already */
    }
  }

  // User-visible cancel for a stuck connect (splash Cancel button). Aborts the
  // in-flight attempt and returns to idle; heavier than forceIdle (also drops
  // the half-built UA) so a retry starts clean.
  async cancelConnect(): Promise<void> {
    this.generation++; // invalidate any in-flight doInitialize continuations
    try {
      await this.ua?.stop();
    } catch {
      /* ignore */
    }
    this.ua = null;
    this.registerer = null;
    this.forceIdle();
    this.log('info', 'connect cancelled by user');
  }

  private async doInitialize(profile: SipProfile, settings: AppSettings): Promise<void> {
    const gen = ++this.generation;
    this.profile = profile;
    this.settings = settings;
    this.shuttingDown = false;
    this.reconnectAttempts = 0;

    this.transition('connecting');
    this.log('info', `Initializing — ${profile.username}@${profile.sipDomain} (WSS ${profile.wsUrl})`);

    const sipjs = (this.sipjs ??= await import('sip.js'));
    const { UserAgent, Registerer, RegistererState } = sipjs;

    // Safety net: if a UA somehow still exists, warn and dispose it
    if (this.ua) {
      this.log('warn', `DUPLICATE UserAgent detected (existing id=${this.uaInstanceId}) — disposing`);
      try {
        await this.ua.stop();
      } catch {
        /* ignore */
      }
      this.ua = null;
      this.registerer = null;
    }

    const uri = UserAgent.makeURI(`sip:${profile.username}@${profile.sipDomain}`);
    if (!uri) throw new Error(`invalid sip uri: ${profile.username}@${profile.sipDomain}`);

    const iceServers = this.buildIceServers(profile, settings);

    // Mobile carrier NAT bindings expire fast and background throttling delays
    // keep-alives — clamp the interval so the PBX contact survives longer.
    // ponytail: fixed 20s ceiling; per-network tuning if logs show expiry first.
    const keepAliveInterval = isMobile()
      ? Math.min(settings.transport.keepAliveInterval, 20)
      : settings.transport.keepAliveInterval;

    // Create exactly one UserAgent
    this.uaInstanceId = ++uaInstanceCounter;
    this.log('info', `UserAgent created (id=${this.uaInstanceId})`);

    const ua = new UserAgent({
      uri,
      authorizationUsername: profile.username,
      authorizationPassword: profile.password,
      displayName: profile.displayName || profile.username,
      transportOptions: {
        server: profile.wsUrl,
        connectionTimeout: 5,
        keepAliveInterval,
        traceSip: false,
      },
      sessionDescriptionHandlerFactoryOptions: {
        iceGatheringTimeout: 5000,
        peerConnectionConfiguration: {
          iceServers,
          iceTransportPolicy: 'all',
        },
      },
      noAnswerTimeout: 60,
      logBuiltinEnabled: false,
      logConfiguration: false,
      delegate: {
        onConnect: () => this.onTransportConnect(),
        onDisconnect: (error?: Error) => this.onTransportDisconnect(error),
        onInvite: (invitation: AnySession) => this.handleIncoming(invitation),
      },
    });

    this.ua = ua;

    // Start UA — connects WebSocket
    try {
      await ua.start();
    } catch (e: any) {
      this.log('error', `WebSocket connection failed: ${e?.message}`);
      if (this.generation !== gen) return; // aborted by shutdown
      try {
        await ua.stop();
      } catch {
        /* ignore */
      }
      this.ua = null;
      this.transition('disconnected');
      throw e;
    }

    // Check if aborted during async ua.start()
    if (this.generation !== gen) {
      this.log('info', 'initialize aborted during ua.start() — cleaning up');
      try {
        await ua.stop();
      } catch {
        /* ignore */
      }
      this.ua = null;
      return;
    }

    this.transition('connected');
    this.log('info', 'WebSocket connected');

    // Create exactly one Registerer
    const registerer = new Registerer(ua);
    registerer.stateChange.addListener((state: any) => {
      this.log('debug', `registerer state: ${state}`);
      if (state === RegistererState.Registered) {
        if (this._state === 'registering' || this._state === 'reconnecting') {
          this.transition('registered');
          this.em.emit('registered');
          this.log('info', 'Registered');
        }
      } else if (state === RegistererState.Unregistered) {
        if (!this.shuttingDown) {
          this.em.emit('unregistered');
        }
      }
    });
    this.registerer = registerer;

    // Register
    this.transition('registering');
    this.log('info', 'Registering');
    await registerer.register({
      requestDelegate: {
        onAccept: () => {
          // registerer stateChange handles the transition
        },
        onReject: (resp: any) => {
          const reason = resp?.message?.reasonPhrase || `${resp?.message?.statusCode ?? 'auth'}`;
          this.log('error', `Registration rejected: ${reason}`);
          this.transition('registration-failed');
          this.em.emit('registrationFailed', reason);
        },
      },
    });
  }

  // ================== Transport Events ==================

  private onTransportConnect(): void {
    this.log('info', 'WebSocket connected');
    this.em.emit('transport', true);

    if (this._state === 'reconnecting') {
      this.handleReconnectSuccess();
    }
    // Initial connect transitions are handled linearly in doInitialize()
  }

  private onTransportDisconnect(error?: Error): void {
    this.log('warn', 'WebSocket disconnected', error?.message);
    this.em.emit('transport', false);

    if (this.shuttingDown) {
      // Expected disconnect during shutdown — don't reconnect
      return;
    }

    // Only reconnect if we were in an active state
    if (
      this._state === 'registered' ||
      this._state === 'connected' ||
      this._state === 'registering'
    ) {
      this.transition('reconnecting');
      this.scheduleReconnect();
    }
  }

  private handleReconnectSuccess(): void {
    this.reconnectAttempts = 0;
    this.log('info', 'WebSocket reconnected');

    if (!this.registerer || !this.sipjs) return;

    const { RegistererState } = this.sipjs;
    const regState = this.registerer.state;

    if (regState === RegistererState.Registered) {
      // Registerer still valid — no need to re-register
      this.transition('registered');
      this.em.emit('registered');
      this.log('info', 'Registration still valid after reconnect');
    } else {
      // Need to re-register using the SAME registerer (never create a new one)
      this.log('info', 'Re-registering after reconnect');
      this.transition('registering');
      this.registerer.register({
        requestDelegate: {
          onAccept: () => {
            // registerer stateChange handles transition
          },
          onReject: (resp: any) => {
            const reason = resp?.message?.reasonPhrase || 're-register failed';
            this.log('error', `Re-registration rejected: ${reason}`);
            this.transition('registration-failed');
            this.em.emit('registrationFailed', reason);
          },
        },
      });
    }
  }

  // ================== Reconnect (exponential backoff, reuse UA) ==================

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // already scheduled
    if (this.shuttingDown) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error', `Reconnect failed after ${this.maxReconnectAttempts} attempts — giving up`);
      this.transition('registration-failed');
      this.em.emit('registrationFailed', 'reconnect failed');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );
    this.log(
      'info',
      `Reconnecting (attempt ${this.reconnectAttempts}, delay ${Math.round(delay / 1000)}s)`,
    );

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown || !this.ua) return;
      if (this._state !== 'reconnecting') return; // state changed unexpectedly

      // Reuse existing UA — NEVER create a new one
      this.ua
        .reconnect()
        .then(() => {
          this.log('debug', 'reconnect() resolved — transport restored');
        })
        .catch((e: any) => {
          this.log('warn', `reconnect() failed: ${e?.message}`);
          if (this._state === 'reconnecting' && !this.shuttingDown) {
            this.scheduleReconnect(); // next attempt with increased backoff
          }
        });
    }, delay);
  }

  // ================== Shutdown ==================

  /**
   * Full shutdown — unregister, dispose sessions, close WebSocket, dispose UA.
   * After shutdown, initialize() can be called again with a fresh UA.
   */
  async shutdown(): Promise<void> {
    if (this._state === 'disconnected' || this._state === 'disconnecting') {
      return;
    }

    this.shuttingDown = true;
    this.generation++; // invalidate any in-progress initialize()

    // Cancel pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStatsPolling();

    this.transition('disconnecting');
    this.log('info', 'Shutting down');

    // Terminate all sessions
    for (const c of this.sessions.values()) {
      await this.terminateInternal(c.internal).catch(() => {});
    }
    this.sessions.clear();

    // Unregister
    try {
      if (this.registerer) {
        this.log('info', 'Unregistering');
        await this.registerer.unregister();
        this.em.emit('unregistered');
      }
    } catch {
      // may throw if already unregistered — ignore
    }

    // Stop UA (closes WebSocket)
    try {
      if (this.ua) {
        this.log('info', `Stopping UserAgent (id=${this.uaInstanceId})`);
        await this.ua.stop();
      }
    } catch {
      // ignore
    }

    // Dispose references
    this.registerer = null;
    this.ua = null;
    this.profile = null;
    this.reconnectAttempts = 0;
    this.shuttingDown = false;

    this.transition('disconnected');
    this.em.emit('transport', false);
    this.log('info', 'Shutdown complete');
  }

  // ================== Foreground recovery ==================

  private recoverPromise: Promise<boolean> | null = null;

  // Called when the app returns to foreground (mobile resume). A backgrounded
  // OS kills sockets without firing close events, so the engine can sit in
  // 'registered' on a dead transport. Nudge first; full re-init only when safe.
  async recoverTransport(): Promise<boolean> {
    if (this.recoverPromise) return this.recoverPromise;
    this.recoverPromise = this.doRecover();
    try {
      return await this.recoverPromise;
    } finally {
      this.recoverPromise = null;
    }
  }

  private async doRecover(): Promise<boolean> {
    if (this.shuttingDown) return false;
    if (!this.ua || !this.profile || !this.settings) return false; // never connected / logged out
    if (this._state === 'disconnected' || this._state === 'disconnecting') return false;

    try {
      if (this.ua.isConnected()) {
        // Socket alive — re-register in case the PBX expired us while throttled.
        this.log('info', 'recoverTransport: socket alive — re-registering');
        await this.withTimeout(this.reRegister(), 8000).catch((e: any) => {
          this.log('warn', `recoverTransport: re-register failed (${e?.message ?? e})`);
        });
        this.log('info', `recoverTransport: re-register done (state=${this._state})`);
        return this._state === 'registered';
      }
    } catch {
      /* fall through to reconnect */
    }

    this.log('info', 'recoverTransport: socket dead — reconnecting');
    try {
      await this.withTimeout(this.ua.reconnect(), 8000);
      return true;
    } catch (e: any) {
      this.log('warn', `recoverTransport: reconnect failed (${e?.message})`);
    }

    // Full rebuild is safe only with no live calls — otherwise keep local state.
    if (this.activeCalls.length > 0) {
      this.log('warn', 'recoverTransport: live call present — keeping local state, no re-init');
      return false;
    }
    this.log('info', 'recoverTransport: full re-initialize');
    // Capture first — shutdown() nulls profile.
    const profile = this.profile;
    const settings = this.settings;
    try {
      await this.shutdown();
      await this.initialize(profile!, settings!);
      return this._state === 'registered';
    } catch (e: any) {
      this.log('warn', `recoverTransport: re-initialize failed (${e?.message})`);
      return false;
    }
  }

  private async reRegister(): Promise<void> {
    if (!this.registerer) return;
    await this.registerer.register({
      requestDelegate: {
        onReject: (resp: any) => {
          this.log('warn', `recover re-register rejected: ${resp?.message?.statusCode}`);
        },
      },
    });
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      t = window.setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([p, timeout]).finally(() => window.clearTimeout(t)) as Promise<T>;
  }

  // ================== Calls ==================

  async makeCall(target: string): Promise<string> {
    if (!this.ua) throw new Error('UA not started');
    if (this._state !== 'registered') throw new Error('not registered');

    const { Inviter, UserAgent } = this.sipjs;
    const profile = this.profile!;
    const sent = this.applyDialPrefix(target);
    const uriStr = this.toSipUri(sent, profile.sipDomain);
    const targetURI = UserAgent.makeURI(uriStr);
    if (!targetURI) throw new Error(`invalid target: ${uriStr}`);

    const inviter = new Inviter(this.ua, targetURI, {
      sessionDescriptionHandlerOptions: await this.callSdhOptions(),
      sessionDescriptionHandlerModifiers: this.sdpModifiers(),
      earlyMedia: true,
    });

    const id = this.genId();
    const call: CallSession = {
      id,
      direction: 'outgoing',
      // Log/display what the user dialed — the prefix is transport-only.
      remote: this.toSipUri(target, profile.sipDomain),
      status: 'connecting',
      startedAt: Date.now(),
      held: false,
      muted: false,
      internal: inviter,
    };
    this.sessions.set(id, call);
    this.bindSession(inviter, call);
    this.log('info', `Session created (outgoing, id=${id}, target=${uriStr})`);
    this.em.emit('outgoing', { ...call });

    await inviter.invite().catch((e: any) => {
      // Name fallback matters: WebView getUserMedia denials can carry an empty
      // message, which used to surface as a bare unhelpful "invite failed".
      this.failCall(call, e?.message || e?.name || 'invite failed');
      throw e;
    });
    return id;
  }

  private handleIncoming(invitation: AnySession): void {
    if (this._state !== 'registered') {
      this.log('warn', 'Incoming call while not registered — rejecting');
      try {
        invitation.reject({ statusCode: 503 });
      } catch {
        /* ignore */
      }
      return;
    }

    const id = this.genId();
    const remote = invitation.remoteIdentity?.uri?.toString() || 'unknown';
    const displayName = invitation.remoteIdentity?.displayName;
    const call: CallSession = {
      id,
      direction: 'incoming',
      remote,
      displayName,
      status: 'ringing',
      startedAt: Date.now(),
      held: false,
      muted: false,
      internal: invitation,
    };
    this.sessions.set(id, call);
    this.bindSession(invitation, call);
    this.log('info', `Session created (incoming, id=${id}, from=${displayName || remote})`);
    this.em.emit('incoming', { ...call });
  }

  async answer(callId: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call) return;
    // Guard: a second tap while accept() is in flight throws and — worse —
    // failCall()s a call that is about to establish (dialpad flash, then chaos).
    if (this.pendingAnswer.has(callId)) return;
    this.pendingAnswer.add(callId);
    const invitation = call.internal as AnySession;
    // Optimistic: move off 'ringing' now so the incoming overlay drops and the
    // call screen appears instantly; Established (post-ACK) confirms it.
    call.status = 'connecting';
    (call as { answerPressedAt?: number }).answerPressedAt = Date.now();
    this.log('info', `answer() pressed (id=${callId})`);
    this.em.emit('callUpdate', { ...call });
    try {
      const t0 = Date.now();
      await invitation.accept({
        sessionDescriptionHandlerOptions: await this.callSdhOptions(),
        sessionDescriptionHandlerModifiers: this.sdpModifiers(),
      });
      this.log('info', `answer() accept() resolved in ${Date.now() - t0}ms (200 OK sent; waiting ACK)`);
    } catch (e: any) {
      this.failCall(call, e?.message || e?.name || 'accept failed');
    } finally {
      this.pendingAnswer.delete(callId);
    }
  }

  async reject(callId: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call) return;
    const invitation = call.internal as AnySession;
    try {
      await invitation.reject({ statusCode: 486, reasonPhrase: 'Busy Here' });
    } catch {
      /* may throw if already terminated */
    }
    this.endCall(call, 'rejected');
  }

  async hangup(callId: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call) return;
    // End the UI FIRST — session.bye() on an answered incoming call waits for
    // the ACK (dialog AckWait) before resolving, which can hang for seconds.
    // Awaiting it before endCall made the End button look dead on established
    // calls. BYE is still sent in the background (on ACK if needed).
    this.endCall(call, 'hangup');
    await this.terminateInternal(call.internal).catch(() => {});
  }

  async hold(callId: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call || call.held) return;
    const s = call.internal as AnySession;
    try {
      this.logTransceiverDirections(s, 'before hold');
      // Use SIP.js's built-in `hold` option instead of the holdModifier.
      // The holdModifier only modifies SDP TEXT after createOffer, which
      // desyncs the WebRTC transceiver's internal direction state —
      // setLocalDescription with a=sendonly silently changes transceiver.direction
      // to sendonly, and the WebRTC stack may not properly resume on the next offer.
      // The `hold: true` option makes updateDirection() call setDirection("sendonly")
      // BEFORE createOffer, so createOffer naturally produces a=sendonly and the
      // transceiver state stays consistent. See BUGS.md #003.
      await s.invite({
        sessionDescriptionHandlerOptions: { hold: true },
        sessionDescriptionHandlerModifiers: this.sdpModifiers(),
        requestDelegate: {
          onAccept: () => {
            this.log('info', `hold onAccept: 200 OK received`);
            this.logTransceiverDirections(s, 'after hold answer');
          },
          onReject: (resp: any) => {
            this.log('warn', `hold re-INVITE rejected: ${resp?.message?.statusCode}`);
          },
        },
      });
      call.held = true;
      call.status = 'held';
      this.em.emit('callUpdate', { ...call });
    } catch (e: any) {
      this.log('warn', `hold failed: ${e?.message}`);
    }
  }

  async resume(callId: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call || !call.held) return;
    const s = call.internal as AnySession;
    try {
      this.logTransceiverDirections(s, 'before resume');
      // Use `hold: false` to make updateDirection() reset the transceiver
      // direction to "sendrecv" BEFORE createOffer. This ensures the offer
      // contains a=sendrecv and the PBX resumes sending RTP.
      // requestDelegate.onAccept fires AFTER setAnswer → setRemoteDescription
      // completes — the remote description is applied, transceiver direction
      // is updated, and the track is ready to receive. See BUGS.md #003.
      await s.invite({
        sessionDescriptionHandlerOptions: { hold: false },
        sessionDescriptionHandlerModifiers: this.sdpModifiers(),
        requestDelegate: {
          onAccept: () => {
            this.log('info', `resume onAccept: 200 OK received, answer applied — re-attaching audio`);
            this.logTransceiverDirections(s, 'after resume answer');
            this.attachRemoteAudio(s);
          },
          onReject: (resp: any) => {
            this.log('warn', `resume re-INVITE rejected: ${resp?.message?.statusCode} ${resp?.message?.reasonPhrase}`);
          },
        },
      });
      call.held = false;
      call.status = 'in-call';
      this.em.emit('callUpdate', { ...call });
    } catch (e: any) {
      this.log('warn', `resume failed: ${e?.message}`);
    }
  }

  private logTransceiverDirections(session: AnySession, label: string): void {
    const pc = session?.sessionDescriptionHandler?.peerConnection as RTCPeerConnection | undefined;
    if (!pc) return;
    const transceivers = pc.getTransceivers();
    transceivers.forEach((t: RTCRtpTransceiver, i: number) => {
      this.log('info', `transceiver[${i}] ${label}: direction=${t.direction} currentDirection=${t.currentDirection} mid=${t.mid}`);
    });
    this.log('info', `ICE ${label}: connectionState=${pc.iceConnectionState} gatheringState=${pc.iceGatheringState} signalingState=${pc.signalingState}`);
  }

  setMute(callId: string, muted: boolean): void {
    const call = this.sessions.get(callId);
    if (!call) return;
    const s = call.internal as AnySession;
    const pc = s?.sessionDescriptionHandler?.peerConnection as RTCPeerConnection | undefined;
    if (!pc) return;
    pc.getSenders().forEach((sr) => {
      if (sr.track && sr.track.kind === 'audio') sr.track.enabled = !muted;
    });
    call.muted = muted;
    this.em.emit('callUpdate', { ...call });
  }

  async sendDtmf(callId: string, digit: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call) return;
    const s = call.internal as AnySession;
    const sdh = s?.sessionDescriptionHandler;
    const code = dtmfCode(digit);
    if (code == null) return;
    if (sdh && typeof sdh.sendDtmf === 'function') {
      try {
        const ok = sdh.sendDtmf(code, { duration: 160, interToneGap: 50 });
        if (ok) {
          this.log('debug', `DTMF ${digit} sent (RFC 4733)`);
          return;
        }
      } catch (e: any) {
        this.log('debug', `sendDtmf threw: ${e?.message}, falling back to INFO`);
      }
    }
    try {
      await s.info({
        requestDelegate: {
          onAccept: () => this.log('debug', `DTMF ${digit} sent (INFO)`),
          onReject: (r: any) => this.log('warn', `DTMF INFO rejected: ${r?.message?.statusCode}`),
        },
        requestOptions: {
          body: {
            contentBody: `Signal=${code}\r\nDuration=160\r\n`,
            contentType: 'application/dtmf-relay',
          },
        },
      });
    } catch (e: any) {
      this.log('warn', `DTMF failed: ${e?.message}`);
    }
  }

  async prepareTransfer(target: string): Promise<string> {
    return this.makeCall(target);
  }

  async blindTransfer(callId: string, target: string): Promise<void> {
    const call = this.sessions.get(callId);
    if (!call) return;
    const s = call.internal as AnySession;
    const uri = this.toSipUri(this.applyDialPrefix(target), this.profile!.sipDomain);
    const targetURI = this.sipjs.UserAgent.makeURI(uri);
    if (!targetURI) throw new Error('invalid transfer target');
    this.log('info', `Blind transfer: ${call.remote} → ${uri}`);
    this.log('info', `Refer-To URI: ${targetURI.toString()}`);
    this.log('info', `Refer-To user: ${targetURI.user} host: ${targetURI.host} scheme: ${targetURI.scheme}`);
    try {
      await s.refer(targetURI, {
        requestDelegate: {
          onAccept: (resp: any) => {
            const msg = resp?.message;
            this.log('info', `REFER accepted (${msg?.statusCode}) — headers: Refer-To=${msg?.getHeader?.('Refer-To')} Referred-By=${msg?.getHeader?.('Referred-By')}`);
          },
          onReject: (resp: any) =>
            this.log('warn', `REFER rejected: ${resp?.message?.statusCode} ${resp?.message?.reasonPhrase}`),
        },
        onNotify: (notification: any) => {
          const msg = notification?.request;
          const subState = msg?.getHeader?.('Subscription-State') || 'unknown';
          const body = msg?.body || '';
          const contentType = msg?.getHeader?.('Content-Type') || 'unknown';
          this.log('info', `TRANSFER NOTIFY: state=${subState} contentType=${contentType} body=${body.replace(/\r?\n/g, ' ').trim()}`);
          void notification.accept().catch(() => {});
          if (subState === 'terminated') {
            if (body.includes('200 OK')) {
              this.log('info', 'Transfer succeeded — sending BYE to original call');
              void this.hangup(callId);
            } else {
              this.log('warn', `Transfer failed: ${body.replace(/\r?\n/g, ' ').trim()}`);
            }
          }
        },
      });
    } catch (e: any) {
      this.log('warn', `transfer failed: ${e?.message}`);
    }
  }

  // ================== Session binding ==================

  private bindSession(session: AnySession, call: CallSession): void {
    const { SessionState } = this.sipjs;

    // SDH is created lazily inside invite()/accept(), AFTER bindSession runs
    // for outgoing calls — so hooking peerConnection here alone misses it and
    // early media (183 with SDP) never attaches. The delegate fires for every
    // SDH created (confirmed + provisional early-media ones). Hook those too.
    try {
      const prev = session.delegate?.onSessionDescriptionHandler;
      session.delegate = {
        ...(session.delegate || {}),
        onSessionDescriptionHandler: (sdh: any, provisional: boolean) => {
          try {
            (prev as any)?.call(session.delegate, sdh, provisional);
          } catch {
            /* ignore */
          }
          this.hookSdh(sdh, call);
        },
      };
    } catch {
      /* non-critical — confirmed-path hook below still runs */
    }

    // Hook peer connection for track diagnostics (audit point 1-3).
    // SIP.js sets pc.ontrack internally (session-description-handler.js:881);
    // addEventListener adds a SECOND listener without clobbering SIP.js's.
    this.hookPeerConnection(session, call);

    session.stateChange.addListener((state: any) => {
      this.log('debug', `session ${call.id} state: ${state}`);
      switch (state) {
        case SessionState.Establishing:
          if (call.direction === 'outgoing') {
            call.status = 'ringing';
            this.em.emit('callUpdate', { ...call });
          }
          break;
        case SessionState.Established: {
          call.status = 'in-call';
          call.connectedAt = Date.now();
          const pressed = (call as { answerPressedAt?: number }).answerPressedAt;
          if (pressed) {
            this.log('info', `Established: press→media-path ${Date.now() - pressed}ms (id=${call.id})`);
          }
          this.attachRemoteAudio(session);
          this.capSenderBitrate(session);
          this.em.emit('presence', this.presence);
          this.em.emit('callUpdate', { ...call });
          break;
        }
        case SessionState.Terminating:
          call.status = 'ended';
          break;
        case SessionState.Terminated:
          this.endCall(call, call.reason || 'terminated');
          if (this.activeCalls.length === 0 && this._state === 'registered') {
            this.em.emit('presence', this.presence);
          }
          break;
      }
    });
  }

  // ============================================================
  // Media Pipeline Diagnostics
  // ============================================================
  //
  // Audit points 1-3: verify RTCPeerConnection ontrack fires and log
  // event.track.kind, readyState, enabled, event.streams.length.
  // Uses addEventListener (not the ontrack property) so SIP.js's own
  // handler at session-description-handler.js:881 is preserved.
  private hookedPcs = new WeakSet<RTCPeerConnection>();

  private hookPeerConnection(session: AnySession, call: CallSession): void {
    const sdh = session?.sessionDescriptionHandler;
    if (!sdh) {
      this.log('debug', `hookPeerConnection(${call.id}): no SDH yet — delegate hook will attach on creation`);
      return;
    }
    this.hookSdh(sdh, call);
  }

  private hookSdh(sdh: any, call: CallSession): void {
    const pc = sdh?.peerConnection as RTCPeerConnection | undefined;
    if (!pc) {
      this.log('warn', `hookSdh(${call.id}): no peerConnection yet — will retry on Established`);
      return;
    }
    if (this.hookedPcs.has(pc)) return;
    this.hookedPcs.add(pc);
    pc.addEventListener('track', (event: RTCTrackEvent) => {
      this.log('info', `ontrack(${call.id}): kind=${event.track.kind} readyState=${event.track.readyState} enabled=${event.track.enabled} muted=${event.track.muted} streams=${event.streams.length}`);
      if (event.track.kind === 'audio' && this.remoteAudio && event.streams.length > 0) {
        this.remoteAudio.muted = false;
        if (this.remoteAudio.volume === 0) this.remoteAudio.volume = 1;
        this.remoteAudio.srcObject = event.streams[0];
        void this.remoteAudio
          .play()
          .then(() => this.log('info', `ontrack attach: play() succeeded (inDOM=${this.remoteAudio?.isConnected})`))
          .catch((e: any) => this.log('error', `ontrack attach: play() FAILED: ${e?.name}: ${e?.message}`));
      }
    });

    // Log ICE state changes — critical for diagnosing hold/resume media issues.
    // If ICE goes to "disconnected" or "failed" during a re-INVITE, RTP won't flow.
    pc.addEventListener('iceconnectionstatechange', () => {
      this.log('info', `ICE state changed: ${pc.iceConnectionState} (signaling=${pc.signalingState})`);
    });
    pc.addEventListener('connectionstatechange', () => {
      this.log('info', `PC connection state: ${pc.connectionState}`);
    });

    this.log('debug', `hookPeerConnection(${call.id}): track + ICE listeners attached`);
  }

  // ============================================================
  // attachRemoteAudio — audit points 4-13
  // ============================================================
  private attachRemoteAudio(session: AnySession): void {
    const sdh = session.sessionDescriptionHandler;
    if (!sdh) {
      this.log('error', 'attachRemoteAudio: no sessionDescriptionHandler');
      return;
    }
    if (!this.remoteAudio) {
      this.log('error', 'attachRemoteAudio: no audio element registered — voice will not play');
      return;
    }

    // Audit point 7: inspect remoteAudio.srcObject before attaching
    this.log('info', `attachRemoteAudio: BEFORE — audio.srcObject=${this.remoteAudio.srcObject ? 'yes' : 'null'} inDOM=${this.remoteAudio.isConnected} muted=${this.remoteAudio.muted} volume=${this.remoteAudio.volume} paused=${this.remoteAudio.paused}`);

    // Audit point 4: attach the received MediaStream to the audio element
    const remote = sdh.remoteMediaStream ?? sdh._remoteMediaStream;
    const tracks = remote ? remote.getTracks() : [];
    this.log('info', `attachRemoteAudio: remoteMediaStream=${remote ? 'yes' : 'no'} tracks=${tracks.length}`);
    tracks.forEach((t: MediaStreamTrack, i: number) => {
      this.log('info', `  stream track[${i}]: kind=${t.kind} readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}`);
    });

    if (remote && tracks.length > 0) {
      this.remoteAudio.muted = false;
      if (this.remoteAudio.volume === 0) this.remoteAudio.volume = 1;
      this.remoteAudio.srcObject = remote;
      this.log('info', `attachRemoteAudio: srcObject SET on audio element (inDOM=${this.remoteAudio.isConnected})`);

      // Audit point 5: log whether play() succeeds or throws
      void this.remoteAudio
        .play()
        .then(() => {
          this.log('info', `audio.play() SUCCEEDED — paused=${this.remoteAudio?.paused} currentTime=${this.remoteAudio?.currentTime} volume=${this.remoteAudio?.volume} muted=${this.remoteAudio?.muted} srcObject=${this.remoteAudio?.srcObject ? 'yes' : 'null'}`);
        })
        .catch((e: any) => {
          this.log('error', `audio.play() FAILED: ${e?.name}: ${e?.message} (paused=${this.remoteAudio?.paused} muted=${this.remoteAudio?.muted})`);
        });
    } else {
      this.log('warn', 'attachRemoteAudio: no remote tracks yet — track listener will late-attach on ontrack event');
    }

    // Audit point 8-9: dump ALL audio elements in the DOM
    this.dumpAudioElements();

    // Audit points 10-11: inspect receivers and getStats
    const pc = sdh.peerConnection as RTCPeerConnection | undefined;
    if (pc) {
      // Re-enable receiver tracks: during hold, the remote stops sending RTP
      // and the browser marks the receiver track as muted. On resume, if the
      // SSRC is unchanged, the same track is reused and should unmute when
      // RTP flows again. But if anything disabled the track (enabled=false),
      // it produces silence even when unmuted. Explicitly re-enable to be
      // safe. SIP.js's SessionManager does the same via enableReceiverTracks.
      pc.getReceivers().forEach((r: RTCRtpReceiver) => {
        if (r.track && r.track.kind === 'audio') {
          if (!r.track.enabled) {
            this.log('info', `attachRemoteAudio: re-enabling disabled audio receiver track`);
            r.track.enabled = true;
          }
        }
      });
      this.dumpReceivers(pc);
      void this.dumpInboundStats(pc);
      this.startStatsPolling(pc);
    } else {
      this.log('error', 'attachRemoteAudio: no peerConnection on SDH — cannot inspect receivers/stats');
    }

    // Output device (setSinkId)
    const out = this.settings?.audio.outputDeviceId;
    if (out && typeof (this.remoteAudio as any).setSinkId === 'function') {
      void (this.remoteAudio as any)
        .setSinkId(out)
        .catch((e: any) => this.log('warn', `setSinkId('${out}') failed: ${e?.message}`));
    }
  }

  // Audit point 8-9: dump every <audio> element in the DOM with full state.
  private dumpAudioElements(): void {
    const els = document.getElementsByTagName('audio');
    this.log('info', `DOM audio elements: ${els.length}`);
    for (let i = 0; i < els.length; i++) {
      const a = els[i];
      this.log('info', `  audio[${i}]: id=${a.id || '(none)'} inDOM=${a.isConnected} muted=${a.muted} volume=${a.volume} paused=${a.paused} currentTime=${a.currentTime} srcObject=${a.srcObject ? 'yes' : 'null'} autoplay=${a.autoplay} playsInline=${(a as any).playsInline}`);
    }
  }

  // Audit point 10: verify an audio receiver exists and has a live track.
  private dumpReceivers(pc: RTCPeerConnection): void {
    const receivers = pc.getReceivers();
    this.log('info', `pc.getReceivers(): ${receivers.length}`);
    receivers.forEach((r: RTCRtpReceiver, i: number) => {
      const t = r.track;
      this.log('info', `  receiver[${i}]: kind=${t?.kind ?? 'null'} readyState=${t?.readyState ?? 'null'} enabled=${t?.enabled} muted=${t?.muted}`);
    });
    const audioRx = receivers.find((r) => r.track?.kind === 'audio');
    if (!audioRx) {
      this.log('error', 'NO audio receiver found — remote audio track missing from peer connection');
    } else if (audioRx.track?.readyState !== 'live') {
      this.log('warn', `audio receiver track is NOT live (readyState=${audioRx.track?.readyState})`);
    } else {
      this.log('info', 'audio receiver OK — track is live');
    }
  }

  // Audit point 11: find inbound audio RTP report and print packetsReceived,
  // bytesReceived, jitter, audioLevel. If packetsReceived is increasing,
  // media is arriving at the peer connection. Also resolves the negotiated
  // outbound codec (mimeType) — proof of which codec the call actually uses.
  private async dumpInboundStats(pc: RTCPeerConnection): Promise<void> {
    try {
      const stats = await pc.getStats();
      const mime = new Map<string, string>();
      stats.forEach((report: any) => {
        if (report.type === 'codec' && report.id && report.mimeType) {
          mime.set(report.id, String(report.mimeType));
        }
      });
      let foundIn = false;
      let foundOut = false;
      stats.forEach((report: any) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          foundIn = true;
          this.log('info', `inbound audio RTP: packetsReceived=${report.packetsReceived} bytesReceived=${report.bytesReceived} jitter=${report.jitter} audioLevel=${report.audioLevel} packetsLost=${report.packetsLost}`);
        }
        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
          foundOut = true;
          const codec = report.mimeType ?? mime.get(report.codecId) ?? 'unknown';
          this.log('info', `outbound audio RTP: codec=${codec} packetsSent=${report.packetsSent} bytesSent=${report.bytesSent}`);
        }
      });
      if (!foundIn) {
        this.log('warn', 'getStats(): no inbound audio RTP report yet — media may not have started flowing');
      }
      if (!foundOut) {
        this.log('warn', 'getStats(): no outbound audio RTP report yet');
      }
    } catch (e: any) {
      this.log('warn', `getStats() failed: ${e?.message}`);
    }
  }

  // Poll getStats() every 3s during a call to verify packetsReceived is
  // increasing. Stops when the call ends. Logs the negotiated codec once
  // media is flowing, plus outbound kbps as the bandwidth proof.
  private startStatsPolling(pc: RTCPeerConnection): void {
    this.stopStatsPolling();
    let lastPackets = -1;
    let lastBytesSent = -1;
    let codecLogged = false;
    this.statsTimer = window.setInterval(() => {
      void pc.getStats().then((stats) => {
        const mime = new Map<string, string>();
        stats.forEach((report: any) => {
          if (report.type === 'codec' && report.id && report.mimeType) {
            mime.set(report.id, String(report.mimeType));
          }
        });
        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            const delta = report.packetsReceived - lastPackets;
            if (lastPackets >= 0) {
              this.log('info', `inbound audio: packetsReceived=${report.packetsReceived} (+${delta} in 3s) audioLevel=${report.audioLevel}`);
            }
            lastPackets = report.packetsReceived;
          }
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            const codec = report.mimeType ?? mime.get(report.codecId) ?? 'unknown';
            if (!codecLogged && codec !== 'unknown') {
              codecLogged = true;
              this.log('info', `negotiated outbound codec: ${codec}`);
            }
            if (lastBytesSent >= 0) {
              const kbps = (((report.bytesSent - lastBytesSent) * 8) / 3000).toFixed(1);
              this.log('info', `outbound audio: ${kbps} kbps (codec=${codec})`);
            }
            lastBytesSent = report.bytesSent;
          }
        });
      });
    }, 3000);
  }

  private stopStatsPolling(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  // Public: on-demand full pipeline diagnosis (callable from console or UI).
  async diagnoseAudioPipeline(callId?: string): Promise<void> {
    const call = callId ? this.sessions.get(callId) : this.activeCalls[0];
    if (!call) {
      this.log('warn', 'diagnoseAudioPipeline: no active call');
      return;
    }
    const sdh = (call.internal as AnySession)?.sessionDescriptionHandler;
    const pc = sdh?.peerConnection as RTCPeerConnection | undefined;
    this.log('info', `=== AUDIO PIPELINE DIAGNOSIS (call ${call.id}) ===`);
    this.log('info', `remoteAudio registered: ${this.remoteAudio ? 'yes' : 'NO'}`);
    if (this.remoteAudio) {
      this.log('info', `remoteAudio: inDOM=${this.remoteAudio.isConnected} muted=${this.remoteAudio.muted} volume=${this.remoteAudio.volume} paused=${this.remoteAudio.paused} currentTime=${this.remoteAudio.currentTime} srcObject=${this.remoteAudio.srcObject ? 'yes' : 'null'}`);
    }
    this.dumpAudioElements();
    if (pc) {
      this.dumpReceivers(pc);
      await this.dumpInboundStats(pc);
    } else {
      this.log('warn', 'diagnoseAudioPipeline: no peerConnection');
    }
    this.log('info', `=== END DIAGNOSIS ===`);
  }

  private async terminateInternal(session: AnySession): Promise<void> {
    if (!session) return;
    const state = session.state;
    if (state === 'Terminated' || state === 'Terminating') return;

    try {
      // Dispatch on session STATE, not method existence. An Inviter has both
      // cancel() and bye(); calling cancel() on an Established Inviter throws
      // "Invalid session state Established" and the empty catch swallows it,
      // so BYE is never sent and the remote channel stays alive.
      //   Established     → bye()     (sends SIP BYE — tears down confirmed dialog)
      //   Initial/Establishing + Inviter    → cancel()  (sends SIP CANCEL)
      //   Initial/Establishing + Invitation → reject()  (sends 486/487)
      if (state === 'Established') {
        if (typeof session.bye === 'function') {
          // ponytail: bye() pends until ACK arrives when dialog is in AckWait
          // (callee just answered). Bound it so shutdown/hangup never hang.
          await Promise.race([
            session.bye(),
            new Promise((resolve) => setTimeout(resolve, 2500)),
          ]);
        }
      } else if (typeof session.cancel === 'function') {
        await session.cancel();
      } else if (typeof session.reject === 'function') {
        await session.reject({ statusCode: 487, reasonPhrase: 'Request Terminated' });
      }
    } catch (e: any) {
      this.log('warn', `terminate failed (state=${state}): ${e?.message}`);
    }
  }

  private endCall(call: CallSession, reason: string): void {
    if (call.status === 'ended' || call.status === 'failed') return;
    call.status = 'ended';
    call.endedAt = Date.now();
    call.reason = reason;
    if (this.activeCalls.length === 0) this.stopStatsPolling();
    this.log('info', `Session destroyed (id=${call.id}, reason=${reason})`);
    this.em.emit('callEnded', { ...call }, reason);
    this.em.emit('callUpdate', { ...call });
    setTimeout(() => this.sessions.delete(call.id), 60_000);
  }

  private failCall(call: CallSession, reason: string): void {
    call.status = 'failed';
    call.reason = reason;
    call.endedAt = Date.now();
    this.log('warn', `Session failed (id=${call.id}, reason=${reason})`);
    this.em.emit('callEnded', { ...call }, reason);
    this.em.emit('callUpdate', { ...call });
    setTimeout(() => this.sessions.delete(call.id), 60_000);
  }

  // ================== Helpers ==================

  private buildIceServers(profile: SipProfile, _settings: AppSettings): IceServerSpec[] {
    const servers: IceServerSpec[] = profile.iceServers ?? [];
    if (servers.length === 0) {
      servers.push({ urls: 'stun:stun.l.google.com:19302' });
    }
    return servers;
  }

  // Trial outcome cache — avoids re-probing the mic on every call.
  // Reset when the selected input device changes.
  private relaxedAudio: boolean | null = null;
  private lastMicDeviceId: string | undefined = undefined;

  private fullAudioConstraints(): MediaTrackConstraints {
    const audio = this.settings!.audio;
    return {
      deviceId: audio.inputDeviceId ? { exact: audio.inputDeviceId } : undefined,
      echoCancellation: audio.echoCancellation,
      noiseSuppression: audio.noiseSuppression,
      autoGainControl: audio.autoGainControl,
    } as MediaTrackConstraints;
  }

  // Some phones reject the full constraint set with OverconstrainedError
  // (particular device + processing-flag combos in the WebView). Trial the
  // full set once per device; fall back to plain audio and remember it.
  private async callSdhOptions(): Promise<{ constraints: MediaStreamConstraints }> {
    const audio = await this.resolveAudioConstraints();
    return { constraints: { audio, video: false } };
  }

  // Enforces Settings → Codecs order + the balanced Opus profile on every
  // local description we generate (offer, answer, hold/resume re-INVITE).
  // SIP.js runs these after createOffer/createAnswer, before signaling.
  private sdpModifiers(): Array<(d: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>> {
    const prefs = this.settings?.codecs ?? [];
    const kbps = this.settings?.audio.opusKbps ?? 32;
    return [
      async (d) => ({ ...d, sdp: tuneOpus(applyCodecPrefs(d.sdp ?? '', prefs), opusTuning(kbps)) }),
    ];
  }

  // Belt-and-braces: cap the outbound encoder for stacks that ignore the
  // fmtp bitrate hint. Fire-and-forget; a failure just keeps fmtp behavior.
  private capSenderBitrate(session: AnySession): void {
    const cap = senderMaxBitrate(this.settings?.audio.opusKbps ?? 32);
    try {
      const pc = session?.sessionDescriptionHandler?.peerConnection as RTCPeerConnection | undefined;
      pc?.getSenders().forEach((sender) => {
        if (sender.track?.kind !== 'audio') return;
        const params = sender.getParameters();
        if (params.encodings?.[0]?.maxBitrate === cap) return;
        void sender
          .setParameters({ ...params, encodings: [{ ...(params.encodings?.[0] ?? {}), maxBitrate: cap }] })
          .then(() => this.log('info', `sender capped at ${cap / 1000}kbps`))
          .catch((e: unknown) => this.log('warn', `sender cap failed: ${(e as Error)?.message}`));
      });
    } catch {
      /* non-fatal — fmtp tuning still applies */
    }
  }

  // Warms the mic-constraint trial at registration so the answer/dial path
  // pays zero setup cost. Fire-and-forget; failures just mean the trial
  // happens lazily on the next call.
  async warmupMedia(): Promise<void> {
    if (!this.settings) return;
    try {
      await this.resolveAudioConstraints();
    } catch {
      /* lazy trial on next call */
    }
  }

  private async resolveAudioConstraints(): Promise<MediaTrackConstraints | boolean> {
    const dev = this.settings!.audio.inputDeviceId;
    if (dev !== this.lastMicDeviceId) {
      this.relaxedAudio = null;
      this.lastMicDeviceId = dev;
    }
    if (this.relaxedAudio === true) return true;
    if (this.relaxedAudio === false) return this.fullAudioConstraints();
    if (!navigator.mediaDevices?.getUserMedia) return this.fullAudioConstraints();
    const t0 = Date.now();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: this.fullAudioConstraints(),
        video: false,
      });
      stream.getTracks().forEach((t) => t.stop());
      this.relaxedAudio = false;
      this.log('info', `mic trial: full constraints OK (${Date.now() - t0}ms)`);
      return this.fullAudioConstraints();
    } catch (e: any) {
      if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
        this.log('warn', `mic full constraints rejected (${e?.name}: ${e?.constraint || e?.message}) — using plain audio`);
        this.relaxedAudio = true;
        return true;
      }
      throw e;
    }
  }

  // Outbound dial prefix (per profile, blank = disabled). Applied to
  // bare-number dials only — full SIP URIs pass through untouched.
  // Read from live settings (not the connect-time snapshot) so a profile
  // edit applies on the next call.
  private applyDialPrefix(target: string): string {
    const t = target.trim();
    const prefix = (this.settings?.profiles.find((p) => p.id === this.profile?.id)?.dialPrefix ?? '').trim();
    if (!prefix) return t;
    if (t.startsWith('sip:') || t.includes('@')) return t;
    const sent = `${prefix}${t}`;
    this.log('info', `dial prefix '${prefix}': sending ${sent}`);
    return sent;
  }

  private toSipUri(target: string, domain: string): string {    const s = target.trim();
    if (s.startsWith('sip:')) return s;
    if (s.includes('@')) return `sip:${s}`;
    const cleaned = s.replace(/[^\d*#+]/g, '');
    return `sip:${cleaned}@${domain}`;
  }

  private genId(): string {
    return `c_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void {
    this.em.emit('log', level, msg, data);
  }
}

function dtmfCode(d: string): string | null {
  const m = d.toUpperCase();
  if (/^[0-9*#A-D]$/.test(m)) return m;
  return null;
}

// Singleton — the one and only SIP service for the application lifetime.
export const sipEngine = new SipService();
