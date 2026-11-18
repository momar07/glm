import React from 'react';

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'ok';
  size?: 'sm' | 'md' | 'lg';
}): React.ReactElement {
  const variants: Record<string, string> = {
    default: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700',
    primary: 'bg-brand-600 hover:bg-brand-500 text-white border border-brand-500',
    danger: 'bg-danger-600 hover:bg-danger-500 text-white border border-danger-500',
    ok: 'bg-ok-600 hover:bg-ok-500 text-white border border-ok-500',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-300 border border-transparent',
  };
  const sizes: Record<string, string> = {
    sm: 'px-2.5 py-1.5 text-xs rounded-md',
    md: 'px-3.5 py-2 text-sm rounded-lg',
    lg: 'px-5 py-3 text-base rounded-xl',
  };
  return (
    <button
      {...rest}
      className={`font-medium transition-colors active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  const { className = '', ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 ${className}`}
    />
  );
}

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }): React.ReactElement {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
      {children}
    </label>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return <div className={`bg-slate-900/60 border border-slate-800 rounded-2xl ${className}`}>{children}</div>;
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}): React.ReactElement {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-slate-700'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </button>
      {label && <span className="text-sm text-slate-300">{label}</span>}
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-500 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PresenceDot({ presence }: { presence: import('@shared/types').Presence }): React.ReactElement {
  const map: Record<string, string> = {
    online: 'bg-ok-500',
    registering: 'bg-warn-500 animate-pulse',
    'on-call': 'bg-danger-500',
    offline: 'bg-slate-600',
    'connection-lost': 'bg-danger-500 animate-pulse',
    busy: 'bg-danger-500',
  };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${map[presence] ?? 'bg-slate-600'}`} />;
}
