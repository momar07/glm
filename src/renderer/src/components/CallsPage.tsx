import React, { useMemo, useState } from 'react';
import { useCall } from '../store/call';
import { useContacts } from '../store/contacts';
import { Button, Select } from './ui';
import { formatDuration, historyTs } from '@shared/constants';
import { useDialer, KeypadSheet } from './Dialpad';

type Filter = 'all' | 'incoming' | 'outgoing' | 'missed' | 'failed';
type Sort = 'recent' | 'oldest' | 'longest' | 'name';

// Stored records can hold odd direction casing from older builds — compare lowercase.
function durOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function dirOf(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}
function isMissed(direction: string, status: string, durationSec: unknown): boolean {
  // Any incoming call with zero talk time — ended unanswered, rejected, or
  // failed before connecting. Talked-to calls always have duration > 0.
  return direction === 'incoming' && durOf(durationSec) === 0 && (status === 'ended' || status === 'failed');
}
function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Calls = history list with a floating keypad sheet on top.
// Tapping a row fills the sheet number (no accidental dials); the green
// button dials. Same palette as before — layout only.
export function CallsPage(): React.ReactElement {
  const history = useCall((s) => s.history);
  const clearHistory = useCall((s) => s.clearHistory);
  const contacts = useContacts((s) => s.contacts);
  const addContact = useContacts((s) => s.add);
  // Digits-only compare, same as phone-import dedupe. Names resolve live so
  // saving/renaming a contact renames every log row at once — records keep
  // only the call-time snapshot.
  const namesByNumber = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of contacts) {
      const d = c.number.replace(/\D/g, '');
      if (d && !m.has(d)) m.set(d, c.name);
    }
    return m;
  }, [contacts]);

  const saveNumber = (num: string): void => {
    const name = window.prompt(`Name for ${num}`, '');
    if (name === null) return; // cancelled
    addContact({ name: name.trim() || num, number: num });
  };
  const dialer = useDialer();
  const [expanded, setExpanded] = useState(true);
  const [q, setQ] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const out = history.filter((h) => {
      const dir = dirOf(h.direction);
      if (filter === 'incoming' && dir !== 'incoming') return false;
      if (filter === 'outgoing' && dir !== 'outgoing') return false;
      // Missed = incoming, never answered (no talk time). Rejected, auto-rejected
      // and unanswered incoming calls end with status 'ended' + 0 duration.
      if (filter === 'missed' && !isMissed(dir, h.status, h.durationSec)) return false;
      if (filter === 'failed' && h.status !== 'failed') return false;
      if (query) {
        const num = h.remote.replace(/^sip:/, '').split('@')[0].toLowerCase();
        if (!num.includes(query) && !h.remote.toLowerCase().includes(query) && !(h.displayName || '').toLowerCase().includes(query)) return false;
      }
      return true;
    });
    // Sort a copy — never mutate the store array in place.
    const sorted = [...out];
    switch (sort) {
      case 'oldest':
        sorted.sort((a, b) => historyTs(a.startedAt) - historyTs(b.startedAt));
        break;
      case 'longest':
        sorted.sort((a, b) => durOf(b.durationSec) - durOf(a.durationSec));
        break;
      case 'name':
        sorted.sort((a, b) =>
          (a.displayName || a.remote).localeCompare(b.displayName || b.remote),
        );
        break;
      case 'recent':
      default:
        sorted.sort((a, b) => historyTs(b.startedAt) - historyTs(a.startedAt));
        break;
    }
    return sorted;
  }, [history, q, filter, sort]);

  const exportCsv = (): void => {
    const rows = ['id,direction,remote,displayName,status,startedAt,durationSec'];
    for (const h of history) {
      rows.push(
        [h.id, h.direction, csv(h.remote), csv(h.displayName || ''), h.status, h.startedAt, h.durationSec ?? 0].join(','),
      );
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'glmwebrtc-history.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col relative overflow-hidden">
      <div className="px-4 pt-2 pb-1 shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-semibold text-slate-100 flex-1">Calls</h1>
          <span className="text-xs text-slate-500">{filtered.length}/{history.length}</span>
          <button
            onClick={() => setShowSearch((v) => !v)}
            aria-label="Search"
            className="p-2 text-slate-300 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <circle cx={11} cy={11} r={7} />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
          <Button size="sm" variant="ghost" onClick={exportCsv}>Export</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={history.length === 0}
            onClick={() => {
              if (window.confirm('Clear all call history?')) clearHistory();
            }}
          >
            Clear
          </Button>
        </div>
        {showSearch && (
          <input
            autoFocus
            placeholder="Search calls…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mt-2 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
          />
        )}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <div className="flex rounded-full bg-slate-800 p-0.5">
            {(['all', 'missed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-1 rounded-full text-xs font-medium capitalize transition-colors ${
                  filter === f ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <Select
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'incoming', label: 'Incoming' },
              { value: 'outgoing', label: 'Outgoing' },
              { value: 'missed', label: 'Missed' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
          <Select
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            options={[
              { value: 'recent', label: 'Newest' },
              { value: 'oldest', label: 'Oldest' },
              { value: 'longest', label: 'Longest' },
              { value: 'name', label: 'Name A–Z' },
            ]}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-16">
        {filtered.length === 0 && <div className="text-center text-slate-500 mt-10 text-sm">No calls</div>}
        <div className="divide-y divide-slate-800/70">
          {filtered.map((h) => {
            const dir = dirOf(h.direction);
            const num = h.remote.replace(/^sip:/, '').split('@')[0];
            const label = namesByNumber.get(num.replace(/\D/g, '')) || h.displayName || num;
            const missed = isMissed(dir, h.status, h.durationSec);
            const isNew = !namesByNumber.has(num.replace(/\D/g, ''));
            return (
              <div
                key={h.id}
                onClick={() => {
                  dialer.setNumber(num);
                  setExpanded(true);
                }}
                className="w-full flex items-center gap-3 py-2.5 text-left active:bg-slate-800/50 cursor-pointer"
              >
                <span className={`text-base w-5 text-center shrink-0 ${missed ? 'text-danger-500' : 'text-slate-500'}`}>
                  {dir === 'incoming' ? (missed ? '↙' : '↙') : '↗'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={`text-base truncate ${missed ? 'text-danger-500' : 'text-slate-100'}`}>{label}</div>
                  {label !== num && <div className="text-xs text-slate-500 font-mono truncate">{num}</div>}
                </div>
                {isNew && (
                  <button
                    aria-label={`Save ${num} to contacts`}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveNumber(num);
                    }}
                    className="shrink-0 h-8 w-8 rounded-full border border-slate-700 text-brand-400 hover:bg-slate-800 active:scale-95 transition text-lg leading-none"
                  >
                    +
                  </button>
                )}
                <div className="text-right shrink-0">
                  <div className="text-xs text-slate-400">{formatDuration(h.durationSec ?? 0)}</div>
                  <div className="text-[11px] text-slate-600">{new Date(h.startedAt).toLocaleDateString()}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <KeypadSheet dialer={dialer} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
    </div>
  );
}
