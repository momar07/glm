import React, { useEffect, useState } from 'react';
import type { SipProfile } from '@shared/types';
import { useAgent } from '../store/agent';
import { useSip } from '../store/sip';
import { useSettings } from '../store/settings';
import { buildWsUrl, DEFAULT_WS_PORT } from '../lib/wsUrl';
import { Button, Input, Field, Card, Toggle } from './ui';
import { ModeSwitch } from './ModeSwitch';

// The agent never types SIP credentials: the middleware provisions the
// extension, its secret and the server on POST /api/login.
export function AgentLogin({
  onConnected,
  onSwitchMode,
}: {
  onConnected: () => void;
  onSwitchMode: () => void;
}): React.ReactElement {
  const agent = useAgent();
  const { connect, lastError, connecting } = useSip();
  const settings = useSettings((s) => s.settings);

  const [apiUrl, setApiUrl] = useState(agent.apiUrl);
  const [username, setUsername] = useState(agent.username);
  const [password, setPassword] = useState('');
  const [wsPort, setWsPort] = useState(DEFAULT_WS_PORT);
  const [crmBaseUrl, setCrmBaseUrl] = useState(agent.crmBaseUrl);
  const [trustCert, setTrustCert] = useState(agent.trustCert);
  // the native engine is a Windows helper; where it is missing the option is
  // hidden and WebRTC (WSS) is the engine
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [engine, setEngine] = useState<'native' | 'webrtc' | null>(null);
  const activeEngine = engine ?? (nativeAvailable ? 'native' : 'webrtc');

  useEffect(() => {
    void window.api
      .sipAvailable()
      .then(setNativeAvailable)
      .catch(() => setNativeAvailable(false));
  }, []);

  const busy = agent.loggingIn || connecting;
  const ready = apiUrl.trim() !== '' && username.trim() !== '' && password !== '';

  const handleLogin = async (): Promise<void> => {
    const ok = await agent.login({ apiUrl, username, password, crmBaseUrl, trustCert });
    if (!ok) return;
    const p = useAgent.getState().profile;
    if (!p) return;
    const domain = p.domain || p.server;
    const native = activeEngine === 'native';
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
      engine: native ? 'native' : 'webrtc',
      sipPort: p.port || 5060,
      transport: 'udp',
    };
    try {
      await connect(profile, settings);
      onConnected();
    } catch {
      /* error already in the sip store */
    }
  };

  return (
    <div className="h-full overflow-y-auto no-scrollbar p-4 flex flex-col items-center">
      <div className="w-full max-w-md space-y-3 my-auto">
        <header className="text-center">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white text-xl font-bold shadow-lg shadow-brand-600/30">
            G
          </div>
          <h1 className="mt-2 text-lg font-semibold text-slate-100">GLMWebrtc Softphone</h1>
          <p className="text-xs text-slate-500">Sign in with your agent account</p>
        </header>

        <ModeSwitch mode="agent" onChange={(m) => m === 'sip' && onSwitchMode()} />

        <Card className="p-4 space-y-3">
          <Field label="Middleware URL">
            <Input
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="http://192.168.2.22:8080"
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
          <div className="grid grid-cols-[1fr_5.5rem] gap-3">
            <Field label="CRM page URL (optional)">
              <Input
                value={crmBaseUrl}
                onChange={(e) => setCrmBaseUrl(e.target.value)}
                placeholder="https://crm.local/record"
                className="font-mono text-xs"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            {activeEngine === 'webrtc' ? (
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
          </div>
          <Toggle
            checked={trustCert}
            onChange={setTrustCert}
            label="Trust this server's certificate (self-signed PBX)"
          />
          {nativeAvailable && (
            <Toggle
              checked={activeEngine === 'native'}
              onChange={(v) => setEngine(v ? 'native' : 'webrtc')}
              label="Native SIP engine (UDP, G.729, audio in the helper)"
            />
          )}

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
          Your SIP credentials are provisioned by the middleware and kept in memory only.
        </p>
      </div>
    </div>
  );
}
