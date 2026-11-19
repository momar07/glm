import React, { useEffect, useState } from 'react';
import { formatDuration } from '@shared/constants';
import { agentNow, useAgent } from '../store/agent';
import { Button, Card } from './ui';

export function AgentPanel(): React.ReactElement {
  const state = useAgent((s) => s.state);
  const setStatus = useAgent((s) => s.setStatus);
  const logout = useAgent((s) => s.logout);
  const actionError = useAgent((s) => s.actionError);

  // One tick a second drives both durations; the anchors come from the server.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (!state.loggedIn) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-500">
        Not signed in as an agent.
      </div>
    );
  }

  const now = agentNow(state);
  const loginFor = formatDuration(Math.max(0, Math.round((now - state.loginAtMs) / 1000)));
  const statusFor = formatDuration(Math.max(0, Math.round((now - state.statusAtMs) / 1000)));

  const options = [
    { value: 'available', label: 'Available' },
    ...state.pauseReasons.map((r) => ({ value: r, label: `Pause — ${r}` })),
  ];
  const current = state.status === 'pause' ? state.reason : 'available';
  if (!options.some((o) => o.value === current)) {
    options.push({ value: current, label: `Pause — ${state.reason || 'not available'}` });
  }

  const onChange = (v: string): void => {
    if (v === 'available') void setStatus('available', '');
    else void setStatus('pause', v);
  };

  return (
    <div className="h-full overflow-y-auto no-scrollbar p-4">
      <div className="mx-auto max-w-md space-y-3">
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Agent</div>
              <div className="text-lg font-semibold text-slate-100">{state.extension}</div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  state.connected ? 'bg-ok-500' : 'bg-warn-500 animate-pulse'
                }`}
              />
              <span className="text-slate-400">{state.connected ? 'Connected' : 'Reconnecting…'}</span>
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5">Status</div>
            <select
              value={current}
              onChange={(e) => onChange(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-brand-500"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-950/40 border border-slate-800 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Login duration</div>
              <div className="font-mono text-slate-200">{loginFor}</div>
            </div>
            <div className="rounded-lg bg-slate-950/40 border border-slate-800 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Status duration</div>
              <div className="font-mono text-slate-200">{statusFor}</div>
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1.5">Queues</div>
            {state.queues.length === 0 ? (
              <div className="text-xs text-slate-600">No queues assigned</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {state.queues.map((q) => (
                  <span
                    key={q}
                    className="text-xs rounded-md px-2 py-1 bg-brand-600/20 text-brand-300 border border-brand-600/40 font-mono"
                  >
                    Q {q}
                  </span>
                ))}
              </div>
            )}
          </div>

          {(state.error || actionError) && (
            <div className="text-xs rounded-lg px-3 py-2 bg-danger-600/20 text-danger-500 border border-danger-600/40">
              {actionError || state.error}
            </div>
          )}

          <Button
            variant="danger"
            className="w-full"
            onClick={() => {
              if (window.confirm('Log out? You leave your queues now.')) void logout();
            }}
          >
            Log out
          </Button>
        </Card>
      </div>
    </div>
  );
}
