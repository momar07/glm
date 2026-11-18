import { create } from 'zustand';
import type { Contact } from '@shared/types';
import { genId } from '@shared/constants';

const KEY = 'glmwebrtc:contacts';

function load(): Contact[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
}
function save(c: Contact[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c.slice(0, 2000)));
  } catch {
    /* quota */
  }
}

const PALETTE = ['#2f7fff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];

interface ContactState {
  contacts: Contact[];
  add: (c: Omit<Contact, 'id' | 'avatarColor'>) => Contact;
  update: (id: string, patch: Partial<Contact>) => void;
  remove: (id: string) => void;
  importCsv: (text: string) => number;
  exportCsv: () => string;
  search: (q: string) => Contact[];
}

export const useContacts = create<ContactState>((set, get) => ({
  contacts: load(),
  add(c) {
    const contact: Contact = {
      ...c,
      id: genId('ct'),
      avatarColor: PALETTE[get().contacts.length % PALETTE.length],
    };
    const next = [contact, ...get().contacts];
    set({ contacts: next });
    save(next);
    return contact;
  },
  update(id, patch) {
    const next = get().contacts.map((c) => (c.id === id ? { ...c, ...patch } : c));
    set({ contacts: next });
    save(next);
  },
  remove(id) {
    const next = get().contacts.filter((c) => c.id !== id);
    set({ contacts: next });
    save(next);
  },
  importCsv(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    let count = 0;
    for (const line of lines.slice(1)) {
      const [name, number, group] = parseCsvLine(line);
      if (!number) continue;
      get().add({ name: name || number, number, group });
      count++;
    }
    return count;
  },
  exportCsv() {
    const rows = ['name,number,group,favorite,speedDial'];
    for (const c of get().contacts) {
      rows.push(
        [csv(c.name), csv(c.number), csv(c.group || ''), c.favorite ? '1' : '0', csv(c.speedDialKey || '')].join(','),
      );
    }
    return rows.join('\n');
  },
  search(q) {
    const s = q.trim().toLowerCase();
    if (!s) return get().contacts;
    return get().contacts.filter(
      (c) => c.name.toLowerCase().includes(s) || c.number.includes(s) || (c.group || '').toLowerCase().includes(s),
    );
  },
}));

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
