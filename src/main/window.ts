import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';

// ponytail: single primary window. Call-window-as-separate-window (Phase 8 bonus) deferred until modal-in-shell proves insufficient.
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 800,
    minWidth: 360,
    minHeight: 600,
    show: false,
    frame: true,
    title: 'GLMWebrtc',
    backgroundColor: '#020617',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for preload to access node in our contextBridge; context isolation still on
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Load renderer. electron-vite dev server in dev, built file in prod.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
