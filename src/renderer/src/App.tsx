import React, { useCallback, useEffect, useRef } from 'react';
import { useSettings } from './store/settings';
import { useSip } from './store/sip';
import { sipEngine } from './sip/engine';
import { audioManager } from './audio/AudioManager';
import { onForeground } from './lib/lifecycle';
import { useWindowFit } from './lib/useWindowFit';
import { PhoneBar } from './components/PhoneBar';
import { BatteryPrompt } from './components/BatteryPrompt';
import { Login } from './components/Login';
import { IncomingCall } from './components/IncomingCall';
import { useAgent } from './store/agent';
import { logger } from './lib/logger';

export default function App(): React.ReactElement {
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);
  const settings = useSettings((s) => s.settings);
  const presence = useSip((s) => s.presence);
  const connect = useSip((s) => s.connect);
  const disconnect = useSip((s) => s.disconnect);

  // Callback ref — fires on every mount/unmount of the audio element.
  // Critical: App.tsx renders <audio> in two separate conditional branches
  // (offline vs online). A static useRef + useEffect([]) only registers the
  // FIRST element (the Login branch). When the user logs in, React unmounts
  // that element and creates a new one — but sipEngine still held the old,
  // DETACHED element. srcObject was set on a detached node → no sound.
  // The callback ref re-registers every time the element mounts.
  const setAudioRef = useCallback((el: HTMLAudioElement | null): void => {
    if (el) {
      el.volume = 1;
      el.muted = false;
      sipEngine.setRemoteAudio(el);
      logger.info('audio', `audio element bound to SIP engine (inDOM=${el.isConnected} volume=${el.volume} muted=${el.muted} autoplay=${el.autoplay} playsInline=${(el as any).playsInline})`);
    }
  }, []);

  // Route synth sounds (ringtone, DTMF) to the chosen output device.
  const ringSink = settings.audio.ringtoneDeviceId;
  const outSink = settings.audio.outputDeviceId;
  useEffect(() => {
    audioManager.setSink(ringSink ?? outSink);
  }, [ringSink, outSink]);

  // Recover a socket the OS killed while backgrounded. No-ops on Login
  // (engine has no UA/profile there) and dedupes concurrent returns.
  useEffect(() => {
    return onForeground(() => {
      logger.info('app', 'foreground/network — recovering transport');
      // Throttling may have frozen the retention tone's context while hidden;
      // restart is a no-op when already running or when never registered.
      if (sipEngine.state === 'registered') audioManager.startRetentionTone();
      void sipEngine.recoverTransport().catch(() => {});
    });
  }, []);
  // Unlike useState, a ref updates synchronously so there's no race window.
  // Ref guard — prevents double auto-connect even if the effect fires twice.
  // Unlike useState, a ref updates synchronously so there's no race window.
  const bootRef = useRef(false);

  // Agent events (middleware state + CRM pops) are pushed by the main process.
  useEffect(() => {
    useAgent.getState().init();
  }, []);

  // Load persisted settings once on mount.
  useEffect(() => {
    void load();
  }, [load]);

  // Auto-connect the active profile once on boot.
  // Dependencies are intentionally minimal — `loaded` flips once and triggers this.
  // `settings` and `connect` are read from refs to avoid re-triggering.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    if (!loaded || bootRef.current) return;
    bootRef.current = true;
    const s = settingsRef.current;
    // Manual sign-in mode: stay on Login until the user connects.
    if (s.ui.autoSignIn === false) return;
    const p = s.profiles.find((x) => x.id === s.activeProfileId);
    if (p && p.username && p.wsUrl) {
      logger.info('app', `auto-connecting profile "${p.label}"`);
      void connectRef.current(p, s).catch((e) =>
        logger.error('app', `auto-connect failed: ${e?.message}`),
      );
    }
  }, [loaded]);

  // Cleanup on unmount only — empty deps, disconnect is stable from Zustand.
  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  const online = presence === 'online' || presence === 'on-call';
  const engineState = useSip((s) => s.engineState);
  // The frameless window hugs whatever shell is on screen: the compact
  // login card (~420 wide) or the phonebar (780 wide), bar-height when no
  // drawer is open. See lib/useWindowFit.
  const fit = useWindowFit(online ? 780 : 420);
  const fitRef = fit.ref;

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">Loading settings…</div>
    );
  }

  if (!online) {
    // Mid-recovery (transport died in background) show a splash, not Login —
    // the engine is rebuilding the session and Login would flash for a second.
    // Logged-out / failed states still show Login (no recovery in flight and
    // the engine is idle or failed, never mid-connect).
    const reviving =
      sipEngine.recovering ||
      engineState === 'connecting' ||
      engineState === 'connected' ||
      engineState === 'registering' ||
      engineState === 'reconnecting';
    if (reviving) {
      return (
        <div className="h-full">
          <audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
          <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white text-xl font-bold animate-pulse">
              G
            </div>
            <div className="text-sm text-slate-300">Reconnecting…</div>
            <div className="text-xs text-slate-600">Restoring your session</div>
            <button
              className="mt-2 text-xs px-4 py-2 rounded-lg text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors"
              onClick={() => {
                void sipEngine.cancelConnect().catch(() => {});
                // Unstick the Login form if connect() itself never settled.
                useSip.setState({ connecting: false });
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }
    // Compact login: the window shrinks to hug this ~380px card (useWindowFit
    // measures the wrapper), no wide glass panel around it. The X quits the
    // app — the frameless window has no title bar to close it with.
    return (
      <div ref={fitRef} className="w-full flex justify-center px-3 pt-3 pb-3">
        <audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
        <div className="relative w-[380px] max-w-full rounded-3xl bg-[#0f172a]/95 backdrop-blur-2xl border border-[#1e293b] overflow-hidden">
          <button
            onClick={() => void window.api.quit()}
            className="absolute top-2 right-2 z-20 w-7 h-7 rounded-full bg-slate-800/80 hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 border border-slate-700/70 flex items-center justify-center text-xs transition"
            title="Close / Exit"
          >
            ✕
          </button>
          <Login onConnected={() => {}} />
        </div>
      </div>
    );
  }

  // Floating phonebar shell: ONLY the slim pill bar lives here — no
  // permanent panel underneath. Everything else (keypad, logs, contacts,
  // settings, queues, transfer) unfolds as a drawer from the bar, and the
  // window grows/shrinks with it via useWindowFit. On desktop the window is
  // transparent, so the bar floats over whatever is behind the app.
  return (
    <div ref={fitRef} className="w-full flex flex-col items-center px-3 pt-3 pb-3 pb-[env(safe-area-inset-bottom)]">
      <audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
      <PhoneBar onFitRequest={fit.fitNow} />
      <BatteryPrompt />
      <IncomingCall />
    </div>
  );
}
