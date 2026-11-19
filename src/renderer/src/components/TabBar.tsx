import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAgent } from '../store/agent';

// Bottom tabs: Calls | Contacts (+ Agent while signed in). Logs/Settings stay in the header ⋮ menu.
export function TabBar(): React.ReactElement {
  const agentLoggedIn = useAgent((s) => s.state.loggedIn);
  const cls = ({ isActive }: { isActive: boolean }): string =>
    `flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
      isActive ? 'text-brand-400' : 'text-slate-500 hover:text-slate-300'
    }`;
  return (
    <nav className="shrink-0 border-t border-slate-800 bg-slate-900/95 backdrop-blur flex">
      <NavLink to="/" end className={cls}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        Calls
      </NavLink>
      <NavLink to="/contacts" className={cls}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x={3} y={4} width={18} height={16} rx={2} />
          <circle cx={9} cy={10} r={2} />
          <path d="M6.5 16c.6-1.4 1.5-2 2.5-2s1.9.6 2.5 2" />
          <path d="M14 9h4M14 12.5h4" />
        </svg>
        Contacts
      </NavLink>
      {agentLoggedIn && (
        <NavLink to="/agent" className={cls}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
          </svg>
          Agent
        </NavLink>
      )}
    </nav>
  );
}
