import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type MainApi } from '../shared/types';

const api: MainApi = {
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  writeLog: (entry) => ipcRenderer.invoke(IPC.LOG_WRITE, entry),
  exportLog: () => ipcRenderer.invoke(IPC.LOG_EXPORT),
  notify: (opts) => ipcRenderer.invoke(IPC.NOTIFY, opts),
  quit: () => ipcRenderer.invoke(IPC.APP_QUIT),
  minimize: () => ipcRenderer.invoke(IPC.APP_MINIMIZE),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke(IPC.APP_LAUNCH_AT_STARTUP, enabled),
  openCsv: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_CSV),
  saveCsv: (defaultName) => ipcRenderer.invoke(IPC.DIALOG_SAVE_CSV, defaultName),
};

contextBridge.exposeInMainWorld('api', api);
