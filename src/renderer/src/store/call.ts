import { create } from 'zustand';
import type { CallRecord } from '@shared/types';
import { historyTs } from '@shared/constants';
import { sipEngine, type CallSession } from '../sip/engine';
import { logger } from '../lib/logger';
import { useSettings } from './settings';
import { setNormalAudio } from '../lib/audioRoute';
import { ensureMic, proximityOff } from '../lib/system';

interface CallState {
  calls: CallSession[];
  currentId: string | null;
  current: () => CallSession | undefined;
  makeCall: (target: string) => Promise<string>;
  answer: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  hangup: (id?: string) => Promise<void>;
  hold: (id?: string) => Promise<void>;
  resume: (id?: string) => Promise<void>;
  toggleMute: (id?: string) => void;
  sendDtmf: (id: string | undefined, digit: string) => Promise<void>;
  blindTransfer: (id: string | undefined, target: string) => Promise<void>;
  clearEnded: () => void;
  // history
  history: CallRecord[];
  pushHistory: (r: CallRecord) => void;
  clearHistory: () => void;
}

let bound = false;
function bind(set: (p: Partial<CallState>) => void, get: () => CallState): void {
  if (bound) return;
  bound = true;
  const upd = (c: CallSession) => {
    const calls = get().calls.map((x) => (x.id === c.id ? { ...c } : x));
    set({ calls, currentId: c.id });
  };
  sipEngine.on('incoming', (c) => {
    set({ calls: [...get().calls.filter((x) => x.id !== c.id), { ...c }], currentId: c.id });
  });
  sipEngine.on('outgoing', (c) => {
    set({ calls: [...get().calls.filter((x) => x.id !== c.id), { ...c }], currentId: c.id });
  });
  sipEngine.on('callUpdate', upd);
  sipEngine.on('callEnded', (c, _reason) => {
    const calls = get().calls.map((x) => (x.id === c.id ? { ...c } : x));
    set({ calls });
    setNormalAudio(); // restore idle routing no matter where the end came from
    void proximityOff(); // release the ear-sensor lock on every end path
    // history record
    const rec: CallRecord = {
      id: c.id,
      profileId: 'active',
      remote: c.remote,
      displayName: c.displayName,
      direction: c.direction,
      status: c.status === 'failed' ? 'failed' : 'ended',
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      durationSec: c.connectedAt ? Math.round(((c.endedAt ?? Date.now()) - c.connectedAt) / 1000) : 0,
      reason: c.reason,
    };
    get().pushHistory(rec);
  });
}

const HISTORY_KEY = 'glmwebrtc:history';

function retentionMs(): number {
  try {
    const days = useSettings.getState().settings.history?.retentionDays ?? 1;
    return days <= 0 ? Infinity : days * 86400000;
  } catch {
    return 86400000; // settings not loaded yet — default daily
  }
}

// Drop records older than the retention window. Unparseable timestamps count as oldest.
function prune(h: CallRecord[]): CallRecord[] {
  const ms = retentionMs();
  if (!Number.isFinite(ms)) return h;
  const now = Date.now();
  return h.filter((r) => now - historyTs(r.startedAt) <= ms);
}

function loadHistory(): CallRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as CallRecord[]) : [];
    const pruned = prune(parsed);
    if (pruned.length !== parsed.length) saveHistory(pruned);
    return pruned;
  } catch {
    return [];
  }
}
function saveHistory(h: CallRecord[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 500)));
  } catch {
    /* quota */
  }
}

export const useCall = create<CallState>((set, get) => {
  // Bind once at store creation — NOT inside makeCall. Previously the engine
  // listeners attached only after the first OUTGOING call, so an incoming call
  // arriving first was held by the engine with nobody listening: no overlay,
  // no ringtone, no notification, while Asterisk kept ringing (BUGS.md #005).
  bind(set, get);
  return {
  calls: [],
  currentId: null,
  current: () => {
    const { calls, currentId } = get();
    return calls.find((c) => c.id === currentId);
  },

  async makeCall(target) {
    await ensureMic(); // system mic dialog before getUserMedia, not after a failed invite
    const id = await sipEngine.makeCall(target);
    set({ currentId: id });
    return id;
  },
  async answer(id) {
    await ensureMic();
    await sipEngine.answer(id);
  },
  async reject(id) {
    await sipEngine.reject(id);
  },
  async hangup(id) {
    const target = id ?? get().currentId;
    if (target) await sipEngine.hangup(target);
  },
  async hold(id) {
    const target = id ?? get().currentId;
    if (target) await sipEngine.hold(target);
  },
  async resume(id) {
    const target = id ?? get().currentId;
    if (target) await sipEngine.resume(target);
  },
  toggleMute(id) {
    const target = id ?? get().currentId;
    if (!target) return;
    const c = get().calls.find((x) => x.id === target);
    if (!c) return;
    sipEngine.setMute(target, !c.muted);
  },
  async sendDtmf(id, digit) {
    const target = id ?? get().currentId;
    if (target) await sipEngine.sendDtmf(target, digit);
  },
  async blindTransfer(id, target) {
    const t = id ?? get().currentId;
    if (t) await sipEngine.blindTransfer(t, target);
  },
  clearEnded() {
    set({ calls: get().calls.filter((c) => c.status !== 'ended' && c.status !== 'failed') });
  },

  history: loadHistory(),
  pushHistory(r) {
    // A call ending after the window moved on starts from pruned state.
    const h = [r, ...prune(get().history)].slice(0, 500);
    set({ history: h });
    saveHistory(h);
    logger.info('history', `recorded ${r.direction} ${r.status} to ${r.remote}`);
  },
  clearHistory() {
    set({ history: [] });
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
    logger.info('history', 'cleared by user');
  },
  };
});

// Re-apply retention if time passes while the app is running.
setInterval(() => {
  const { history } = useCall.getState();
  if (history.length === 0) return;
  const pruned = prune(history);
  if (pruned.length !== history.length) {
    useCall.setState({ history: pruned });
    saveHistory(pruned);
    logger.info('history', 'retention expiry — old records cleared');
  }
}, 60_000);
