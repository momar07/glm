import React, { useEffect, useState } from 'react';
import { useSettings } from '../store/settings';
import { useSip } from '../store/sip';
import { Button, Card, Field, Input, Label, Select, Toggle } from './ui';
import { audioManager } from '../audio/AudioManager';
import { isNative, isNativeShell } from '../lib/platform';
import { isIgnoringBattery, requestBatteryExemption } from '../lib/system';
import { listSystemRingtones, playSystemRingtone, stopSystemRingtone, type DeviceRingtone } from '../lib/device';
import type { AppSettings, DeviceInfo, LogLevel } from '@shared/types';
import { CODEC_LABELS } from '@shared/constants';

type TabId = 'account' | 'audio' | 'codecs' | 'network' | 'app' | 'logs' | 'window';

const TABS: { id: TabId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'audio', label: 'Audio' },
  { id: 'codecs', label: 'Codecs' },
  { id: 'network', label: 'Network' },
  { id: 'app', label: 'App' },
  { id: 'logs', label: 'Logs' },
  { id: 'window', label: 'Window' },
];

export function Settings(): React.ReactElement {
  const { settings, patch, upsertProfile } = useSettings();
  const disconnect = useSip((s) => s.disconnect);
  const presence = useSip((s) => s.presence);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [metering, setMetering] = useState(false);
  const [tab, setTab] = useState<TabId>('audio');
  const [phoneTones, setPhoneTones] = useState<DeviceRingtone[]>([]);
  // ponytail: undefined = checking, null = non-native/unavailable.
  const [battery, setBattery] = useState<boolean | null | undefined>(undefined);

  const checkBattery = (): void => {
    if (!isNative()) {
      setBattery(null);
      return;
    }
    setBattery(undefined);
    void isIgnoringBattery().then((v) => setBattery(v));
  };

  useEffect(() => {
    if (tab === 'app') checkBattery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const refreshDevices = async (): Promise<void> => {
    const d = await audioManager.listDevices();
    setDevices(d);
  };

  useEffect(() => {
    void refreshDevices();
    void listSystemRingtones().then(setPhoneTones).catch(() => {});
  }, []);

  const mics = devices.filter((d) => d.kind === 'audioinput');
  const speakers = devices.filter((d) => d.kind === 'audiooutput');

  const set = (p: Partial<AppSettings>): void => {
    void patch(p);
  };
  const setAudio = (p: Partial<AppSettings['audio']>): void => set({ audio: { ...settings.audio, ...p } });
  const setUi = (p: Partial<AppSettings['ui']>): void => set({ ui: { ...settings.ui, ...p } });
  const setLog = (p: Partial<AppSettings['log']>): void => set({ log: { ...settings.log, ...p } });
  const setHistory = (p: Partial<AppSettings['history']>): void =>
    set({ history: { ...settings.history, ...p } });
  const setTransport = (p: Partial<AppSettings['transport']>): void =>
    set({ transport: { ...settings.transport, ...p } });

  const toggleMeter = async (): Promise<void> => {
    if (metering) {
      await audioManager.stopMeter();
      setMetering(false);
      setLevel(0);
    } else {
      setMetering(true);
      await audioManager.startMeter(setLevel, settings.audio.inputDeviceId);
    }
  };

  useEffect(() => {
    if (!metering) return;
    // restart meter if device changes while metering
    let stop: (() => Promise<void>) | undefined;
    audioManager.startMeter(setLevel, settings.audio.inputDeviceId).then((s) => {
      stop = s;
    });
    return () => {
      void stop?.();
    };
  }, [metering, settings.audio.inputDeviceId]);

  return (
    <div className="h-full flex flex-col p-3 gap-2 overflow-hidden">
      <div className="flex gap-1 overflow-x-auto no-scrollbar shrink-0 pb-0.5">
        {TABS.filter((t) => isNativeShell || t.id !== 'window').map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              tab === t.id ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {tab === 'account' && (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-400">{presence === 'offline' ? 'Not connected' : `Connected — ${presence}`}</span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (window.confirm('Disconnect and logout? Any active call will end.')) void disconnect();
                }}
                disabled={presence === 'offline'}
              >
                Logout
              </Button>
            </div>
            <p className="text-xs text-slate-500">Disconnects SIP, hangs up active calls, and returns to Login. Profiles are kept.</p>
            {(() => {
              const active = settings.profiles.find((p) => p.id === settings.activeProfileId);
              if (!active) return null;
              return (
                <Field label={`Outbound prefix — ${active.label} (optional)`}>
                  <Input
                    value={active.dialPrefix ?? ''}
                    onChange={(e) =>
                      upsertProfile({ id: active.id, dialPrefix: e.target.value.replace(/[^\d*#+]/g, '').slice(0, 8) })
                    }
                    placeholder="e.g. 9 — dial 123 sends 9123, log shows 123"
                    inputMode="numeric"
                    className="font-mono"
                  />
                </Field>
              );
            })()}
          </Card>
        )}

        {tab === 'audio' && (
          <Card className="p-4 space-y-3">
            <button onClick={refreshDevices} className="text-xs text-brand-400 hover:text-brand-300">
              ↻ refresh devices
            </button>
            <Field label="Microphone">
              <Select
                value={settings.audio.inputDeviceId ?? ''}
                onChange={(v) => setAudio({ inputDeviceId: v || undefined })}
                options={[
                  { value: '', label: 'System default' },
                  ...mics.map((d) => ({ value: d.deviceId, label: d.label || 'mic' })),
                ]}
                className="w-full"
              />
            </Field>
            <div className="flex items-center gap-3">
              <Button size="sm" variant={metering ? 'danger' : 'default'} onClick={toggleMeter}>
                {metering ? 'Stop test' : 'Test mic'}
              </Button>
              <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-ok-500 to-warn-500 transition-[width] duration-75"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
              </div>
            </div>
            <Field label="Speaker output">
              <Select
                value={settings.audio.outputDeviceId ?? ''}
                onChange={(v) => setAudio({ outputDeviceId: v || undefined })}
                options={[
                  { value: '', label: 'System default' },
                  ...speakers.map((d) => ({ value: d.deviceId, label: d.label || 'speaker' })),
                ]}
                className="w-full"
              />
            </Field>
            <Field label="Ringtone output device">
              <Select
                value={settings.audio.ringtoneDeviceId ?? ''}
                onChange={(v) => setAudio({ ringtoneDeviceId: v || undefined })}
                options={[
                  { value: '', label: 'System default' },
                  ...speakers.map((d) => ({ value: d.deviceId, label: d.label || 'speaker' })),
                ]}
                className="w-full"
              />
            </Field>
            <Field label="Ringtone">
              <Select
                value={settings.audio.ringtone}
                onChange={(v) => setAudio({ ringtone: v as AppSettings['audio']['ringtone'] })}
                options={[
                  { value: 'classic', label: 'Classic' },
                  { value: 'digital', label: 'Digital' },
                  { value: 'office', label: 'Office' },
                  { value: 'silent', label: 'Silent' },
                ]}
                className="w-full"
              />
            </Field>
            <div className="flex items-center gap-3">
              <Label>Volume</Label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.audio.ringtoneVolume}
                onChange={(e) => setAudio({ ringtoneVolume: parseFloat(e.target.value) })}
                className="flex-1"
              />
              <button
                className="text-xs text-brand-400"
                onClick={() => {
                  if (settings.audio.ringtoneUri) void playSystemRingtone(settings.audio.ringtoneUri);
                  else audioManager.startRingtone(settings.audio.ringtone, settings.audio.ringtoneVolume, settings.audio.ringtoneDeviceId);
                }}
              >
                preview
              </button>
              <button
                className="text-xs text-slate-500"
                onClick={() => {
                  audioManager.stopRingtone();
                  void stopSystemRingtone();
                }}
              >
                stop
              </button>
            </div>
            {phoneTones.length > 0 && (
              <Field label="Phone ringtone (overrides app sound)">
                <Select
                  value={settings.audio.ringtoneUri ?? ''}
                  onChange={(v) => {
                    setAudio({ ringtoneUri: v || undefined });
                    audioManager.stopRingtone();
                    void stopSystemRingtone();
                  }}
                  options={[
                    { value: '', label: 'App sound (above)' },
                    ...phoneTones.map((t) => ({ value: t.uri, label: t.title })),
                  ]}
                  className="w-full"
                />
              </Field>
            )}
            <div className="grid grid-cols-1 gap-2 pt-1">
              <Toggle checked={settings.audio.echoCancellation} onChange={(v) => setAudio({ echoCancellation: v })} label="Echo cancellation" />
              <Toggle checked={settings.audio.noiseSuppression} onChange={(v) => setAudio({ noiseSuppression: v })} label="Noise suppression" />
              <Toggle checked={settings.audio.autoGainControl} onChange={(v) => setAudio({ autoGainControl: v })} label="Automatic gain control" />
            </div>
          </Card>
        )}

        {tab === 'codecs' && (
          <Card className="p-4 space-y-3">
            <p className="text-xs text-slate-500">
              Order here is the preference — drag chips to reorder. Applies on the next call.
            </p>
            <Field label="Opus quality">
              <Select
                value={String(settings.audio.opusKbps ?? 32)}
                onChange={(v) => {
                  const kbps = parseInt(v, 10);
                  if (kbps === 16 || kbps === 32 || kbps === 48) setAudio({ opusKbps: kbps });
                }}
                options={[
                  { value: '16', label: 'Low — 16 kbps (~20 avg on wire)' },
                  { value: '32', label: 'Balanced — 32 kbps (~30 avg on wire)' },
                  { value: '48', label: 'Full — 48 kbps wideband' },
                ]}
                className="w-full"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              {settings.codecs.map((c, i) => (
                <div
                  key={c}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', String(i));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    if (!Number.isFinite(from) || from === i) return;
                    const next = settings.codecs.filter((_, j) => j !== from);
                    next.splice(i, 0, settings.codecs[from]);
                    set({ codecs: next });
                  }}
                  title="Drag to reorder"
                  className="flex items-center gap-1 bg-slate-800 rounded-lg px-2 py-1 text-xs cursor-grab active:cursor-grabbing"
                >
                  <span className="text-slate-500">{i + 1}.</span>
                  <span className="text-slate-200">{CODEC_LABELS[c] ?? c}</span>
                  <button
                    className="text-slate-600 hover:text-danger-500 ml-1"
                    onClick={() => set({ codecs: settings.codecs.filter((x) => x !== c) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {['opus', 'G722', 'PCMU', 'PCMA', 'telephone-event']
                .filter((c) => !settings.codecs.includes(c))
                .map((c) => (
                  <button
                    key={c}
                    className="text-xs text-brand-400 border border-brand-600/40 rounded-lg px-2 py-1 hover:bg-brand-600/10"
                    onClick={() => set({ codecs: [...settings.codecs, c] })}
                  >
                    + {CODEC_LABELS[c] ?? c}
                  </button>
                ))}
            </div>
          </Card>
        )}

        {tab === 'network' && (
          <Card className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Reconnect delay (s)">
                <Input
                  type="number"
                  value={settings.transport.reconnectionDelay}
                  onChange={(e) => setTransport({ reconnectionDelay: parseInt(e.target.value) || 4 })}
                />
              </Field>
              <Field label="Keep-alive (s)">
                <Input
                  type="number"
                  value={settings.transport.keepAliveInterval}
                  onChange={(e) => setTransport({ keepAliveInterval: parseInt(e.target.value) || 25 })}
                />
              </Field>
              <Field label="ACK timer (s)">
                <Input
                  type="number"
                  value={settings.transport.ackTimer}
                  onChange={(e) => setTransport({ ackTimer: parseInt(e.target.value) || 30 })}
                />
              </Field>
            </div>
            <p className="text-xs text-slate-500">
              Reconnection attempts = 0 means infinite (recommended for desktop softphone).
            </p>
          </Card>
        )}

        {tab === 'app' && (
          <Card className="p-4 space-y-3">
            <Field label="Keep call history">
              <Select
                value={String(settings.history?.retentionDays ?? 1)}
                onChange={(v) => setHistory({ retentionDays: parseInt(v, 10) })}
                options={[
                  { value: '1', label: '1 day' },
                  { value: '7', label: '7 days' },
                  { value: '30', label: '30 days' },
                  { value: '0', label: 'Forever' },
                ]}
                className="w-full"
              />
            </Field>
            <Toggle checked={settings.ui.showCallTimer} onChange={(v) => setUi({ showCallTimer: v })} label="Show call timer" />
            <Toggle checked={settings.ui.minimizeToTray} onChange={(v) => setUi({ minimizeToTray: v })} label="Minimize to tray" />
            <Toggle checked={settings.ui.startMinimized} onChange={(v) => setUi({ startMinimized: v })} label="Start minimized" />
            {isNativeShell && (
              <Toggle
                checked={settings.ui.launchAtStartup}
                onChange={(v) => {
                  setUi({ launchAtStartup: v });
                  void window.api.setLaunchAtStartup(v);
                }}
                label="Launch at system startup"
              />
            )}
          </Card>
        )}
        {tab === 'app' && isNative() && (
          <Card className="p-4 space-y-2">
            <Label>Background connection</Label>
            <p className="text-xs text-slate-500">
              {battery === undefined
                ? 'Checking battery exemption…'
                : battery === true
                  ? 'Exempt — Android will keep the connection alive when minimized.'
                  : battery === false
                    ? 'Not exempt — Android may kill the connection when minimized and you’ll miss calls.'
                    : 'Status unavailable.'}
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void requestBatteryExemption()}>
                Open settings
              </Button>
              <Button size="sm" variant="ghost" onClick={checkBattery}>
                Re-check
              </Button>
            </div>
          </Card>
        )}

        {tab === 'logs' && (
          <Card className="p-4 space-y-3">
            <Field label="Log level">
              <Select
                value={settings.log.level}
                onChange={(v) => setLog({ level: v as LogLevel })}
                options={[
                  { value: 'debug', label: 'Debug (verbose SIP/WebRTC)' },
                  { value: 'info', label: 'Info' },
                  { value: 'warn', label: 'Warnings only' },
                  { value: 'error', label: 'Errors only' },
                ]}
                className="w-full"
              />
            </Field>
            <Field label="Retention (days)">
              <Input
                type="number"
                value={settings.log.retentionDays}
                onChange={(e) => setLog({ retentionDays: parseInt(e.target.value) || 7 })}
              />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={async () => {
                const data = await window.api.exportLog();
                const blob = new Blob([data], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `glmwebrtc-logs-${new Date().toISOString().slice(0, 10)}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}>
                Export logs
              </Button>
            </div>
          </Card>
        )}

        {tab === 'window' && isNativeShell && (
          <Card className="p-4 space-y-3">
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => void window.api.minimize()}>Minimize</Button>
              <Button size="sm" variant="ghost" onClick={() => void window.api.quit()}>Quit app</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
