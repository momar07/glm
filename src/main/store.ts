import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { AppSettings } from '../shared/types';

// ponytail: aes-256-cbc via electron-store encryptionKey. Upgrade to OS keyring (keytar/safeStorage) per-profile if needed.
// Electron safeStorage is available on the main side; we layer it later if disk-attack threat model rises.
const ENCRYPTION_KEY = 'glmwebrtc-v1-store-key-rotate-me';

export interface StoreSchema {
  settings: AppSettings;
}

class SettingsStore {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'glmwebrtc-settings',
      encryptionKey: ENCRYPTION_KEY,
      defaults: { settings: DEFAULT_SETTINGS },
      clearInvalidConfig: true,
    });
  }

  get(): AppSettings {
    const s = this.store.get('settings', DEFAULT_SETTINGS) as Partial<AppSettings>;
    // Fill group defaults so older stored blobs (missing new groups) never crash the UI.
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      audio: { ...DEFAULT_SETTINGS.audio, ...s.audio },
      ui: { ...DEFAULT_SETTINGS.ui, ...s.ui },
      security: { ...DEFAULT_SETTINGS.security, ...s.security },
      log: { ...DEFAULT_SETTINGS.log, ...s.log },
      transport: { ...DEFAULT_SETTINGS.transport, ...s.transport },
      history: { ...DEFAULT_SETTINGS.history, ...s.history },
    };
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const next: AppSettings = { ...current, ...patch };
    this.store.set('settings', next);
    return next;
  }

  get path(): string {
    return this.store.path;
  }
}

export const settingsStore = new SettingsStore();

export function getLogDir(): string {
  return join(app.getPath('userData'), 'logs');
}
