// Default Asterisk WebSocket port — used when auto-fill is on and port is blank.
export const DEFAULT_WS_PORT = '8089';

export function buildWsUrl(domain: string, port?: string): string {
  const d = domain.trim();
  if (!d) return '';
  const digits = (port ?? '').replace(/\D/g, '');
  return `wss://${d}:${digits || DEFAULT_WS_PORT}/ws`;
}
