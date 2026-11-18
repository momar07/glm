import React, { useEffect, useRef, useState } from 'react';
import { useCall } from '../store/call';
import { useSip } from '../store/sip';
import { audioManager } from '../audio/AudioManager';
import { isMobile } from '../lib/platform';
import { logger } from '../lib/logger';
import { safePhone } from '@shared/constants';

const KEYS: { d: string; sub: string }[] = [
  { d: '1', sub: '' },
  { d: '2', sub: 'ABC' },
  { d: '3', sub: 'DEF' },
  { d: '4', sub: 'GHI' },
  { d: '5', sub: 'JKL' },
  { d: '6', sub: 'MNO' },
  { d: '7', sub: 'PQRS' },
  { d: '8', sub: 'TUV' },
  { d: '9', sub: 'WXYZ' },
  { d: '*', sub: '' },
  { d: '0', sub: '+' },
  { d: '#', sub: '' },
];

export interface Dialer {
  value: string;
  setNumber: React.Dispatch<React.SetStateAction<string>>;
  press: (d: string) => void;
  backspace: () => void;
  clear: () => void;
  call: (target?: string) => void;
  pasteFromClipboard: () => void;
  trackSelect: (e: React.SyntheticEvent<HTMLInputElement>) => void;
  pasteMode: boolean;
  endPasteMode: () => void;
  online: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
}

// Shared dial state: keypad sheet and history-row tap-to-fill use the same one.
// Editing is caret-aware: keys/paste insert where the cursor sits, so a digit
// can be added in the middle of the number. The caret is tracked on every
// selection change (tap or arrow keys), not just on focus.
export function useDialer(): Dialer {
  const [value, setValue] = useState('');
  // Paste fallback: Android WebView denies clipboard.readText(), so the field
  // is briefly made editable for a native long-press paste (see below).
  const [pasteMode, setPasteMode] = useState(false);
  const endPasteMode = (): void => setPasteMode(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const makeCall = useCall((s) => s.makeCall);
  const presence = useSip((s) => s.presence);
  const online = presence === 'online';

  const trackSelect = (e: React.SyntheticEvent<HTMLInputElement>): void => {
    caretRef.current = e.currentTarget.selectionStart;
  };

  const restoreCaret = (pos: number): void => {
    const el = inputRef.current;
    requestAnimationFrame(() => {
      try {
        el?.setSelectionRange(pos, pos);
      } catch {
        /* ignore */
      }
      // Focusing on mobile would pop the soft keyboard — the pad is the keyboard.
      if (!isMobile()) el?.focus();
    });
  };

  const caret = (): number => caretRef.current ?? inputRef.current?.selectionStart ?? value.length;

  const press = (d: string): void => {
    audioManager.unlock();
    audioManager.playDtmf(d);
    const pos = Math.max(0, Math.min(caret(), value.length));
    caretRef.current = pos + 1;
    setValue(value.slice(0, pos) + d + value.slice(pos));
    restoreCaret(pos + 1);
  };

  const backspace = (): void => {
    const el = inputRef.current;
    const end = el?.selectionEnd ?? caret();
    const start = Math.min(caret(), end);
    let next: string;
    let pos: number;
    if (end > start) {
      next = value.slice(0, start) + value.slice(end);
      pos = start;
    } else if (start > 0) {
      next = value.slice(0, start - 1) + value.slice(start);
      pos = start - 1;
    } else {
      return;
    }
    caretRef.current = pos;
    setValue(next);
    restoreCaret(pos);
  };
  const clear = (): void => {
    caretRef.current = 0;
    setValue('');
  };

  const call = (target?: string): void => {
    const t = (target ?? value).trim();
    if (!t || !online) return;
    audioManager.unlock();
    // Surface dial failures (mic denied, not registered): previously silent.
    void makeCall(t)
      .then(() => setValue(''))
      .catch((e: any) => alert(`Call failed: ${e?.message ?? e}`));
  };

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      const clean = safePhone(text);
      if (!clean) return;
      const pos = Math.max(0, Math.min(caret(), value.length));
      caretRef.current = pos + clean.length;
      setValue(value.slice(0, pos) + clean + value.slice(pos));
      restoreCaret(pos + clean.length);
      return;
    } catch {
      /* clipboard API denied — fall through to native-assisted paste */
    }
    logger.warn('dialpad', 'clipboard read denied — field opened, long-press to paste');
    setPasteMode(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Keyboard shortcuts: 0-9*# type, Enter dials, Backspace deletes, Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        call();
        return;
      }
      if (e.key === 'Backspace') {
        backspace();
        return;
      }
      if (e.key === 'Escape') {
        clear();
        return;
      }
      if (/^[0-9*#]$/.test(e.key)) {
        press(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, online]);

  return { value, setNumber: setValue, press, backspace, clear, call, pasteFromClipboard, trackSelect, pasteMode, endPasteMode, online, inputRef };
}

// Floating bottom sheet: open keypad, or a minimized bar showing the number.
// Same palette as the page — no color changes.
export function KeypadSheet({
  dialer,
  expanded,
  onToggle,
}: {
  dialer: Dialer;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const { value, setNumber, press, backspace, clear, call, pasteFromClipboard, trackSelect, pasteMode, endPasteMode, online, inputRef } = dialer;

  const paste = async (e: React.ClipboardEvent): Promise<void> => {
    e.preventDefault();
    const clean = safePhone(e.clipboardData.getData('text'));
    if (!clean) return;
    const el = inputRef.current;
    const pos = Math.max(0, Math.min(el?.selectionStart ?? value.length, value.length));
    const end = Math.max(pos, el?.selectionEnd ?? pos);
    setNumber(value.slice(0, pos) + clean + value.slice(end));
  };

  // Long numbers shrink to fit instead of clipping at the edges.
  const displaySize =
    value.length > 14 ? 'text-xl' : value.length > 10 ? 'text-2xl' : 'text-3xl';

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-20 rounded-t-3xl bg-slate-900 border-t border-x border-slate-800 shadow-2xl transition-transform duration-300 ${
        expanded ? 'translate-y-0' : 'translate-y-[calc(100%-2.25rem)]'
      }`}
    >
      {/* Mini bar: grab handle only — tap toggles open/minimized. */}
      <button
        onClick={onToggle}
        aria-label={expanded ? 'Minimize keypad' : 'Open keypad'}
        className="h-[2.25rem] w-full flex items-center justify-center gap-2"
      >
        <span className="w-10 h-1 rounded-full bg-slate-700" />
        <span className={`text-slate-600 text-xs transition-transform ${expanded ? 'rotate-180' : ''}`}>⌃</span>
      </button>

      {/* Full pad: stays mounted, slides away when minimized. */}
      <div className="px-4 pb-3 flex flex-col items-center">
        <div className="w-full max-w-[15rem]">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setNumber(safePhone(e.target.value))}
            onPaste={paste}
            onSelect={trackSelect}
            onClick={trackSelect}
            onKeyUp={trackSelect}
            onBlur={endPasteMode}
            onContextMenu={
              // Desktop: replace the menu with a direct paste attempt.
              // Mobile: do NOT intercept — the native long-press menu fires a
              // real paste event, handled by onPaste above. Intercepting it
              // (plus a denied clipboard API) is what made paste dead-silent.
              isMobile()
                ? undefined
                : (e) => {
                    e.preventDefault();
                    void pasteFromClipboard();
                  }
            }
            // inputMode=none keeps the mobile soft keyboard closed (the pad types),
            // except in paste fallback mode where the native long-press menu is needed.
            // Desktop keeps a normal editable field + autofocus.
            inputMode={pasteMode || !isMobile() ? 'text' : 'none'}
            autoFocus={!isMobile()}
            placeholder={pasteMode ? 'Long-press to paste' : 'Enter number'}
            className={`w-full bg-transparent border-0 text-center font-light tracking-wide text-slate-100 placeholder-slate-600 placeholder:text-xl focus:outline-none focus:ring-0 ${displaySize}`}
          />
          <div className="flex justify-center gap-4 mt-0.5 text-[11px] text-slate-600">
            <button className="hover:text-slate-300" title="Paste copied number" onClick={() => void pasteFromClipboard()}>⧉ paste</button>
            {value && <button className="hover:text-slate-300" onClick={clear}>clear</button>}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-x-4 gap-y-2 w-full max-w-[15rem] mx-auto mt-1">
          {KEYS.map((k) => (
            <button
              key={k.d}
              onClick={() => press(k.d)}
              className="aspect-square w-full rounded-full bg-slate-800/80 hover:bg-slate-700 active:scale-95 transition-all flex flex-col items-center justify-center border border-slate-700/60"
            >
              <span className="text-2xl font-light text-slate-100 leading-none">{k.d}</span>
              {k.sub
                ? <span className="text-[8px] font-medium tracking-[0.2em] text-slate-500 mt-0.5">{k.sub}</span>
                : <span className="text-[8px] mt-0.5 select-none">&nbsp;</span>}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 items-center w-full max-w-[15rem] mx-auto mt-1">
          <button
            onClick={onToggle}
            aria-label="Minimize keypad"
            className="justify-self-start text-slate-500 hover:text-slate-300 active:scale-95 transition px-2"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              {Array.from({ length: 12 }).map((_, i) => (
                <circle key={i} cx={6 + (i % 3) * 6} cy={5 + Math.floor(i / 3) * 5} r={1.8} />
              ))}
            </svg>
          </button>
          <button
            disabled={!online || !value}
            onClick={() => call()}
            aria-label="Call"
            className="justify-self-center h-14 w-14 rounded-full bg-brand-500 hover:bg-brand-400 disabled:opacity-30 active:scale-95 transition-all flex items-center justify-center text-white shadow-lg shadow-brand-500/40"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
          </button>
          <button
            disabled={!value}
            onClick={backspace}
            aria-label="Backspace"
            className="justify-self-end text-slate-400 hover:text-slate-200 disabled:opacity-20 active:scale-95 transition text-2xl leading-none px-2"
          >
            ⌫
          </button>
        </div>
      </div>
    </div>
  );
}

// export so CallView can reuse for in-call DTMF
export function DtmfPad({ onKey }: { onKey: (d: string) => void }): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map((k) => (
        <button
          key={k.d}
          onClick={() => onKey(k.d)}
          className="aspect-square rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 transition flex flex-col items-center justify-center"
        >
          <span className="text-xl text-slate-100">{k.d}</span>
          {k.sub && <span className="text-[9px] tracking-widest text-slate-500">{k.sub}</span>}
        </button>
      ))}
    </div>
  );
}
