import React, { useEffect, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { useSettings } from '../store/settings';
import { useSip } from '../store/sip';
import { isNative, isNativeShell } from '../lib/platform';
import { Button, Input, Field, Card, Toggle } from './ui';
import { ModeSwitch, type LoginMode } from './ModeSwitch';
import { AgentLogin } from './AgentLogin';
import { buildWsUrl } from '../lib/wsUrl';
import type { SipProfile } from '@shared/types';
import { logger } from '../lib/logger';

function testWss(url: string, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let done = false;
    const finish = (ok: boolean, error?: string): void => {
      if (done) return;
      done = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, error });
    };
    try {
      ws = new WebSocket(url, 'sip');
    } catch (e: any) {
      return finish(false, e?.message || 'invalid url');
    }
    const t = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      finish(true);
    };
    ws.onerror = () => {
      clearTimeout(t);
      finish(false, 'connection error');
    };
  });
}

export function Login({ onConnected }: { onConnected: () => void }): React.ReactElement {
  const { settings, loaded, patch, upsertProfile, removeProfile, setActiveProfile } = useSettings();
  const { connect, presence, lastError, connecting } = useSip();
  const [editing, setEditing] = useState<SipProfile | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [form, setForm] = useState<SipProfile>(blankProfile());
  // "Call center agent" is the default tab on startup in the desktop shell;
  // the user can still switch to a plain SIP account. Web keeps SIP first
  // (agent mode needs the desktop middleware bridge).
  const [mode, setMode] = useState<LoginMode>(() => (isNativeShell ? 'agent' : 'sip'));

  useEffect(() => {
    if (editing) setForm(editing);
    else if (settings.profiles.length === 0) setForm(blankProfile());
    else setForm(settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]);
  }, [editing, settings]);

  useEffect(() => {
    if (presence === 'online') onConnected();
  }, [presence, onConnected]);

  const set = (k: keyof SipProfile, v: string | boolean): void =>
    setForm((f) => ({ ...f, [k]: v }));

  // Effective WebSocket URL: auto-derived from domain + port, or typed manually.
  const wsUrl = form.autoWsUrl ? buildWsUrl(form.sipDomain, form.wsPort) : form.wsUrl;

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    const r = await testWss(wsUrl);
    setTestResult(r);
    logger.info('login', `WSS test ${r.ok ? 'ok' : 'failed'}`, r);
  };

  const withWsUrl = (f: SipProfile): SipProfile => (f.autoWsUrl ? { ...f, wsUrl } : f);

  const handleSave = (): void => {
    const saved = upsertProfile(withWsUrl(form));
    setForm(saved);
    setEditing(null);
  };

  const handleConnect = async (): Promise<void> => {
    const saved = upsertProfile(withWsUrl(form));
    await setActiveProfile(saved.id);
    try {
      await connect(saved, settings);
    } catch {
      /* error already in store */
    }
  };

  if (!loaded) {
    return <div className="flex items-center justify-center h-full text-slate-500">Loading…</div>;
  }

  if (mode === 'agent') {
    return <AgentLogin onConnected={onConnected} />;
  }

  return (
    <div className="p-3 flex flex-col items-center">
      <div className="w-full space-y-2.5">
        <header className="text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white text-xl font-bold shadow-lg shadow-brand-600/30">
            G
          </div>
          <h1 className="mt-2 text-lg font-semibold text-slate-100">GLMWebrtc Softphone</h1>
          <p className="text-xs text-slate-500">Connect to your SIP / WebRTC PBX</p>
        </header>

        {isNativeShell && <ModeSwitch mode={mode} onChange={setMode} />}

        {settings.profiles.length > 0 && (
          <Card className="p-2.5">
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5 px-1">Saved profiles</div>
            <div className="space-y-1 max-h-28 overflow-y-auto no-scrollbar">
              {settings.profiles.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 cursor-pointer ${
                    form.id === p.id ? 'bg-brand-600/20 border border-brand-600/40' : 'hover:bg-slate-800'
                  }`}
                  onClick={() => setForm(p)}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-200 truncate">{p.label}</div>
                    <div className="text-xs text-slate-500 truncate">{p.username}@{p.sipDomain}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="text-xs text-slate-500 hover:text-slate-200 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(p);
                      }}
                    >
                      edit
                    </button>
                    <button
                      className="text-xs text-danger-500 hover:text-danger-600 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeProfile(p.id);
                      }}
                    >
                      del
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card className="p-3 space-y-3">
          <Field label="Profile label">
            <Input value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="Office / Issabel" />
          </Field>
          <Field label="Display name">
            <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Momar" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username / extension">
              <Input value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="1001" />
            </Field>
            <Field label="SIP domain">
              <Input value={form.sipDomain} onChange={(e) => set('sipDomain', e.target.value)} placeholder="pbx.example.com" />
            </Field>
          </div>
          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <Field label="WebSocket URL (WSS)">
                <Input
                  value={wsUrl}
                  onChange={(e) => set('wsUrl', e.target.value)}
                  placeholder="wss://pbx.example.com:8089/ws"
                  className="font-mono text-xs"
                  disabled={!!form.autoWsUrl}
                />
              </Field>
            </div>
            {form.autoWsUrl && (
              <div className="w-20 shrink-0">
                <Field label="Port">
                  <Input
                    value={form.wsPort ?? ''}
                    onChange={(e) => set('wsPort', e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="8089"
                    inputMode="numeric"
                    className="font-mono text-xs text-center"
                  />
                </Field>
              </div>
            )}
          </div>
          <Toggle
            checked={!!form.autoWsUrl}
            onChange={(v) => set('autoWsUrl', v)}
            label="Auto-fill WSS URL from domain (blank port = 8089)"
          />
          <Field label="Password">
            <Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} />
          </Field>

          {testResult && (
            <div
              className={`text-xs rounded-lg px-3 py-2 ${
                testResult.ok ? 'bg-ok-600/20 text-ok-500 border border-ok-600/40' : 'bg-danger-600/20 text-danger-500 border border-danger-600/40'
              }`}
            >
              {testResult.ok ? 'WebSocket reachable' : `WSS test failed: ${testResult.error}`}
            </div>
          )}
          {lastError && (
            <div className="text-xs rounded-lg px-3 py-2 bg-danger-600/20 text-danger-500 border border-danger-600/40">
              Registration failed: {lastError}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleTest} disabled={testing || !wsUrl}>
              {testing ? 'Testing…' : 'Test WSS'}
            </Button>
            <Button variant="ghost" onClick={handleSave}>
              Save
            </Button>
            <Button variant="primary" className="flex-1" onClick={handleConnect} disabled={connecting || !form.username || !wsUrl}>
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
          <Toggle
            checked={settings.ui.autoSignIn !== false}
            onChange={(v) => void patch({ ui: { ...settings.ui, autoSignIn: v } })}
            label="Sign in automatically when the app opens"
          />
        </Card>

        <p className="text-center text-xs text-slate-600">
          Stored encrypted locally. Never transmitted except to your PBX.
        </p>
        {isNative() && (
          <button
            className="mx-auto block text-xs text-slate-500 hover:text-danger-400 border border-slate-800 rounded-lg px-4 py-2 transition-colors"
            onClick={() => void CapApp.exitApp()}
          >
            Exit app
          </button>
        )}
      </div>
    </div>
  );
}

function blankProfile(): SipProfile {
  return {
    id: '',
    label: 'New profile',
    displayName: '',
    username: '',
    password: '',
    sipDomain: '',
    wsUrl: '',
    autoWsUrl: true,
  };
}
