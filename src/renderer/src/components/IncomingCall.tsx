import React, { useEffect, useState } from 'react';
import { sameCaller, crmPopIsFresh } from '@shared/agent';
import { useCall } from '../store/call';
import { useSettings } from '../store/settings';
import { useAgent } from '../store/agent';
import { audioManager } from '../audio/AudioManager';
import { isNative } from '../lib/platform';
import { playSystemRingtone, stopSystemRingtone } from '../lib/device';
import { setNormalAudio, setRingMode } from '../lib/audioRoute';
import { logger } from '../lib/logger';

// ponytail: auto-reject after 30s if user is away. Configurable timeout deferred.
const RING_TIMEOUT_MS = 30_000;

function callerNumberOf(remote: string): string {
  return remote.replace(/^sip:/, '').split('@')[0];
}

export function IncomingCall(): React.ReactElement {
  const calls = useCall((s) => s.calls);
  const answer = useCall((s) => s.answer);
  const reject = useCall((s) => s.reject);
  const audio = useSettings((s) => s.settings.audio);
  const profile = useSettings((s) => s.settings.profiles.find((p) => p.id === useSettings.getState().settings.activeProfileId));
  const pop = useAgent((s) => s.pop);
  const openRecord = useAgent((s) => s.openRecord);

  const incoming = calls.find((c) => c.direction === 'incoming' && c.status === 'ringing');
  const [remaining, setRemaining] = useState(RING_TIMEOUT_MS / 1000);
  // Locked after first press: a second answer() throws and failCall()s a call
  // that is about to establish. Resets when a new call rings.
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setBusy(false);
    setCopied(false);
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
  const callerNumber = callerNumberOf(incoming.remote);
  // The record of a customer binds only to the call ringing now. A stale pop
  // never shows up in the next call; with a single ring it is that call's
  // record even if the number is written differently (MicroSIP does the same).
  const ringingNow = calls.filter((c) => c.direction === 'incoming' && c.status === 'ringing').length;
  const card =
    pop &&
    crmPopIsFresh(pop.receivedAt, Date.now()) &&
    (sameCaller(pop.callerId, callerNumber) || ringingNow === 1)
      ? pop
      : null;

  const accept = (): void => {
    setBusy(true);
    if (card) void openRecord(card.callerId, card.uid);
    // Reset on failure (e.g. mic denied) so the overlay doesn't wedge.
    void answer(incoming.id).catch(() => setBusy(false));
  };

  const copyNumber = (): void => {
    void navigator.clipboard?.writeText(callerNumber).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto bg-slate-950/95 backdrop-blur-sm p-6">
      <div className="text-sm text-slate-500 mb-2">Incoming call</div>
      <div className="h-24 w-24 rounded-full bg-brand-600/30 flex items-center justify-center text-3xl font-semibold text-brand-200 mb-4 animate-pulseRing">
        {remoteLabel.slice(0, 2).toUpperCase()}
      </div>
      <div className="text-2xl font-semibold text-slate-100">{remoteLabel}</div>
      <div className="text-sm text-slate-500 font-mono mt-1">{incoming.remote.replace(/^sip:/, '')}</div>
      <div className="text-xs text-slate-600 mt-2">auto-reject in {remaining}s</div>

      {card && (
        <div className="mt-6 w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900/90 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-100 truncate">
              {card.customer?.name || 'New caller'}
            </div>
            <span
              className={`shrink-0 text-[11px] rounded-md px-2 py-0.5 border ${
                card.customer?.tag === 'Blacklist'
                  ? 'bg-danger-600/20 text-danger-400 border-danger-600/40'
                  : card.customer?.tag === 'VIP'
                    ? 'bg-warn-600/20 text-warn-400 border-warn-600/40'
                    : 'bg-slate-700/40 text-slate-300 border-slate-600/60'
              }`}
            >
              {card.customer?.tag || (card.isNew ? 'new' : 'customer')}
            </span>
          </div>
          {card.customer?.company && (
            <div className="text-xs text-slate-400 truncate">{card.customer.company}</div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500 font-mono">{card.callerId}</div>
            <div className="flex gap-1.5 shrink-0">
              <button
                type="button"
                onClick={copyNumber}
                className="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => void openRecord(card.callerId, card.uid)}
                className="text-[11px] px-2 py-1 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors"
              >
                Open record ↗
              </button>
            </div>
          </div>
          {card.lastInteraction && (card.lastInteraction.disposition || card.lastInteraction.notes) && (
            <div className="border-t border-slate-800 pt-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                Last: {card.lastInteraction.disposition || '—'}
              </div>
              {card.lastInteraction.notes && (
                <div className="text-xs text-slate-400 line-clamp-2">{card.lastInteraction.notes}</div>
              )}
            </div>
          )}
        </div>
      )}

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
          onClick={accept}
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
