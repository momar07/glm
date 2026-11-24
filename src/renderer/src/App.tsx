import React, { useCallback, useEffect } from 'react';
import { useSettings } from './store/settings';
import { useSip } from './store/sip';
import { sipEngine } from './sip/engine';
import { audioManager } from './audio/AudioManager';
import { onForeground } from './lib/lifecycle';
import { useWindowFit } from './lib/useWindowFit';
import { PhoneBar } from './components/PhoneBar';
import { BatteryPrompt } from './components/BatteryPrompt';
import { AgentLogin } from './components/AgentLogin';
import { IncomingCall } from './components/IncomingCall';
import { useAgent } from './store/agent';
import { logger } from './lib/logger';

export default function App(): React.ReactElement {
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);
  const settings = useSettings((s) => s.settings);
  const presence = useSip((s) => s.presence);
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
  // Agent events (middleware state + CRM pops) are pushed by the main process.
  useEffect(() => {
    useAgent.getState().init();
  }, []);

  // Load persisted settings once on mount.
  useEffect(() => {
    void load();
  }, [load]);

  // No connection is attempted at startup: the app opens on the agent
  // login, idle. The only automatic sign-in is the agent's own explicit
  // Auto login preference (saved credentials), handled in AgentLogin.

  // Cleanup on unmount only — empty deps, disconnect is stable from Zustand.
  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  const online = presence === 'online' || presence === 'on-call';
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
          <AgentLogin />
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
