import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';

// ponytail: single primary window. Call-window-as-separate-window (Phase 8 bonus) deferred until modal-in-shell proves insufficient.
// Floating phonebar shell: frameless + transparent. The renderer measures
// its content and resizes the window via win:set-size, so idle the window is
// just the slim bar; it grows only while a drawer is open. The renderer
// paints only the bar/drawers (body.shell-transparent), so the window floats
// over the desktop/CRM. hasShadow is off — a native shadow would draw a dark
// box around the transparent window, defeating the float.
// alwaysOnTop is unconditional — there is no existing UI pref for it, and the
// bar is useless if it can be buried; the bar carries minimize/quit controls.
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 360,
    minHeight: 56,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    title: 'GLMWebrtc',
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    alwaysOnTop: true,
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
