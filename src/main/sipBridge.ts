import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../shared/types';
import type { SipHelperCommand } from '../shared/sipHelper';
import { SipHelper } from './sipHelper';
import { mainLog } from './logger';

let helper: SipHelper | null = null;

function isCommand(v: unknown): v is SipHelperCommand {
  return typeof v === 'object' && v !== null && typeof (v as { cmd?: unknown }).cmd === 'string';
}

export function registerSipIpc(getMainWindow: () => BrowserWindow | null): void {
  helper = new SipHelper(
    (event) => {
      getMainWindow()?.webContents.send(IPC.SIP_EVENT, event);
    },
    { log: (level, message) => mainLog(level, 'sip', message) },
  );

  ipcMain.handle(IPC.SIP_AVAILABLE, () => helper?.available() ?? false);
  ipcMain.handle(IPC.SIP_COMMAND, (_e, command: unknown) => {
    if (!isCommand(command)) throw new Error('invalid sip command');
    return helper!.send(command);
  });
}

export function shutdownSip(): void {
  helper?.dispose();
  helper = null;
}
