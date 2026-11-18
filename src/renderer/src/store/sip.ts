import { create } from 'zustand';
import type { Presence, SipProfile, AppSettings } from '@shared/types';
import { sipEngine, type SipServiceState, type SoftphoneStatus } from '../sip/SipEngine';
import { logger } from '../lib/logger';
import { startCallService, stopCallService } from '../lib/system';
import { ensureNotifications } from '../lib/push';
import { audioManager } from '../audio/AudioManager';

interface SipState {
  presence: Presence;
  engineState: SipServiceState;
  transportConnected: boolean;
  lastError: string | null;
  connecting: boolean;
  connect: (profile: SipProfile, settings: AppSettings) => Promise<void>;
  disconnect: () => Promise<void>;
  setPresence: (p: Presence) => void;
}

function mapPresence(s: SoftphoneStatus): Presence {
  switch (s) {
    case 'offline':
      return 'offline';
    case 'registering':
      return 'registering';
    case 'registered':
      return 'online';
    case 'on-call':
      return 'on-call';
    case 'connection-lost':
      return 'connection-lost';
    default:
      return 'offline';
  }
}

let bound = false;
function bindEngine(set: (p: Partial<SipState>) => void): void {
  if (bound) return;
  bound = true;
  sipEngine.on('presence', (s) => {
    set({ presence: mapPresence(s) });
  });
  sipEngine.on('stateChange', (s) => {
    set({ engineState: s });
  });
  sipEngine.on('transport', (ok) => set({ transportConnected: ok }));
  sipEngine.on('registrationFailed', (reason) => {
    set({ lastError: reason });
    logger.error('sip', `registration failed: ${reason}`);
  });
  sipEngine.on('registered', () => {
    set({ lastError: null });
    // Keep the socket alive in background (native foreground service; no-op on web).
    void startCallService().catch(() => {});
    // Prompt for notification permission now, not mid-ring on first incoming.
    void ensureNotifications().catch(() => {});
    // Inaudible tone opts out of Chromium background timer throttling.
    audioManager.unlock();
    audioManager.startRetentionTone();
    // Pre-resolve mic constraints so answer/dial never pays setup cost.
    void sipEngine.warmupMedia().catch(() => {});
  });
  sipEngine.on('unregistered', () => {
    void stopCallService().catch(() => {});
    audioManager.stopRetentionTone();
  });
  sipEngine.on('log', (level, msg, data) => logger[level]('sip', msg, data));
}

export const useSip = create<SipState>((set) => ({
  presence: 'offline',
  engineState: 'disconnected',
  transportConnected: false,
  lastError: null,
  connecting: false,

  async connect(profile, settings) {
    bindEngine(set);

    // Already registered with the same profile — no-op (prevents duplicate UA)
    if (sipEngine.state === 'registered' && sipEngine.currentProfileId === profile.id) {
      logger.info('sip', `already registered with profile "${profile.label}" — ignoring connect()`);
      return;
    }

    // Switching profiles or retrying from failure — shutdown first if active
    if (sipEngine.state !== 'disconnected' && sipEngine.state !== 'registration-failed') {
      logger.info('sip', `shutting down current registration before reconnect (state=${sipEngine.state})`);
      await sipEngine.shutdown();
    }

    set({ connecting: true, lastError: null });
    try {
      await sipEngine.initialize(profile, settings);
    } catch (e: any) {
      set({ lastError: e?.message || 'connect failed' });
      logger.error('sip', `connect failed: ${e?.message}`);
      throw e;
    } finally {
      set({ connecting: false });
    }
  },

  async disconnect() {
    await sipEngine.shutdown();
    set({ presence: 'offline', transportConnected: false, connecting: false });
  },

  setPresence(p) {
    set({ presence: p });
  },
}));
