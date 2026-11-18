import { ipcMain, Notification, app, dialog, BrowserWindow } from 'electron';
import { IPC, type AppSettings, type LogEntry, type NotifyOptions } from '../shared/types';
import { settingsStore } from './store';
import { fileLogger, mainLog } from './logger';

// ponytail: per-channel validators as plain guards. Promote to a zod schema if IPC surface grows.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isLogEntry(v: unknown): v is LogEntry {
  return (
    isObject(v) &&
    typeof v.ts === 'number' &&
    typeof v.level === 'string' &&
    typeof v.scope === 'string' &&
    typeof v.msg === 'string'
  );
}
function isNotify(v: unknown): v is NotifyOptions {
  return isObject(v) && typeof v.title === 'string' && typeof v.body === 'string';
}

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.SETTINGS_GET, () => settingsStore.get());

  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => {
    if (!isObject(patch)) throw new Error('settings patch must be an object');
    const next = settingsStore.set(patch);
    mainLog('info', 'ipc', 'settings updated', { keys: Object.keys(patch) });
    return next;
  });

  ipcMain.handle(IPC.LOG_WRITE, (_e, entry: unknown) => {
    if (!isLogEntry(entry)) throw new Error('invalid log entry');
    fileLogger.write(entry);
  });

  ipcMain.handle(IPC.LOG_EXPORT, () => fileLogger.readAll());

  ipcMain.handle(IPC.NOTIFY, (_e, opts: unknown) => {
    if (!isNotify(opts)) throw new Error('invalid notify options');
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: opts.title, body: opts.body, silent: opts.silent });
    n.on('click', () => {
      const w = getMainWindow();
      if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
      }
    });
    n.show();
  });

  ipcMain.handle(IPC.APP_QUIT, () => app.quit());
  ipcMain.handle(IPC.APP_MINIMIZE, () => {
    getMainWindow()?.minimize();
  });

  ipcMain.handle(IPC.APP_LAUNCH_AT_STARTUP, (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  });

  ipcMain.handle(IPC.DIALOG_OPEN_CSV, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, {
      title: 'Import CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  ipcMain.handle(IPC.DIALOG_SAVE_CSV, async (_e, defaultName: string) => {
    const w = getMainWindow();
    if (!w) return null;
    const r = await dialog.showSaveDialog(w, {
      title: 'Export CSV',
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    return r.canceled ? null : r.filePath ?? null;
  });

  mainLog('info', 'ipc', 'handlers registered');
}
