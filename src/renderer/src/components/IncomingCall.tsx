import React, { useEffect, useState } from 'react';
import { useCall } from '../store/call';
import { useSettings } from '../store/settings';
import { audioManager } from '../audio/AudioManager';
import { isNative } from '../lib/platform';
import { playSystemRingtone, stopSystemRingtone } from '../lib/device';
import { setNormalAudio, setRingMode } from '../lib/audioRoute';
import { logger } from '../lib/logger';

// ponytail: auto-reject after 30s if user is away. Configurable timeout deferred.
const RING_TIMEOUT_MS = 30_000;

export function IncomingCall(): React.ReactElement {
  const calls = useCall((s) => s.calls);
  const answer = useCall((s) => s.answer);
  const reject = useCall((s) => s.reject);
  const audio = useSettings((s) => s.settings.audio);
  const profile = useSettings((s) => s.settings.profiles.find((p) => p.id === useSettings.getState().settings.activeProfileId));

  const incoming = calls.find((c) => c.direction === 'incoming' && c.status === 'ringing');
  const [remaining, setRemaining] = useState(RING_TIMEOUT_MS / 1000);
  // Locked after first press: a second answer() throws and failCall()s a call
  // that is about to establish. Resets when a new call rings.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
    if (!incoming) return;
    const remoteLabel = incoming.displayName || incoming.remote.replace(/^sip:/, '').split('@')[0];
    if (profile?.autoAnswer) {
      logger.info('incoming', `auto-answering ${incoming.remote}`);
      void answer(incoming.id);
      return;
    }
    audioManager.startRingtone(audio.ringtone, audio.ringtoneVolume, audio.ringtoneDeviceId);
    setRingMode(); // loud ring like a real call (native only; no-op on web)
    // Device ringtone wins over the synth when the user picked one.
    if (isNative() && audio.ringtoneUri) {
      audioManager.stopRingtone();
      void playSystemRingtone(audio.ringtoneUri);
    }
    void window.api.notify({ title: 'Incoming call', body: remoteLabel, urgency: 'critical' });
    const tick = setInterval(() => setRemaining((r) => r - 1), 1000);
    const timeout = setTimeout(() => {
      logger.info('incoming', 'auto-reject (timeout)');
      void reject(incoming.id);
      void window.api.notify({ title: 'Missed call', body: remoteLabel, urgency: 'normal' });
    }, RING_TIMEOUT_MS);
    return () => {
      audioManager.stopRingtone();
      void stopSystemRingtone();
      setNormalAudio(); // answered → CallView takes over; rejected/timed out → idle
      clearInterval(tick);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.id, profile?.autoAnswer]);

  if (!incoming) return <></>;

  const remoteLabel = incoming.displayName || incoming.remote.replace(/^sip:/, '').split('@')[0];

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-950/95 backdrop-blur-sm p-6">
      <div className="text-sm text-slate-500 mb-2">Incoming call</div>
      <div className="h-24 w-24 rounded-full bg-brand-600/30 flex items-center justify-center text-3xl font-semibold text-brand-200 mb-4 animate-pulseRing">
        {remoteLabel.slice(0, 2).toUpperCase()}
      </div>
      <div className="text-2xl font-semibold text-slate-100">{remoteLabel}</div>
      <div className="text-sm text-slate-500 font-mono mt-1">{incoming.remote.replace(/^sip:/, '')}</div>
      <div className="text-xs text-slate-600 mt-2">auto-reject in {remaining}s</div>

      <div className="flex gap-6 mt-10">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void reject(incoming.id);
          }}
          className="flex flex-col items-center gap-2 group disabled:opacity-40"
        >
          <span className="h-16 w-16 rounded-full bg-danger-600 group-hover:bg-danger-500 flex items-center justify-center text-2xl text-white shadow-lg shadow-danger-600/30 transition">
            ✕
          </span>
          <span className="text-xs text-slate-400">Reject</span>
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            // Reset on failure (e.g. mic denied) so the overlay doesn't wedge.
            void answer(incoming.id).catch(() => setBusy(false));
          }}
          className="flex flex-col items-center gap-2 group disabled:opacity-40"
        >
          <span className="h-16 w-16 rounded-full bg-ok-600 group-hover:bg-ok-500 flex items-center justify-center text-2xl text-white shadow-lg shadow-ok-600/30 transition animate-pulseRing">
            ✓
          </span>
          <span className="text-xs text-slate-400">{busy ? 'Connecting…' : 'Accept'}</span>
        </button>
      </div>
    </div>
  );
}
