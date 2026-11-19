import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { useSip } from '../store/sip';
import { useCall } from '../store/call';
import { useAgent } from '../store/agent';
import { isNative } from '../lib/platform';
import { PresenceDot } from './ui';

const presenceLabel: Record<string, string> = {
  online: 'Online',
  registering: 'Registering…',
  offline: 'Offline',
  'on-call': 'On Call',
  'connection-lost': 'Connection Lost',
  busy: 'Busy',
};

export function StatusBar(): React.ReactElement {
  const presence = useSip((s) => s.presence);
  const transport = useSip((s) => s.transportConnected);
  const disconnect = useSip((s) => s.disconnect);
  const calls = useCall((s) => s.calls);
  const active = calls.filter((c) => c.status !== 'ended' && c.status !== 'failed').length;
  const agent = useAgent((s) => s.state);
  const [menuOpen, setMenuOpen] = useState(false);

  const logout = (): void => {
    setMenuOpen(false);
    if (window.confirm('Disconnect and logout? Any active call will end.')) {
      if (agent.loggedIn) void useAgent.getState().logout();
      void disconnect();
    }
  };

  const items: [string, string][] = [
    ['/logs', 'Logs'],
    ['/settings', 'Settings'],
  ];

  // On Android the system status bar can overlap the header — push the row
  // (including ⋮) below it on native. Desktop keeps the compact height.
  const native = isNative();

  return (
    <div
      // z-30 keeps the header above page content (keypad sheet is z-20).
      // The ⋮ menu itself is portaled to document.body below: backdrop-blur
      // traps fixed descendants in this stacking context, so a backdrop
      // rendered here only covered the header strip and outside taps never
      // reached it — the menu could only close via the ⋮ button.
      // IncomingCall overlay (z-50 in root context) still covers everything.
      className={`relative z-30 flex items-center justify-between gap-2 px-2 border-b border-slate-800 bg-slate-900/80 backdrop-blur ${
        native ? 'min-h-[80px] pt-8' : 'h-11'
      }`}
    >
      <div className="flex items-center gap-1.5 text-sm shrink-0 min-w-0">
        <PresenceDot presence={presence} />
        <span className="font-medium text-slate-200 truncate">{presenceLabel[presence] ?? 'Unknown'}</span>
        {transport && <span className="text-xs text-slate-500 hidden sm:inline">· WSS</span>}
        {agent.loggedIn && (
          <span className="text-xs text-slate-400 whitespace-nowrap hidden sm:inline">
            · {agent.status === 'pause' ? `Paused${agent.reason ? ` (${agent.reason})` : ''}` : 'Available'}
          </span>
        )}
        {agent.loggedIn && agent.queues.length > 0 && (
          <span className="text-xs text-brand-400 whitespace-nowrap hidden md:inline">
            · Q {agent.queues.join(', ')}
          </span>
        )}
        {agent.loggedIn && !agent.connected && (
          <span className="text-xs text-warn-400 whitespace-nowrap">· agent offline</span>
        )}
        {active > 0 && <span className="text-xs text-brand-400 whitespace-nowrap">· {active} call{active > 1 ? 's' : ''}</span>}
      </div>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Menu"
        className="shrink-0 px-3 py-1.5 rounded-md text-slate-300 text-lg leading-none hover:bg-slate-800 transition-colors"
      >
        ⋮
      </button>
      {menuOpen &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <nav
              className={`fixed right-1 z-40 w-44 rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl ${
                native ? 'top-[84px]' : 'top-12'
              }`}
            >
              {items.map(([to, label]) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    `block px-4 py-2.5 text-sm transition-colors ${
                      isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`
                  }
                >
                  {label}
                </NavLink>
              ))}
              <div className="my-1 border-t border-slate-800" />
              <button
                onClick={logout}
                className="block w-full text-left px-4 py-2.5 text-sm text-slate-400 hover:text-danger-400 hover:bg-slate-800 transition-colors"
              >
                Logout
              </button>
            </nav>
          </>,
          document.body,
        )}
    </div>
  );
}
