import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SipEngineEvent,
  SipHelperAnswer,
  SipHelperCommand,
  SipHelperEvent,
} from '../shared/sipHelper';

// The native helper is a Windows x64 executable built by
// tools/build-native.sh; every other platform falls back to the WebRTC engine.

export interface SipHelperDeps {
  // An explicit executable and its arguments (tests, debugging). When set, the
  // default location below is not looked at.
  path?: string | null;
  args?: string[];
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

function defaultPath(): string | null {
  if (process.platform !== 'win32') return null;
  // packaged: electron-builder copies resources/ next to the app
  // dev: the app runs from the project root
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resources ? join(resources, 'sip-helper.exe') : '',
    join(process.cwd(), 'resources', 'sip-helper.exe'),
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

type Pending = {
  resolve: (answer: SipHelperAnswer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const COMMAND_TIMEOUT_MS = 8000;
const RESTART_DELAY_MS = 1000;

// One helper process, one account. Commands are matched to answers by id;
// events are forwarded as they come. If the process dies the account is
// registered again on a fresh process — the renderer only sees the events.
export class SipHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private lastRegister: Extract<SipHelperCommand, { cmd: 'register' }> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private readonly onEvent: (event: SipEngineEvent) => void;
  private readonly deps: SipHelperDeps;

  constructor(onEvent: (event: SipEngineEvent) => void, deps: SipHelperDeps = {}) {
    this.onEvent = onEvent;
    this.deps = deps;
  }

  available(): boolean {
    return this.deps.path !== undefined ? this.deps.path !== null : defaultPath() !== null;
  }

  async send(command: SipHelperCommand): Promise<SipHelperAnswer> {
    if (command.cmd === 'register') this.lastRegister = command;
    if (command.cmd === 'unregister') {
      this.lastRegister = null;
      if (!this.child) return { id: 0, ok: true };
    }
    const child = this.ensureChild();
    if (!child) throw new Error('the native engine is not installed');

    const id = this.nextId++;
    return new Promise<SipHelperAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the native engine did not answer "${command.cmd}"`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  dispose(): void {
    this.closing = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.failPending(new Error('the native engine stopped'));
    const child = this.child;
    this.child = null;
    if (!child) return;
    // pjsua needs a moment to release the sound device
    try {
      child.stdin.write('{"cmd":"shutdown"}\n');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2000).unref();
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.deps.log?.(level, message);
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child;
    const path = this.deps.path !== undefined ? this.deps.path : defaultPath();
    if (!path) return null;

    const child = spawn(path, this.deps.args ?? [], { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    this.buffer = '';
    this.closing = false;
    this.log('info', `native engine started (${path})`);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.log('warn', `native engine: ${chunk.trim()}`));
    child.on('error', (error) => this.log('error', `native engine error: ${error.message}`));
    child.on('exit', (code) => this.onExit(code));
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log('warn', `native engine said something odd: ${line}`);
        continue;
      }

      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (typeof message.error === 'string') pending.reject(new Error(message.error));
        else pending.resolve(message as unknown as SipHelperAnswer);
        continue;
      }

      if (typeof message.event === 'string') {
        const event = message as unknown as SipHelperEvent;
        if (event.event === 'callState') {
          this.log('debug', `call ${event.callId}: ${event.state} ${event.text}`);
        }
        this.onEvent(event);
      }
    }
  }

  private onExit(code: number | null): void {
    const wasRunning = this.child !== null;
    this.child = null;
    this.failPending(new Error('the native engine stopped'));
    if (!wasRunning) return;

    this.log('warn', `native engine exited (${code})`);
    this.onEvent({ event: 'helper', alive: false });
    const register = this.lastRegister;
    if (this.closing || !register) return;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.send(register).catch((error: Error) => {
        this.log('error', `the native engine could not register again: ${error.message}`);
        this.onEvent({
          event: 'registration',
          extension: register.extension,
          ok: false,
          status: -1,
        });
      });
    }, RESTART_DELAY_MS);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
