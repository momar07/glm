import React from 'react';

export type LoginMode = 'sip' | 'agent';

export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: LoginMode;
  onChange: (m: LoginMode) => void;
}): React.ReactElement {
  const cls = (m: LoginMode): string =>
    `flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
      mode === m ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'
    }`;
  return (
    <div className="flex gap-1 p-1 bg-slate-900 border border-slate-800 rounded-xl">
      <button type="button" className={cls('sip')} onClick={() => onChange('sip')}>
        SIP account
      </button>
      <button type="button" className={cls('agent')} onClick={() => onChange('agent')}>
        Call center agent
      </button>
    </div>
  );
}
