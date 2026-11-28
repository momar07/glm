import { ipcMain, Notification, app, dialog, BrowserWindow } from 'electron';
import { IPC, type AgentWhatsAppEvent, type AppSettings, type LogEntry, type NotifyOptions } from '../shared/types';
import type { AgentLoginRequest } from '../shared/types';
import { settingsStore } from './store';
import { fileLogger, mainLog } from './logger';
import { AgentService } from './agent';
import { closeWhatsAppChat, getWhatsAppWindow, openWhatsAppChat } from './whatsappWindow';
import { registerSipIpc, shutdownSip } from './sipBridge';

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
function isLoginRequest(v: unknown): v is AgentLoginRequest {
  return (
    isObject(v) &&
    typeof v.apiUrl === 'string' &&
    typeof v.username === 'string' &&
    typeof v.password === 'string' &&
    (v.crmBaseUrl === undefined || typeof v.crmBaseUrl === 'string')
  );
}

let agent: AgentService | null = null;

export function shutdownAgent(): void {
  agent?.dispose();
  agent = null;
}

export function shutdownSipEngine(): void {
  shutdownSip();
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

  // The renderer measures its own content and asks for the window to hug it
  // (bar-only height when idle, taller with a drawer open). Anchor the top
  // edge: keep x/y, change only the size.
  ipcMain.handle(IPC.WIN_SET_SIZE, (_e, size: unknown) => {
    if (!isObject(size) || typeof size.height !== 'number') throw new Error('invalid size');
    const w = getMainWindow();
    if (!w) return;
    const height = Math.round(Math.min(1400, Math.max(56, size.height)));
    const cur = w.getBounds();
    const width =
      typeof size.width === 'number'
        ? Math.round(Math.min(900, Math.max(360, size.width)))
        : cur.width;
    if (width === cur.width && height === cur.height) return;
    w.setBounds({ x: cur.x, y: cur.y, width, height });
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

  // Agent state and WhatsApp snapshots go to BOTH windows: the bar
  // renders the badge/drawer, the chat window (when open) renders the
  // same list and refreshes its open thread. Thread/status results are
  // chat-window traffic; reply results go to both, since a reply can
  // be sent from either surface.
  const sendAll = (channel: string, payload: unknown): void => {
    getMainWindow()?.webContents.send(channel, payload);
    getWhatsAppWindow()?.webContents.send(channel, payload);
  };
  // The last WhatsApp snapshot, cached so a chat window created after
  // login can be primed with it (see whatsappWindow.openWhatsAppChat).
  let lastWhatsApp: AgentWhatsAppEvent | null = null;
  agent = new AgentService(
    (s) => sendAll(IPC.AGENT_STATE, s),
    (p) => getMainWindow()?.webContents.send(IPC.AGENT_POP, p),
    (u) => {
      lastWhatsApp = u;
      sendAll(IPC.AGENT_WHATSAPP, u);
    },
    (r) => sendAll(IPC.AGENT_WHATSAPP_RESULT, r),
    (r) => getWhatsAppWindow()?.webContents.send(IPC.AGENT_WHATSAPP_THREAD_RESULT, r),
    (r) => getWhatsAppWindow()?.webContents.send(IPC.AGENT_WHATSAPP_STATUS_RESULT, r),
    (r) => getWhatsAppWindow()?.webContents.send(IPC.AGENT_WHATSAPP_MEDIA_RESULT, r),
    (r) => getWhatsAppWindow()?.webContents.send(IPC.AGENT_WHATSAPP_TRANSFER_OPTIONS_RESULT, r),
    (r) => getWhatsAppWindow()?.webContents.send(IPC.AGENT_WHATSAPP_TRANSFER_RESULT, r),
  );
  const svc = agent;

  ipcMain.handle(IPC.AGENT_LOGIN, (_e, req: unknown) => {
    if (!isLoginRequest(req)) throw new Error('invalid login request');
    return svc.login(req);
  });
  ipcMain.handle(IPC.AGENT_LOGOUT, () => {
    lastWhatsApp = null;
    closeWhatsAppChat();
    return svc.logout();
  });
  ipcMain.handle(IPC.AGENT_STATUS, (_e, status: unknown, reason: unknown) => {
    if (status !== 'available' && status !== 'pause') throw new Error('invalid agent status');
    svc.setStatus(status, typeof reason === 'string' ? reason : '');
  });
  ipcMain.handle(IPC.AGENT_OPEN_WHATSAPP, (_e, url: unknown) => {
    if (typeof url !== 'string') throw new Error('invalid url');
    return svc.openWhatsApp(url);
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_REPLY, (_e, ticketId: unknown, text: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    if (typeof text !== 'string' || !text.trim()) throw new Error('invalid reply text');
    svc.whatsAppReply(ticketId, text);
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_THREAD, (_e, ticketId: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    svc.whatsAppThread(ticketId);
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_STATUS, (_e, ticketId: unknown, status: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    if (status !== 'open' && status !== 'pending' && status !== 'closed') throw new Error('invalid status');
    svc.whatsAppStatus(ticketId, status);
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_MEDIA, (_e, ticketId: unknown, file: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    const f = file as { filename?: unknown; mime?: unknown; caption?: unknown; dataBase64?: unknown } | null;
    if (!f || typeof f.dataBase64 !== 'string' || !f.dataBase64) throw new Error('invalid media file');
    // The service enforces the real cap (Settings, D6); this is only a
    // sanity bound so a corrupt renderer cannot flood the socket —
    // ~40 MB of base64 ≈ a 30 MB file.
    if (f.dataBase64.length > 40 * 1024 * 1024) throw new Error('file too large');
    svc.whatsAppMedia(ticketId, {
      filename: typeof f.filename === 'string' && f.filename ? f.filename.slice(0, 200) : 'file',
      mime: typeof f.mime === 'string' && f.mime ? f.mime.slice(0, 120) : 'application/octet-stream',
      caption: typeof f.caption === 'string' ? f.caption.slice(0, 1000) : '',
      dataBase64: f.dataBase64,
    });
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_TRANSFER_OPTIONS, (_e, ticketId: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    svc.whatsAppTransferOptions(ticketId);
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_TRANSFER, (_e, ticketId: unknown, target: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    const t = target as { agentId?: unknown; teamId?: unknown } | null;
    const agentId = t && typeof t.agentId === 'number' && Number.isFinite(t.agentId) ? t.agentId : undefined;
    const teamId = t && typeof t.teamId === 'number' && Number.isFinite(t.teamId) ? t.teamId : undefined;
    if ((agentId == null) === (teamId == null)) throw new Error('invalid transfer target');
    svc.whatsAppTransfer(ticketId, { agentId, teamId });
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_OPEN_CHAT, (_e, ticketId: unknown) => {
    if (typeof ticketId !== 'number' || !Number.isFinite(ticketId)) throw new Error('invalid ticket');
    // ticketId 0 = just open the window (the bar's WhatsApp button);
    // the window then auto-selects the most recent conversation.
    openWhatsAppChat(getMainWindow, ticketId, (win) => {
      win.webContents.send(IPC.AGENT_STATE, svc.snapshot());
      if (lastWhatsApp) win.webContents.send(IPC.AGENT_WHATSAPP, lastWhatsApp);
    });
  });
  // The chat window's own frame buttons act on the sender's window —
  // never on the bar (APP_MINIMIZE targets the bar by design).
  ipcMain.handle(IPC.AGENT_WHATSAPP_CLOSE_CHAT, (e) => {
    const w = getWhatsAppWindow();
    if (w && e.sender === w.webContents) w.close();
  });
  ipcMain.handle(IPC.AGENT_WHATSAPP_MIN_CHAT, (e) => {
    const w = getWhatsAppWindow();
    if (w && e.sender === w.webContents) w.minimize();
  });
  ipcMain.handle(IPC.AGENT_OPEN_RECORD, (_e, phone: unknown, uid: unknown, baseUrl: unknown) => {
    if (typeof phone !== 'string') throw new Error('invalid phone');
    return svc.openRecord(phone, typeof uid === 'string' ? uid : '', typeof baseUrl === 'string' ? baseUrl : undefined);
  });

  registerSipIpc(getMainWindow);

  ipcMain.handle(IPC.TLS_TRUST_HOST, (_e, host: unknown, trust: unknown) => {
    if (typeof host !== 'string' || !host.trim()) throw new Error('invalid host');
    const h = host.trim().toLowerCase();
    const cur = settingsStore.get().security?.trustedHosts ?? [];
    const next = trust ? [...new Set([...cur, h])] : cur.filter((x) => x !== h);
    settingsStore.set({ security: { trustedHosts: next } });
    mainLog('info', 'ipc', `TLS trust for ${h}: ${Boolean(trust)}`);
  });

  mainLog('info', 'ipc', 'handlers registered');
}
