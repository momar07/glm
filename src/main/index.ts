import { app, BrowserWindow } from 'electron';
import { createWindow } from './window';
import { registerIpc } from './ipc';
import { fileLogger, mainLog } from './logger';
import { settingsStore } from './store';

let mainWindow: BrowserWindow | null = null;

// Single instance lock — second launches focus the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  const settings = settingsStore.get();
  fileLogger.start(settings.log.level);
  mainLog('info', 'main', 'app ready', { version: app.getVersion(), settingsPath: settingsStore.path });

  mainWindow = createWindow();
  registerIpc(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  mainLog('info', 'main', 'app quitting');
});
