import React, { useEffect, useState } from 'react';
import { useCall } from '../store/call';
import { useSettings } from '../store/settings';
import { audioManager } from '../audio/AudioManager';
import { isNative } from '../lib/platform';
import { proximityOff, proximityOn } from '../lib/system';
import { setCallMode, setNormalAudio } from '../lib/audioRoute';
import { Button, Card } from './ui';
import { DtmfPad } from './Dialpad';
import { formatDuration } from '@shared/constants';

export function CallView(): React.ReactElement {
  const calls = useCall((s) => s.calls);
  const currentId = useCall((s) => s.currentId);
  const hangup = useCall((s) => s.hangup);
  const hold = useCall((s) => s.hold);
  const resume = useCall((s) => s.resume);
  const toggleMute = useCall((s) => s.toggleMute);
  const sendDtmf = useCall((s) => s.sendDtmf);
  const blindTransfer = useCall((s) => s.blindTransfer);
  const showTimer = useSettings((s) => s.settings.ui.showCallTimer);

  const call = calls.find((c) => c.id === currentId);
  const [, force] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [showDtmf, setShowDtmf] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const native = isNative();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Force re-render when call list changes
  useEffect(() => {
    force((n) => n + 1);
  }, [calls]);

  const callId = call?.id;
  const callStatus = call?.status;

  // Route in-call audio: earpiece by default, loudspeaker when toggled.
  // Native only — desktop browsers manage routing themselves. Reset per call.
  // (Status primitives, safe above the !call guard.)
  useEffect(() => {
    setSpeaker(false);
  }, [callId]);
  useEffect(() => {
    const live = callStatus === 'in-call' || callStatus === 'held';
    if (live) {
      setCallMode(speaker);
      // Ear sensor blanks the screen — but never on loudspeaker.
      if (!speaker) void proximityOn();
    }
    return () => {
      setNormalAudio();
      void proximityOff();
    };
  }, [callStatus, speaker, callId]);

  const dtmf = (d: string): void => {
    audioManager.playDtmf(d);
    void sendDtmf(call!.id, d);
  };

  if (!call) return <div className="p-6 text-center text-slate-500">No active call</div>;

  const elapsed =
    call.connectedAt && call.status === 'in-call'
      ? Math.floor((now - call.connectedAt) / 1000)
      : call.status === 'held' && call.connectedAt
        ? Math.floor((now - call.connectedAt) / 1000)
        : 0;

  const isRinging = call.status === 'ringing' || call.status === 'connecting';
  const inCall = call.status === 'in-call' || call.status === 'held';
  const remoteLabel = call.displayName || call.remote.replace(/^sip:/, '').split('@')[0];
  const remoteSub = call.remote.replace(/^sip:/, '');


  return (
    <div className="h-full flex flex-col p-5 gap-4">
      <Card className="p-6 flex flex-col items-center text-center">
        <div
          className={`h-20 w-20 rounded-full flex items-center justify-center text-2xl font-semibold mb-3 ${
            isRinging ? 'bg-warn-600/20 text-warn-500 animate-pulseRing' : 'bg-brand-600/20 text-brand-400'
          }`}
        >
          {initials(remoteLabel)}
        </div>
        <div className="text-xl font-medium text-slate-100 truncate max-w-full">{remoteLabel}</div>
        <div className="text-xs text-slate-500 font-mono truncate max-w-full">{remoteSub}</div>
        <div className="mt-2 text-sm">
          {isRinging && (
            <span className="text-warn-500">
              {call.status === 'connecting'
                ? 'Connecting…'
                : call.direction === 'outgoing'
                  ? 'Calling…'
                  : 'Ringing…'}
            </span>
          )}
          {inCall && showTimer && <span className="text-slate-300 font-mono">{formatDuration(elapsed)}</span>}
          {call.status === 'held' && <span className="text-warn-500">· On Hold</span>}
          {call.status === 'failed' && <span className="text-danger-500">Failed{call.reason ? `: ${call.reason}` : ''}</span>}
        </div>
      </Card>

      {inCall && (
        <div className="grid grid-cols-3 gap-2.5">
          <CallButton
            active={call.muted}
            label={call.muted ? 'Unmute' : 'Mute'}
            icon="🔇"
            onClick={() => toggleMute(call.id)}
          />
          <CallButton
            active={call.held}
            label={call.held ? 'Resume' : 'Hold'}
            icon="⏸"
            onClick={() => (call.held ? resume(call.id) : hold(call.id))}
          />
          <CallButton active={showDtmf} label="Keypad" icon="🔢" onClick={() => setShowDtmf((v) => !v)} />
          <CallButton active={showTransfer} label="Transfer" icon="↗" onClick={() => setShowTransfer((v) => !v)} />
          {native && (
            <CallButton
              active={speaker}
              label={speaker ? 'Speaker On' : 'Speaker'}
              icon="🔊"
              onClick={() => setSpeaker((v) => !v)}
            />
          )}
          <CallButton label="…" icon="⋯" onClick={() => {}} />
        </div>
      )}

      {showDtmf && inCall && <DtmfPad onKey={dtmf} />}

      {showTransfer && inCall && (
        <Card className="p-3 flex gap-2">
          <input
            value={transferTarget}
            onChange={(e) => setTransferTarget(e.target.value)}
            placeholder="Transfer target (ext or URI)"
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!transferTarget}
            onClick={() => {
              void blindTransfer(call.id, transferTarget);
              setShowTransfer(false);
              setTransferTarget('');
            }}
          >
            Transfer
          </Button>
        </Card>
      )}

      <div className="mt-auto">
        <Button
          variant="danger"
          size="lg"
          className="w-full rounded-2xl py-4 text-lg"
          onClick={() => void hangup(call.id)}
        >
          End Call
        </Button>
      </div>
    </div>
  );
}

function CallButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1 rounded-xl py-3 border transition-colors ${
        active
          ? 'bg-brand-600/20 border-brand-600/50 text-brand-300'
          : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700'
      }`}
    >
      <span className="text-lg">{icon}</span>
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  );
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
