import React, { useEffect, useState } from 'react';
import { useSip } from '../store/sip';
import { isNative } from '../lib/platform';
import { isIgnoringBattery, requestBatteryExemption } from '../lib/system';

const DISMISS_KEY = 'glmwebrtc:batteryPrompt';

// One-time banner: without the exemption, Android kills our socket in
// background and incoming calls never arrive. Shown once online on native.
export function BatteryPrompt(): React.ReactElement | null {
  const presence = useSip((s) => s.presence);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isNative()) return;
    if (presence !== 'online' && presence !== 'on-call') return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      return;
    }
    let cancelled = false;
    void isIgnoringBattery().then((ignoring) => {
      if (!cancelled && ignoring === false) setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [presence]);

  if (!visible) return null;

  const dismiss = (forever: boolean): void => {
    if (forever) {
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* ignore */
      }
    }
    setVisible(false);
  };

  return (
    <div className="mx-3 mt-2 shrink-0 rounded-xl border border-warn-600/50 bg-warn-600/10 px-3 py-2.5">
      <div className="text-xs text-slate-200 font-medium">Stay registered in background?</div>
      <div className="text-[11px] text-slate-400 mt-0.5">
        Android may kill the connection when minimized and you'll miss calls. Exempt GLMWebrtc
        from battery optimization.
      </div>
      <div className="flex gap-2 mt-2">
        <button
          className="text-xs px-2.5 py-1.5 rounded-md bg-brand-600 text-white"
          onClick={() => {
            void requestBatteryExemption();
            dismiss(true);
          }}
        >
          Open settings
        </button>
        <button
          className="text-xs px-2.5 py-1.5 rounded-md text-slate-300 hover:bg-slate-800"
          onClick={() => dismiss(false)}
        >
          Later
        </button>
        <button
          className="text-xs px-2.5 py-1.5 rounded-md text-slate-500 hover:text-slate-300"
          onClick={() => dismiss(true)}
        >
          Don't ask again
        </button>
      </div>
    </div>
  );
}
