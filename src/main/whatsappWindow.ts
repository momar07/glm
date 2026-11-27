import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { IPC } from '../shared/types';
import { mainLog } from './logger';

// The WhatsApp chat window (v5.24): ONE separate window — customer list
// on the left, the open conversation on the right — created on demand
// when the agent opens a ticket from the phonebar, then reused for
// every ticket after that (opening another ticket just re-focuses it).
// Deliberately unlike the bar window: solid (not transparent),
// resizable, with its own renderer surface (the same bundle loaded
// with ?wa=chat). It opens just below the bar and stays on top with
// it, so the pair reads as one workspace; closing it never touches
// the bar.
let chatWindow: BrowserWindow | null = null;
let pendingTicketId: number | null = null;

const CHAT_WIDTH = 880;
const CHAT_HEIGHT = 600;

export function getWhatsAppWindow(): BrowserWindow | null {
  return chatWindow && !chatWindow.isDestroyed() ? chatWindow : null;
}

function positionBelowBar(win: BrowserWindow, bar: BrowserWindow | null): void {
  if (!bar) {
    win.setSize(CHAT_WIDTH, CHAT_HEIGHT);
    win.center();
    return;
  }
  const b = bar.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(CHAT_WIDTH, area.width);
  const height = Math.min(CHAT_HEIGHT, area.height);
  const x = Math.max(area.x, Math.min(b.x, area.x + area.width - width));
  let y = b.y + b.height + 8;
  if (y + height > area.y + area.height) y = Math.max(area.y, area.y + area.height - height);
  win.setBounds({ x, y, width, height });
}

// `prime` runs once, right after the window's renderer has loaded and
// BEFORE the focus event: a window created after login missed every
// state/snapshot emission, so the caller replays the current agent
// state and the last WhatsApp snapshot into it — without that it sits
// on its blank store and reports "Not logged in" (the v5.24 bug the
// pause-toggle accidentally proved: a status change re-emitted the
// state and the window woke up).
export function openWhatsAppChat(
  getBar: () => BrowserWindow | null,
  ticketId: number,
  prime?: (win: BrowserWindow) => void,
): void {
  pendingTicketId = ticketId > 0 ? ticketId : null;
  const existing = getWhatsAppWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (pendingTicketId != null) {
      existing.webContents.send(IPC.AGENT_WHATSAPP_FOCUS, { ticketId: pendingTicketId });
    }
    return;
  }

  const win = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    minWidth: 680,
    minHeight: 440,
    show: false,
    frame: false,
    transparent: false,
    title: 'WhatsApp — Nero',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // same as the bar window: preload needs node access; context isolation still on
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  chatWindow = win;
  positionBelowBar(win, getBar());

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (chatWindow === win) chatWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    if (prime) prime(win);
    if (pendingTicketId != null) {
      win.webContents.send(IPC.AGENT_WHATSAPP_FOCUS, { ticketId: pendingTicketId });
    }
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?wa=chat`);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { wa: 'chat' } });
  }
  mainLog('info', 'whatsapp-window', `chat window opened for ticket ${ticketId}`);
}

export function closeWhatsAppChat(): void {
  const win = getWhatsAppWindow();
  if (win) win.close();
}
