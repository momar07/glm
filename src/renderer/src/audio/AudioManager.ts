import type { DeviceInfo } from '@shared/types';
import { logger } from '../lib/logger';

// ponytail: single AudioManager instance. WebRTC getUserMedia is called per-call by SIP.js SDH;
// this module handles enumeration, the ringtone synth, and the live mic level meter.
// ponytail: DTMF frequencies (ITU-T Q.23) for local keypress feedback.
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
  A: [697, 1633], B: [770, 1633], C: [852, 1633], D: [941, 1633],
};

class AudioManager {
  private audioCtx: AudioContext | null = null;
  private ringOsc: OscillatorNode | null = null;
  private ringLfo: OscillatorNode | null = null;
  private ringTimer: number | null = null;
  private meterStream: MediaStream | null = null;
  private meterCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meterRaf: number | null = null;
  private sinkId?: string;

  /** Route synth output (ringtone, DTMF) to a chosen device. Applied live. */
  setSink(sinkId?: string): void {
    this.sinkId = sinkId;
    this.applySink();
  }

  private applySink(): void {
    const ctx = this.audioCtx;
    if (this.sinkId && ctx && ctx.state !== 'closed' && typeof (ctx as any).setSinkId === 'function') {
      void (ctx as any).setSinkId(this.sinkId).catch(() => {
        /* unknown device — stays on default */
      });
    }
  }

  /** Call from any user gesture (dial, keypress) to unlock the AudioContext. */
  unlock(): void {
    this.ensureCtx();
  }

  private keepOsc: OscillatorNode | null = null;
  private keepGain: GainNode | null = null;

  // Inaudible tone that opts the page out of Chromium's background timer
  // throttling (kicks in ~5 min hidden and would otherwise freeze SIP
  // keep-alives + re-REGISTERs, dropping registration). Heuristic: relies on
  // the "playing audio" exemption; inaudible at 0.001 gain. Phase 3 push is
  // the robust path — this just buys normal background survival.
  startRetentionTone(): void {
    try {
      if (this.keepOsc) return;
      const ctx = this.ensureCtx();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      this.applySink();
      const gain = ctx.createGain();
      gain.gain.value = 0.001;
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 55;
      osc.connect(gain);
      osc.start();
      this.keepOsc = osc;
      this.keepGain = gain;
      logger.info('audio', `retention tone started (ctx=${ctx.state})`);
    } catch (e: any) {
      logger.warn('audio', `retention tone failed: ${e?.message ?? e}`);
    }
  }

  stopRetentionTone(): void {
    const had = this.keepOsc != null;
    try {
      this.keepOsc?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.keepGain?.disconnect();
    } catch {
      /* ignore */
    }
    this.keepOsc = null;
    this.keepGain = null;
    if (had) logger.info('audio', 'retention tone stopped');
  }

  /** Short local DTMF beep for dialpad feedback. Fire-and-forget. */
  playDtmf(digit: string, volume = 0.15, durationMs = 140): void {
    const pair = DTMF_FREQS[digit.toUpperCase()];
    if (!pair) return;
    try {
      const ctx = this.ensureCtx();
      this.applySink();
      if (ctx.state === 'suspended') {
        void ctx.resume().then(() => this.playDtmf(digit, volume, durationMs));
        return;
      }
      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.01);
      gain.gain.setValueAtTime(volume, t + durationMs / 1000 - 0.02);
      gain.gain.linearRampToValueAtTime(0, t + durationMs / 1000);
      gain.connect(ctx.destination);
      for (const f of pair) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        osc.connect(gain);
        osc.start(t);
        osc.stop(t + durationMs / 1000 + 0.02);
      }
    } catch {
      /* ignore — feedback only, never break dialing */
    }
  }

  /** Short two-tone chime for a WhatsApp assignment (the toast is visual;
   *  this is its sound). Best-effort like the DTMF feedback: a suspended
   *  context resumes first, and any failure is swallowed. */
  playNotification(volume = 0.22): void {
    try {
      const ctx = this.ensureCtx();
      this.applySink();
      if (ctx.state === 'suspended') {
        void ctx.resume().then(() => this.playNotification(volume));
        return;
      }
      const t = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      const notes: Array<[number, number]> = [
        [1175, 0],
        [1568, 0.14],
      ];
      for (const [freq, offset] of notes) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(t + offset);
        osc.stop(t + offset + 0.13);
      }
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.015);
      gain.gain.setValueAtTime(volume, t + 0.22);
      gain.gain.linearRampToValueAtTime(0, t + 0.28);
    } catch {
      /* ignore — the toast still shows */
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    // Permissions must be granted before labels are exposed; request a throwaway stream first.
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore — we still get device ids without labels */
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.map((d) => ({
      deviceId: d.deviceId,
      kind: d.kind,
      label: d.label || `${d.kind}`,
    }));
  }

  /** Start ringtone. `type` controls the synthesized pattern; `sinkId` optional output device. */
  startRingtone(type: 'classic' | 'digital' | 'office' | 'silent', volume: number, sinkId?: string): void {
    if (type === 'silent' || volume <= 0) return;
    // AudioContext starts suspended without a user gesture (incoming call).
    // Oscillators started while suspended stay silent on a frozen timeline,
    // so resume first and retry once running. See bug: no ringtone on incoming.
    const probe = this.ensureCtx();
    if (probe.state === 'suspended') {
      void probe.resume().then(() => {
        if (!this.ringOsc) this.startRingtone(type, volume, sinkId);
      });
      return;
    }
    this.stopRingtone();
    const ctx = this.ensureCtx();
    this.sinkId = sinkId ?? this.sinkId;
    this.applySink();
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    // ponytail: ringtone is two oscillators (carrier + AM) shaped into a ring cadence.
    const osc = ctx.createOscillator();
    osc.type = type === 'digital' ? 'square' : 'sine';
    osc.frequency.value = type === 'office' ? 600 : 440;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = type === 'digital' ? 25 : 20; // ring tone cadence
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(gain.gain);

    osc.connect(gain);
    osc.start(now);
    lfo.start(now);
    gain.gain.setValueAtTime(0, now);

    // North-American ring cadence: 2s on, 4s off
    const onLevel = Math.min(0.4, volume);
    gain.gain.setValueAtTime(onLevel, now);
    gain.gain.setValueAtTime(onLevel, now + 2);
    gain.gain.setValueAtTime(0, now + 2.01);
    gain.gain.setValueAtTime(0, now + 6);
    this.ringTimer = window.setInterval(() => {
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(onLevel, t);
      gain.gain.setValueAtTime(onLevel, t + 2);
      gain.gain.setValueAtTime(0, t + 2.01);
    }, 6000);

    this.ringOsc = osc;
    this.ringLfo = lfo;
  }

  stopRingtone(): void {
    if (this.ringTimer) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
    try {
      this.ringOsc?.stop();
      this.ringLfo?.stop();
    } catch {
      /* already stopped */
    }
    this.ringOsc = null;
    this.ringLfo = null;
  }

  /** Live mic level 0..1 via AnalyserNode RMS. Pass a callback; returns a stop fn. */
  async startMeter(onLevel: (level: number) => void, deviceId?: string): Promise<() => Promise<void>> {
    await this.stopMeter();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.meterStream = stream;
    const ctx = new AudioContext();
    this.meterCtx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    this.analyser = analyser;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = (): void => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      onLevel(Math.min(1, rms * 3));
      this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
    return () => this.stopMeter();
  }

  async stopMeter(): Promise<void> {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = null;
    this.meterStream?.getTracks().forEach((t) => t.stop());
    this.meterStream = null;
    try {
      await this.meterCtx?.close();
    } catch {
      /* ignore */
    }
    this.meterCtx = null;
    this.analyser = null;
  }

  private ensureCtx(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
    return this.audioCtx;
  }
}

export const audioManager = new AudioManager();
