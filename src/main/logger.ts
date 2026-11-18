import { join } from 'node:path';
import { mkdirSync, appendFileSync, existsSync, readdirSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import type { LogEntry, LogLevel } from '../shared/types';
import { LEVEL_ORDER } from '../shared/constants';
import { getLogDir } from './store';

class FileLogger {
  private minLevel: number = LEVEL_ORDER.info;
  private listeners = new Set<(e: LogEntry) => void>();

  setLevel(level: LogLevel): void {
    this.minLevel = LEVEL_ORDER[level];
  }

  start(level: LogLevel): void {
    this.minLevel = LEVEL_ORDER[level];
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    this.sweep();
  }

  write(entry: LogEntry): void {
    if (LEVEL_ORDER[entry.level] < this.minLevel) return;
    const dir = getLogDir();
    const file = join(dir, `app-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      appendFileSync(
        file,
        `${new Date(entry.ts).toISOString()} [${entry.level.toUpperCase()}] ${entry.scope}: ${entry.msg}${
          entry.data ? ` ${safeStringify(entry.data)}` : ''
        }\n`,
      );
    } catch {
      /* disk full / perms — swallow, logging must never throw */
    }
    for (const cb of this.listeners) {
      try {
        cb(entry);
      } catch {
        /* ignore */
      }
    }
  }

  /** Subscribers get every entry (used to forward to renderer dev view). */
  subscribe(cb: (e: LogEntry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Read all log files (newest last) for export. */
  readAll(): string {
    const dir = getLogDir();
    if (!existsSync(dir)) return '';
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort();
    let out = '';
    for (const f of files) {
      try {
        out += `\n===== ${f} =====\n`;
        out += readFileSync(join(dir, f), 'utf8');
      } catch {
        /* skip */
      }
    }
    return out;
  }

  private sweep(): void {
    const dir = getLogDir();
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - 7 * 86400_000;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue;
      try {
        const p = join(dir, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* skip */
      }
    }
  }
}

function safeStringify(d: unknown): string {
  try {
    return typeof d === 'string' ? d : JSON.stringify(d);
  } catch {
    return String(d);
  }
}

export const fileLogger = new FileLogger();

export function mainLog(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  fileLogger.write({ ts: Date.now(), level, scope, msg, data });
}
