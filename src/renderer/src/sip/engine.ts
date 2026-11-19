import type { AppSettings, SipProfile } from '@shared/types';
import {
  Emitter,
  sipEngine as webrtc,
  type CallSession,
  type SipEngineEvents,
  type SipServiceState,
  type SoftphoneStatus,
} from './SipEngine';
import { NativeEngine } from './NativeEngine';

// The facade in front of the two engines. The stores and the UI always talk to
// `sipEngine`; the profile decides which engine registers it:
//
//   engine: 'native'  → pjsua in resources/sip-helper.exe (SIP UDP/TCP/TLS,
//                       G.729, the helper owns the sound device)
//   anything else     → SIP.js over WSS (WebRTC)
//
// The WebRTC engine stays the default so existing profiles and the web build
// behave exactly as before. The native engine needs Windows and the helper.

export type { CallSession, SipEngineEvents, SipServiceState, SoftphoneStatus } from './SipEngine';

const EVENT_NAMES = [
  'presence',
  'stateChange',
  'registered',
  'unregistered',
  'registrationFailed',
  'transport',
  'incoming',
  'outgoing',
  'callUpdate',
  'callEnded',
  'log',
] as const;

class Engine {
  private backend: 'webrtc' | 'native' = 'webrtc';
  private native = new NativeEngine();
  private em = new Emitter();

  constructor() {
    // Both engines are bound for the life of the app; only the active one
    // fires, a switch is just two shutdowns apart.
    for (const name of EVENT_NAMES) {
      const forward = (...args: unknown[]): void => {
        (this.em.emit as (event: string, ...payload: unknown[]) => void)(name, ...args);
      };
      webrtc.on(name, forward as SipEngineEvents[typeof name]);
      this.native.on(name, forward as SipEngineEvents[typeof name]);
    }
  }

  private get current(): { state: SipServiceState } {
    return this.backend === 'native' ? this.native : webrtc;
  }

  // the engine actually in use (a missing helper falls back to WebRTC)
  get mode(): 'webrtc' | 'native' {
    return this.backend;
  }

  get state(): SipServiceState {
    return this.current.state;
  }

  get presence(): SoftphoneStatus {
    return this.backend === 'native' ? this.native.presence : webrtc.presence;
  }

  get recovering(): boolean {
    return this.backend === 'native' ? this.native.recovering : webrtc.recovering;
  }

  get activeCalls(): CallSession[] {
    return this.backend === 'native' ? this.native.activeCalls : webrtc.activeCalls;
  }

  getCall(id: string): CallSession | undefined {
    return this.backend === 'native' ? this.native.getCall(id) : webrtc.getCall(id);
  }

  get currentProfileId(): string | null {
    return this.backend === 'native' ? this.native.currentProfileId : webrtc.currentProfileId;
  }

  on<K extends keyof SipEngineEvents>(ev: K, cb: SipEngineEvents[K]): () => void {
    return this.em.on(ev, cb);
  }

  setRemoteAudio(el: HTMLAudioElement): void {
    // only the WebRTC engine plays through an element of the page
    webrtc.setRemoteAudio(el);
  }

  updateSettings(settings: AppSettings): void {
    webrtc.updateSettings(settings);
    this.native.updateSettings(settings);
  }

  async initialize(profile: SipProfile, settings: AppSettings): Promise<void> {
    let backend: 'webrtc' | 'native' = 'webrtc';
    if (profile.engine === 'native') {
      if (await window.api.sipAvailable()) {
        backend = 'native';
      } else {
        this.em.emit(
          'log',
          'warn',
          'the native SIP engine is not installed — falling back to WebRTC',
        );
      }
    }

    if (backend !== this.backend) {
      await (this.backend === 'native' ? this.native.shutdown() : webrtc.shutdown());
      this.backend = backend;
    }
    await (backend === 'native' ? this.native : webrtc).initialize(profile, settings);
  }

  async cancelConnect(): Promise<void> {
    await this.currentShutdown();
  }

  async shutdown(): Promise<void> {
    await this.currentShutdown();
  }

  async recoverTransport(): Promise<boolean> {
    return this.backend === 'native' ? this.native.recoverTransport() : webrtc.recoverTransport();
  }

  async makeCall(target: string): Promise<string> {
    return this.backend === 'native' ? this.native.makeCall(target) : webrtc.makeCall(target);
  }

  async answer(callId: string): Promise<void> {
    return this.backend === 'native' ? this.native.answer(callId) : webrtc.answer(callId);
  }

  async reject(callId: string): Promise<void> {
    return this.backend === 'native' ? this.native.reject(callId) : webrtc.reject(callId);
  }

  async hangup(callId: string): Promise<void> {
    return this.backend === 'native' ? this.native.hangup(callId) : webrtc.hangup(callId);
  }

  async hold(callId: string): Promise<void> {
    return this.backend === 'native' ? this.native.hold(callId) : webrtc.hold(callId);
  }

  async resume(callId: string): Promise<void> {
    return this.backend === 'native' ? this.native.resume(callId) : webrtc.resume(callId);
  }

  setMute(callId: string, muted: boolean): void {
    if (this.backend === 'native') this.native.setMute(callId, muted);
    else webrtc.setMute(callId, muted);
  }

  async sendDtmf(callId: string, digit: string): Promise<void> {
    return this.backend === 'native'
      ? this.native.sendDtmf(callId, digit)
      : webrtc.sendDtmf(callId, digit);
  }

  async blindTransfer(callId: string, target: string): Promise<void> {
    return this.backend === 'native'
      ? this.native.blindTransfer(callId, target)
      : webrtc.blindTransfer(callId, target);
  }

  async warmupMedia(): Promise<void> {
    if (this.backend === 'native') return this.native.warmupMedia();
    return webrtc.warmupMedia();
  }

  private async currentShutdown(): Promise<void> {
    await (this.backend === 'native' ? this.native.shutdown() : webrtc.shutdown());
  }
}

export const sipEngine = new Engine();
