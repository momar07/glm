import type { LogEntry, LogLevel } from '@shared/types';

// Renderer logger: keeps an in-memory ring buffer for the dev log viewer AND
// forwards to the main process for disk persistence. No framework, no deps.
const RING_SIZE = 500;
const ring: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

export function log(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, msg, data };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  for (const cb of listeners) {
    try {
      cb(entry);
    } catch {
      /* ignore */
    }
  }
  // Fire-and-forget; never block UI on disk writes.
  window.api.writeLog(entry).catch(() => {
    /* main may be unavailable during shutdown */
  });
}

export const logger = {
  debug: (scope: string, msg: string, data?: unknown) => log('debug', scope, msg, data),
  info: (scope: string, msg: string, data?: unknown) => log('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => log('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => log('error', scope, msg, data),
};

export function subscribeLogs(cb: (e: LogEntry) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLogs(): LogEntry[] {
  return ring.slice();
}

export function clearLogs(): void {
  ring.length = 0;
}
