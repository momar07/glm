import React, { useCallback, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useSettings } from './store/settings';
import { useSip } from './store/sip';
import { sipEngine } from './sip/SipEngine';
import { audioManager } from './audio/AudioManager';
import { onForeground } from './lib/lifecycle';
import { StatusBar } from './components/StatusBar';
import { BatteryPrompt } from './components/BatteryPrompt';
import { Login } from './components/Login';
import { CallsPage } from './components/CallsPage';
import { TabBar } from './components/TabBar';
import { CallView } from './components/CallView';
import { IncomingCall } from './components/IncomingCall';
import { Settings } from './components/Settings';
import { Contacts } from './components/Contacts';
import { Logs } from './components/Logs';
import { useCall } from './store/call';
import { useAgent } from './store/agent';
import { AgentPanel } from './components/AgentPanel';
import { logger } from './lib/logger';

export default function App(): React.ReactElement {
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);
  const settings = useSettings((s) => s.settings);
  const presence = useSip((s) => s.presence);
  const connect = useSip((s) => s.connect);
  const disconnect = useSip((s) => s.disconnect);
  const navigate = useNavigate();
  const calls = useCall((s) => s.calls);

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
  const hasActiveCall = calls.some((c) => c.status === 'in-call' || c.status === 'held');
  const hasRingingOut = calls.some(
    (c) => c.direction === 'outgoing' && (c.status === 'ringing' || c.status === 'connecting'),
  );
  // Joining: answer pressed, ACK/DTLS still in flight (set optimistically by answer()).
  const hasJoining = calls.some((c) => c.status === 'connecting');

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
    return (
      <div className="h-full">
        <audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
        <Login onConnected={() => navigate('/')} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col pb-[env(safe-area-inset-bottom)]">
      <audio ref={setAudioRef} id="remoteAudio" autoPlay playsInline />
      <StatusBar />
      <BatteryPrompt />
      <div className="flex-1 overflow-hidden relative">
        <Routes>
          <Route path="/" element={hasActiveCall || hasRingingOut || hasJoining ? <CallView /> : <CallsPage />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/agent" element={<AgentPanel />} />
          <Route path="/history" element={<Navigate to="/" replace />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        <IncomingCall />
      </div>
      <TabBar />
    </div>
  );
}
