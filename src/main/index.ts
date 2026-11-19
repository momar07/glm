import { app, BrowserWindow, session } from 'electron';
import { createWindow } from './window';
import { registerIpc, shutdownAgent } from './ipc';
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

  // Accept an untrusted certificate only for hosts the user explicitly trusted
  // (the agent login toggle). -3 = Chromium's default verdict for everyone else.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const trusted = settingsStore.get().security?.trustedHosts?.includes(request.hostname.toLowerCase());
    callback(trusted ? 0 : -3);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  shutdownAgent();
  mainLog('info', 'main', 'app quitting');
});
