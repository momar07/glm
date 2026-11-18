import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useContacts } from '../store/contacts';
import { useCall } from '../store/call';
import { useSip } from '../store/sip';
import { isNative, isNativeShell } from '../lib/platform';
import { ensurePhoneContacts, type DeviceContact } from '../lib/device';
import { Button, Card, Input } from './ui';
import type { Contact } from '@shared/types';

export function Contacts(): React.ReactElement {
  const { contacts, add, remove, importCsv, exportCsv, search } = useContacts();
  const makeCall = useCall((s) => s.makeCall);
  const online = useSip((s) => s.presence) === 'online';
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<Omit<Contact, 'id' | 'avatarColor'>>({ name: '', number: '', group: '', favorite: false });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const [phone, setPhone] = useState<DeviceContact[] | null>(null);
  const [phoneLoading, setPhoneLoading] = useState(false);

  const list = q ? search(q) : contacts;

  const loadPhone = async (): Promise<void> => {
    setPhoneLoading(true);
    try {
      setPhone(await ensurePhoneContacts());
    } catch (e: any) {
      alert(e?.message ?? e);
    } finally {
      setPhoneLoading(false);
    }
  };

  const phoneList = (() => {
    if (!phone) return null;
    const s = q.trim().toLowerCase();
    if (!s) return phone;
    return phone.filter((c) => c.name.toLowerCase().includes(s) || c.number.includes(s));
  })();

  const importAllPhone = (): void => {
    if (!phone) return;
    const digits = (s: string): string => s.replace(/\D/g, '');
    const have = new Set(contacts.map((c) => digits(c.number)));
    let n = 0;
    for (const p of phone) {
      const d = digits(p.number);
      if (!d || have.has(d)) continue;
      add({ name: p.name, number: p.number });
      have.add(d);
      n++;
    }
    alert(`Imported ${n} contacts`);
  };

  const dial = (num: string): void => {
    navigate('/');
    void makeCall(num).catch((e: any) => alert(`Call failed: ${e?.message ?? e}`));
  };

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = (): void => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} contact${selected.size > 1 ? 's' : ''}?`)) return;
    selected.forEach((id) => remove(id));
    setSelected(new Set());
    setSelecting(false);
  };

  const importText = (text: string): void => {
    try {
      const n = importCsv(text);
      alert(`Imported ${n} contacts`);
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  };

  const onPickFile = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    try {
      importText(await f.text());
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  };

  const doImport = async (): Promise<void> => {
    // No native file dialog on web — use a hidden file input instead.
    if (!isNativeShell) {
      fileRef.current?.click();
      return;
    }
    const path = await window.api.openCsv();
    if (!path) return;
    try {
      const res = await fetch(`file://${path}`);
      const text = await res.text();
      importText(text);
    } catch (e) {
      alert(`Import failed: ${e}`);
    }
  };

  const downloadCsv = (): void => {
    // ponytail: file write via renderer fetch not allowed; reuse a blob download instead.
    const blob = new Blob([exportCsv()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'glmwebrtc-contacts.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExport = async (): Promise<void> => {
    if (!isNativeShell) {
      downloadCsv();
      return;
    }
    const path = await window.api.saveCsv('glmwebrtc-contacts.csv');
    if (!path) return;
    downloadCsv();
  };

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      <div className="flex gap-2 flex-wrap">
        <Input placeholder="Search name, number, group…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant="ghost" onClick={() => setShowAdd((v) => !v)}>+ New</Button>
        <Button size="sm" variant="ghost" onClick={doImport}>Import</Button>
        <Button size="sm" variant="ghost" onClick={doExport}>Export</Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSelecting((v) => !v);
            setSelected(new Set());
          }}
        >
          {selecting ? 'Done' : 'Select'}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            void onPickFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {showAdd && (
        <Card className="p-3 grid grid-cols-2 gap-2">
          <Input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input placeholder="Number / extension" value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} />
          <Input placeholder="Group (optional)" value={draft.group || ''} onChange={(e) => setDraft({ ...draft, group: e.target.value })} />
          <Button
            size="sm"
            variant="primary"
            disabled={!draft.name || !draft.number}
            onClick={() => {
              add(draft);
              setDraft({ name: '', number: '', group: '', favorite: false });
              setShowAdd(false);
            }}
          >
            Save contact
          </Button>
        </Card>
      )}

      {selecting && (
        <div className="flex items-center gap-2 shrink-0 text-xs">
          <button
            className="text-brand-400 hover:text-brand-300"
            onClick={() => setSelected(new Set(list.map((c) => c.id)))}
          >
            Select all ({list.length})
          </button>
          <button
            className="text-slate-500 hover:text-slate-300"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
          <span className="ml-auto text-slate-500">{selected.size} selected</span>
          <Button size="sm" variant="danger" disabled={selected.size === 0} onClick={deleteSelected}>
            Delete
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-auto space-y-1">
        {list.length === 0 && <div className="text-center text-slate-500 mt-10 text-sm">No contacts yet</div>}
        {list.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-800 group">
            {selecting && (
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggleSelect(c.id)}
                className="h-4 w-4 shrink-0 accent-brand-600"
              />
            )}
            <div
              className="h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold text-white"
              style={{ background: c.avatarColor }}
            >
              {c.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-slate-200 truncate flex items-center gap-1.5">
                {c.favorite && <span className="text-warn-500">★</span>}
                {c.name}
                {c.group && <span className="text-xs text-slate-600">· {c.group}</span>}
              </div>
              <div className="text-xs text-slate-500 font-mono">{c.number}</div>
            </div>
            <button
              disabled={!online}
              className="opacity-0 group-hover:opacity-100 text-brand-400 hover:text-brand-300 text-sm px-2 transition disabled:opacity-30"
              onClick={() => {
                navigate('/');
                void makeCall(c.number).catch((e: any) => alert(`Call failed: ${e?.message ?? e}`));
              }}
            >
              Call
            </button>
            <button
              className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-danger-500 text-xs px-2 transition"
              onClick={() => remove(c.id)}
            >
              ✕
            </button>
          </div>
        ))}
        {isNative() && (
          <div className="pt-3">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                On this phone{phoneList ? ` (${phoneList.length})` : ''}
              </span>
              {phoneList ? (
                <button
                  className="text-xs text-brand-400 hover:text-brand-300"
                  onClick={importAllPhone}
                >
                  Import all
                </button>
              ) : (
                <button
                  className="text-xs text-brand-400 hover:text-brand-300 disabled:opacity-40"
                  disabled={phoneLoading}
                  onClick={() => void loadPhone()}
                >
                  {phoneLoading ? 'Loading…' : 'Load'}
                </button>
              )}
            </div>
            {phoneList?.map((p, i) => (
              <div key={`${p.number}-${i}`} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-800 group">
                <div className="h-9 w-9 rounded-full bg-slate-700 flex items-center justify-center text-sm font-semibold text-white">
                  {p.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-200 truncate">{p.name}</div>
                  <div className="text-xs text-slate-500 font-mono">{p.number}</div>
                </div>
                <button
                  disabled={!online}
                  className="opacity-0 group-hover:opacity-100 text-brand-400 hover:text-brand-300 text-sm px-2 transition disabled:opacity-30"
                  onClick={() => dial(p.number)}
                >
                  Call
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
