// The protocol of the native helper (resources/sip-helper.exe): JSON lines on
// stdin (commands, one answer each with the same id) and on stdout (answers
// and events). The main process is the only one that talks to it.

export type SipHelperCommand =
  | {
      cmd: 'register';
      server: string;
      port: number;
      extension: string;
      password: string;
      transport: 'udp' | 'tcp' | 'tls';
      codecs?: string[];
    }
  | { cmd: 'unregister' }
  | { cmd: 'call'; target: string }
  | { cmd: 'answer'; callId: number }
  | { cmd: 'hangup'; callId: number }
  | { cmd: 'mute'; callId: number; on: boolean }
  | { cmd: 'hold'; callId: number; on: boolean }
  | { cmd: 'dtmf'; callId: number; digits: string }
  | { cmd: 'transfer'; callId: number; target: string }
  | { cmd: 'ping' };

export type SipHelperCallState =
  | 'NULL'
  | 'CALLING'
  | 'INCOMING'
  | 'EARLY'
  | 'CONNECTING'
  | 'CONFIRMED'
  | 'DISCONNECTED'
  | 'UNKNOWN';

export type SipHelperEvent =
  | { event: 'registration'; extension: string; ok: boolean; status: number }
  | { event: 'incoming'; callId: number; from: string; to: string }
  | { event: 'callState'; callId: number; state: SipHelperCallState; text: string }
  | { event: 'media'; callId: number; active: boolean }
  | { event: 'codecs'; codecs: { id: string; priority: number }[] }
  | { event: 'error'; message: string };

// What the main process sends to the renderer: the events of the helper plus
// the life of the process itself (a restart is handled in the main process).
export type SipEngineEvent = SipHelperEvent | { event: 'helper'; alive: boolean };

export interface SipHelperAnswer {
  id: number;
  ok?: boolean;
  callId?: number;
  error?: string;
}
