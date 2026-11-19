import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type MainApi } from '../shared/types';

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, v: T): void => cb(v);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: MainApi = {
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  writeLog: (entry) => ipcRenderer.invoke(IPC.LOG_WRITE, entry),
  exportLog: () => ipcRenderer.invoke(IPC.LOG_EXPORT),
  notify: (opts) => ipcRenderer.invoke(IPC.NOTIFY, opts),
  quit: () => ipcRenderer.invoke(IPC.APP_QUIT),
  minimize: () => ipcRenderer.invoke(IPC.APP_MINIMIZE),
  setWindowSize: (size) => ipcRenderer.invoke(IPC.WIN_SET_SIZE, size),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke(IPC.APP_LAUNCH_AT_STARTUP, enabled),
  openCsv: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_CSV),
  saveCsv: (defaultName) => ipcRenderer.invoke(IPC.DIALOG_SAVE_CSV, defaultName),
  agentLogin: (req) => ipcRenderer.invoke(IPC.AGENT_LOGIN, req),
  agentLogout: () => ipcRenderer.invoke(IPC.AGENT_LOGOUT),
  agentSetStatus: (status, reason) => ipcRenderer.invoke(IPC.AGENT_STATUS, status, reason),
  agentOpenRecord: (phone, uid, baseUrl) =>
    ipcRenderer.invoke(IPC.AGENT_OPEN_RECORD, phone, uid, baseUrl),
  onAgentState: (cb) => subscribe(IPC.AGENT_STATE, cb),
  onAgentPop: (cb) => subscribe(IPC.AGENT_POP, cb),
  setTrustedHost: (host, trust) => ipcRenderer.invoke(IPC.TLS_TRUST_HOST, host, trust),
  sipAvailable: () => ipcRenderer.invoke(IPC.SIP_AVAILABLE),
  sipCommand: (command) => ipcRenderer.invoke(IPC.SIP_COMMAND, command),
  onSipEvent: (cb) => subscribe(IPC.SIP_EVENT, cb),
};

contextBridge.exposeInMainWorld('api', api);
