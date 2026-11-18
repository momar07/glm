import React, { useEffect, useState } from 'react';
import { Button, Card } from './ui';
import { subscribeLogs, getLogs, clearLogs } from '../lib/logger';
import type { LogEntry, LogLevel } from '@shared/types';
import { LEVEL_ORDER } from '@shared/constants';

const levelColor: Record<LogLevel, string> = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-warn-500',
  error: 'text-danger-500',
};

export function Logs(): React.ReactElement {
  const [entries, setEntries] = useState<LogEntry[]>(getLogs());
  const [level, setLevel] = useState<LogLevel>('debug');
  const [auto, setAuto] = useState(true);

  useEffect(() => subscribeLogs(() => {
    if (auto) setEntries(getLogs());
  }), [auto]);

  const visible = entries.filter((e) => LEVEL_ORDER[e.level] >= LEVEL_ORDER[level]);

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      <div className="flex items-center gap-2">
        {(['debug', 'info', 'warn', 'error'] as LogLevel[]).map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={`text-xs px-2 py-1 rounded ${level === l ? 'bg-brand-600 text-white' : 'bg-slate-800 text-slate-400'}`}
          >
            {l.toUpperCase()}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1 text-xs text-slate-400">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-scroll
        </label>
        <Button size="sm" variant="ghost" onClick={async () => {
          const data = await window.api.exportLog();
          const blob = new Blob([data], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `glmwebrtc-logs-${new Date().toISOString().slice(0, 10)}.txt`;
          a.click();
          URL.revokeObjectURL(url);
        }}>Export</Button>
        <Button size="sm" variant="ghost" onClick={() => { clearLogs(); setEntries([]); }}>Clear</Button>
      </div>
      <Card className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 && <div className="text-slate-600">No log entries</div>}
        {visible.map((e, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            <span className="text-slate-600">{new Date(e.ts).toISOString().slice(11, 19)} </span>
            <span className={levelColor[e.level]}>{e.level.toUpperCase().padEnd(5)} </span>
            <span className="text-slate-400">{e.scope}: </span>
            <span className="text-slate-200">{e.msg}</span>
            {e.data != null && (
              <span className="text-slate-600">
                {' '}
                {typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}
              </span>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
