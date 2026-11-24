import React, { useEffect, useRef, useState } from 'react';
import type { SipProfile } from '@shared/types';
import { useAgent } from '../store/agent';
import { useSip } from '../store/sip';
import { useSettings } from '../store/settings';
import { buildWsUrl, DEFAULT_WS_PORT } from '../lib/wsUrl';
import { Button, Input, Field, Card, Toggle } from './ui';

// The agent never types SIP credentials: the middleware provisions the
// extension, its secret and the server on POST /api/login.

// The Server field takes just an IP: a bare IP gets the default middleware
// port, ip:port keeps its port, and a full http(s) URL is used as-is.
function normalizeApiUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(v)) return v;
  if (v.includes(':')) return `http://${v}`;
  return `http://${v}:8080`;
}

// Startup auto-login runs at most once per app launch: after a logout the
// login page remounts, and it must stay idle until the next launch.
let autoLoginAttempted = false;

export function AgentLogin({ onConnected }: { onConnected?: () => void }): React.ReactElement {
  const agent = useAgent();
  const { connect, lastError, connecting } = useSip();
  const settings = useSettings((s) => s.settings);

  const [serverIp, setServerIp] = useState(agent.serverIp);
  const [username, setUsername] = useState(agent.username);
  const [password, setPassword] = useState(agent.savedPassword);
  const [wsPort, setWsPort] = useState(DEFAULT_WS_PORT);
  const [saveCredentials, setSaveCredentials] = useState(agent.saveCredentials);
  const [autoLogin, setAutoLogin] = useState(agent.autoLogin);
  const [webrtcPref, setWebrtcPref] = useState(agent.webrtc);
  // the native engine is a Windows helper; where it is missing the WebRTC
  // engine is the only option, so the toggle is forced on and locked
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativeChecked, setNativeChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    window.api
      .sipAvailable()
      .then((v) => {
        if (alive) setNativeAvailable(v);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setNativeChecked(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const nativeMissing = nativeChecked && !nativeAvailable;
  const webrtc = nativeMissing ? true : webrtcPref;

  const busy = agent.loggingIn || connecting;
  const ready = serverIp.trim() !== '' && username.trim() !== '' && password !== '';

  const handleLogin = async (): Promise<void> => {
    const ok = await agent.login({
      apiUrl: normalizeApiUrl(serverIp),
      username,
      password,
      crmBaseUrl: agent.crmBaseUrl,
      trustCert: agent.trustCert,
      serverIp: serverIp.trim(),
      saveCredentials,
      autoLogin,
      webrtc,
    });
    if (!ok) return;
    const p = useAgent.getState().profile;
    if (!p) return;
    const domain = p.domain || p.server;
    const profile: SipProfile = {
      id: `agent:${p.extension}`,
      label: `Agent ${p.extension}`,
      displayName: username,
      username: p.extension,
      password: p.password,
      sipDomain: domain,
      wsUrl: buildWsUrl(domain, wsPort),
      autoWsUrl: true,
      wsPort,
      engine: webrtc ? 'webrtc' : 'native',
      sipPort: p.port || 5060,
      transport: 'udp',
    };
    try {
      await connect(profile, settings);
      onConnected?.();
    } catch {
      /* error already in the sip store */
    }
  };

  // Explicit startup auto-login: only with saved credentials and the
  // Auto login preference on, and only once the engine check has settled
  // (so the saved engine choice is the one that actually runs).
  const loginRef = useRef(handleLogin);
  loginRef.current = handleLogin;
  useEffect(() => {
    if (!nativeChecked || autoLoginAttempted) return;
    const a = useAgent.getState();
    if (a.autoLogin && a.saveCredentials && a.savedPassword && a.username.trim() && a.serverIp.trim()) {
      autoLoginAttempted = true;
      void loginRef.current();
    }
  }, [nativeChecked]);

  const onSaveCredentials = (v: boolean): void => {
    setSaveCredentials(v);
    if (!v) setAutoLogin(false);
    agent.updatePrefs({ saveCredentials: v });
  };
  const onAutoLogin = (v: boolean): void => {
    setAutoLogin(v);
    agent.updatePrefs({ autoLogin: v });
  };
  const onWebrtc = (v: boolean): void => {
    setWebrtcPref(v);
    agent.updatePrefs({ webrtc: v });
  };

  return (
    <div className="p-3 flex flex-col items-center">
      <div className="w-full space-y-2.5">
        <header className="text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white text-xl font-bold shadow-lg shadow-brand-600/30">
            G
          </div>
          <h1 className="mt-2 text-lg font-semibold text-slate-100">GLMWebrtc Softphone</h1>
          <p className="text-xs text-slate-500">Sign in with your agent account</p>
        </header>

        <Card className="p-3 space-y-3">
          <Field label="Server IP">
            <Input
              value={serverIp}
              onChange={(e) => setServerIp(e.target.value)}
              placeholder="192.168.2.22"
              className="font-mono text-xs"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Agent username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="agent1"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          {webrtc ? (
            <Field label="WSS port">
              <Input
                value={wsPort}
                onChange={(e) => setWsPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                placeholder={DEFAULT_WS_PORT}
                inputMode="numeric"
                className="font-mono text-xs text-center"
              />
            </Field>
          ) : (
            <Field label="SIP port">
              <div className="h-9 flex items-center justify-center rounded-lg bg-slate-800/60 text-xs font-mono text-slate-400">
                from middleware
              </div>
            </Field>
          )}

          <div className="space-y-2">
            <Toggle checked={saveCredentials} onChange={onSaveCredentials} label="Save credentials" />
            <div className={saveCredentials ? '' : 'opacity-50 pointer-events-none'}>
              <Toggle checked={autoLogin} onChange={onAutoLogin} label="Auto login" />
            </div>
            <div className={nativeMissing ? 'opacity-50 pointer-events-none' : ''}>
              <Toggle checked={webrtc} onChange={onWebrtc} label="WebRTC" />
            </div>
            {nativeMissing && (
              <p className="text-xs text-slate-500">The native SIP engine is not available on this system — WebRTC is used.</p>
            )}
          </div>

          {agent.loginError && (
            <div className="text-xs rounded-lg px-3 py-2 bg-danger-600/20 text-danger-500 border border-danger-600/40">
              {agent.loginError}
            </div>
          )}
          {lastError && (
            <div className="text-xs rounded-lg px-3 py-2 bg-danger-600/20 text-danger-500 border border-danger-600/40">
              SIP registration failed: {lastError}
            </div>
          )}

          <Button
            variant="primary"
            className="w-full"
            onClick={() => void handleLogin()}
            disabled={busy || !ready}
          >
            {agent.loggingIn ? 'Signing in…' : connecting ? 'Registering…' : 'Sign in'}
          </Button>
        </Card>

        <p className="text-center text-xs text-slate-600">
          Your SIP credentials are provisioned by the middleware.
        </p>
      </div>
    </div>
  );
}
