import { create } from 'zustand';
import type { AppSettings, SipProfile } from '@shared/types';
import { DEFAULT_SETTINGS, genId } from '@shared/constants';
import { logger } from '../lib/logger';
import { sipEngine } from '../sip/SipEngine';

interface SettingsState {
  loaded: boolean;
  settings: AppSettings;
  load: () => Promise<void>;
  patch: (p: Partial<AppSettings>) => Promise<void>;
  upsertProfile: (p: Partial<SipProfile> & { label?: string }) => SipProfile;
  removeProfile: (id: string) => Promise<void>;
  setActiveProfile: (id: string | null) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  settings: DEFAULT_SETTINGS,

  async load() {
    try {
      const s = await window.api.getSettings();
      set({ settings: s, loaded: true });
    } catch (e) {
      logger.error('settings', 'load failed', e);
      set({ loaded: true });
    }
  },

  async patch(p) {
    const next = await window.api.setSettings(p);
    set({ settings: next });
    // Push to the live engine so codec/opus/audio edits apply on the next
    // call instead of silently waiting for a logout/login.
    sipEngine.updateSettings(next);
  },

  upsertProfile(p) {
    const { settings, patch } = get();
    let profile: SipProfile;
    if (p.id && settings.profiles.some((x) => x.id === p.id)) {
      profile = { ...(settings.profiles.find((x) => x.id === p.id) as SipProfile), ...p } as SipProfile;
      void patch({ profiles: settings.profiles.map((x) => (x.id === profile.id ? profile : x)) });
    } else {
      profile = {
        id: genId('prof'),
        label: p.label || p.username || 'Profile',
        displayName: p.displayName ?? '',
        username: p.username ?? '',
        password: p.password ?? '',
        sipDomain: p.sipDomain ?? '',
        wsUrl: p.wsUrl ?? '',
        autoWsUrl: p.autoWsUrl,
        wsPort: p.wsPort,
        iceServers: p.iceServers,
        preferredCodec: p.preferredCodec,
        dialPrefix: p.dialPrefix,
        autoAnswer: p.autoAnswer,
        dnd: p.dnd,
      };
      void patch({ profiles: [...settings.profiles, profile] });
    }
    return profile;
  },

  async removeProfile(id) {
    const { settings, patch } = get();
    void patch({
      profiles: settings.profiles.filter((x) => x.id !== id),
      activeProfileId: settings.activeProfileId === id ? null : settings.activeProfileId,
    });
  },

  async setActiveProfile(id) {
    await get().patch({ activeProfileId: id });
  },
}));
