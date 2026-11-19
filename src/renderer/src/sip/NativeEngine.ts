import type { AppSettings, SipProfile } from '@shared/types';
import type { SipEngineEvent, SipHelperCallState } from '@shared/sipHelper';
import {
  Emitter,
  type CallSession,
  type SipEngineEvents,
  type SipServiceState,
  type SoftphoneStatus,
} from './SipEngine';

// The native engine: pjsua inside resources/sip-helper.exe, driven through the
// main process. The helper owns the sound device and the ringtone; nothing is
// played by the renderer on a native call. It exposes the same surface as the
// WebRTC engine so the facade can swap them under the stores.

function sipParty(uri: string): { remote: string; displayName?: string } {
  const angle = uri.indexOf('<');
  if (angle >= 0) {
    const name = uri.slice(0, angle).trim().replace(/^"+|"+$/g, '');
    return { remote: sipUser(uri.slice(angle + 1)), displayName: name || undefined };
  }
  return { remote: sipUser(uri) };
}

function sipUser(uri: string): string {
  const bare = uri.replace(/^sips?:/i, '');
  const at = bare.indexOf('@');
  return (at >= 0 ? bare.slice(0, at) : bare).replace(/[;>].*$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// G.729 first: the point of the native engine on a call center LAN, with the
// narrowband G.711 as the fallback. The helper switches the others off.
const NATIVE_CODECS = ['G729', 'PCMA', 'PCMU'];

export class NativeEngine {
  private em = new Emitter();
  private _state: SipServiceState = 'disconnected';
  private profile: SipProfile | null = null;
  private calls = new Map<string, CallSession>();
  // A state can race the answer of the "call" command: it is replayed when the
  // id is known.
  private early = new Map<number, { state: SipHelperCallState; text: string }>();
  private unsubscribe: (() => void) | null = null;
  private generation = 0;

  get state(): SipServiceState {
    return this._state;
  }

  get presence(): SoftphoneStatus {
    if (this._state === 'registered') {
      return this.activeCalls.some((c) => c.status === 'in-call') ? 'on-call' : 'registered';
    }
    if (this._state === 'connecting' || this._state === 'registering') return 'registering';
    if (this._state === 'reconnecting' || this._state === 'registration-failed') {
      return 'connection-lost';
    }
    return 'offline';
  }

  // The helper restart and the re-registration live in the main process.
  get recovering(): boolean {
    return false;
  }

  get activeCalls(): CallSession[] {
    return [...this.calls.values()].filter((c) => c.status !== 'ended' && c.status !== 'failed');
  }

  getCall(id: string): CallSession | undefined {
    return this.calls.get(id);
  }

  get currentProfileId(): string | null {
    return this.profile?.id ?? null;
  }

  on<K extends keyof SipEngineEvents>(ev: K, cb: SipEngineEvents[K]): () => void {
    return this.em.on(ev, cb);
  }

  setRemoteAudio(_el: HTMLAudioElement): void {
    // the helper plays the remote audio through its own sound device
  }

  updateSettings(_settings: AppSettings): void {
    // the codecs and the devices of a native call are set at registration
  }

  async initialize(profile: SipProfile, settings: AppSettings): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.profile = profile;
    this.unsubscribe?.();
    this.unsubscribe = window.api.onSipEvent((event) => {
      if (generation === this.generation) this.handle(event);
    });

    this.setState('connecting');
    this.em.emit('transport', true);
    try {
      await window.api.sipCommand({
        cmd: 'register',
        server: profile.sipDomain,
        port: profile.sipPort ?? 5060,
        extension: profile.username,
        password: profile.password,
        transport: profile.transport ?? 'udp',
        codecs: NATIVE_CODECS,
      });
      if (this._state === 'connecting') this.setState('registering');
    } catch (error) {
      this.setState('registration-failed');
      this.em.emit('transport', false);
      this.em.emit('registrationFailed', errorMessage(error));
      throw error;
    }
    this.em.emit('log', 'info', `native engine: ${profile.username}@${profile.sipDomain}`);
    void settings; // kept for parity with the WebRTC engine's signature
  }

  async cancelConnect(): Promise<void> {
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.profile = null;
    for (const call of this.calls.values()) this.finish(call, 'shutdown');
    this.calls.clear();
    this.early.clear();
    this.setState('disconnected');
    this.em.emit('unregistered');
    this.em.emit('transport', false);
    await window.api.sipCommand({ cmd: 'unregister' }).catch(() => {});
  }

  async recoverTransport(): Promise<boolean> {
    return false;
  }

  async makeCall(target: string): Promise<string> {
    if (this._state !== 'registered') throw new Error('not registered');
    const answer = await window.api.sipCommand({ cmd: 'call', target });
    const callId = answer.callId;
    if (typeof callId !== 'number') throw new Error('the native engine did not return a call');

    const id = String(callId);
    const call: CallSession = {
      id,
      direction: 'outgoing',
      remote: target,
      status: 'connecting',
      startedAt: Date.now(),
      held: false,
      muted: false,
      internal: { callId },
    };
    this.calls.set(id, call);
    this.em.emit('outgoing', { ...call });

    const early = this.early.get(callId);
    this.early.delete(callId);
    if (early) this.applyState(call, early.state, early.text);
    return id;
  }

  async answer(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.direction !== 'incoming') return;
    await window.api.sipCommand({ cmd: 'answer', callId: Number(callId) });
  }

  async reject(callId: string): Promise<void> {
    // hanging up before the answer is the decline of pjsua
    await this.hangup(callId);
  }

  async hangup(callId: string): Promise<void> {
    if (!this.calls.has(callId)) return;
    await window.api.sipCommand({ cmd: 'hangup', callId: Number(callId) });
  }

  async hold(callId: string): Promise<void> {
    if (!this.calls.has(callId)) return;
    await window.api.sipCommand({ cmd: 'hold', callId: Number(callId), on: true });
  }

  async resume(callId: string): Promise<void> {
    if (!this.calls.has(callId)) return;
    await window.api.sipCommand({ cmd: 'hold', callId: Number(callId), on: false });
  }

  setMute(callId: string, muted: boolean): void {
    if (!this.calls.has(callId)) return;
    void window.api.sipCommand({ cmd: 'mute', callId: Number(callId), on: muted }).catch(() => {});
  }

  async sendDtmf(callId: string, digit: string): Promise<void> {
    if (!this.calls.has(callId)) return;
    await window.api.sipCommand({ cmd: 'dtmf', callId: Number(callId), digits: digit });
  }

  async blindTransfer(callId: string, target: string): Promise<void> {
    if (!this.calls.has(callId)) return;
    await window.api.sipCommand({ cmd: 'transfer', callId: Number(callId), target });
  }

  warmupMedia(): Promise<void> {
    return Promise.resolve();
  }

  // ================== The events of the helper ==================

  private handle(event: SipEngineEvent): void {
    switch (event.event) {
      case 'registration':
        if (event.ok) {
          this.setState('registered');
          this.em.emit('registered');
          this.em.emit('transport', true);
        } else {
          this.setState('registration-failed');
          this.em.emit('transport', false);
          this.em.emit('registrationFailed', `registration failed (${event.status})`);
        }
        break;

      case 'incoming': {
        if (this._state !== 'registered') {
          void window.api.sipCommand({ cmd: 'hangup', callId: event.callId }).catch(() => {});
          return;
        }
        this.early.delete(event.callId);
        const id = String(event.callId);
        if (this.calls.has(id)) return;
        const party = sipParty(event.from);
        const call: CallSession = {
          id,
          direction: 'incoming',
          remote: party.remote,
          displayName: party.displayName,
          status: 'ringing',
          startedAt: Date.now(),
          held: false,
          muted: false,
          internal: { callId: event.callId },
        };
        this.calls.set(id, call);
        this.em.emit('incoming', { ...call });
        break;
      }

      case 'callState': {
        const call = this.calls.get(String(event.callId));
        if (!call) {
          this.early.set(event.callId, { state: event.state, text: event.text });
          if (this.early.size > 8) {
            const oldest = this.early.keys().next().value;
            if (oldest !== undefined) this.early.delete(oldest);
          }
          return;
        }
        this.applyState(call, event.state, event.text);
        break;
      }

      case 'media': {
        const call = this.calls.get(String(event.callId));
        if (!call || !call.connectedAt) return;
        // pjsua turns the media of a held call inactive
        if (event.active && call.status === 'held') {
          call.status = 'in-call';
          call.held = false;
          this.em.emit('callUpdate', { ...call });
          this.em.emit('presence', this.presence);
        } else if (!event.active && call.status === 'in-call') {
          call.status = 'held';
          call.held = true;
          this.em.emit('callUpdate', { ...call });
        }
        break;
      }

      case 'codecs':
        this.em.emit(
          'log',
          'info',
          `native codecs: ${event.codecs.map((c) => `${c.id}(${c.priority})`).join(', ')}`,
        );
        break;

      case 'error':
        this.em.emit('log', 'error', `native engine: ${event.message}`);
        break;

      case 'helper':
        if (this._state === 'registered' || this._state === 'registering') {
          // the main process registers the account again on a fresh process
          this.setState('reconnecting');
          this.em.emit('log', 'warn', 'the native engine restarted');
          if (event.alive) this.setState('registering');
        }
        break;
    }
  }

  private applyState(call: CallSession, state: SipHelperCallState, text: string): void {
    switch (state) {
      case 'CALLING':
      case 'EARLY':
        if (call.status === 'ringing' || call.status === 'connecting') {
          call.status = 'connecting';
          this.em.emit('callUpdate', { ...call });
        }
        break;
      case 'INCOMING':
        break;
      case 'CONFIRMED':
        if (call.status !== 'in-call' && call.status !== 'held') {
          call.status = 'in-call';
          call.connectedAt = Date.now();
          call.held = false;
          this.em.emit('callUpdate', { ...call });
          this.em.emit('presence', this.presence);
        }
        break;
      case 'DISCONNECTED':
        this.finish(call, text);
        break;
      default:
        break;
    }
  }

  private finish(call: CallSession, reason: string): void {
    if (call.status === 'ended' || call.status === 'failed') return;
    call.status = call.connectedAt ? 'ended' : 'failed';
    call.endedAt = Date.now();
    call.reason = reason || call.status;
    this.em.emit('callUpdate', { ...call });
    this.em.emit('callEnded', { ...call }, call.reason);
    this.em.emit('presence', this.presence);
  }

  private setState(next: SipServiceState): void {
    this._state = next;
    this.em.emit('stateChange', next);
    this.em.emit('presence', this.presence);
  }
}
