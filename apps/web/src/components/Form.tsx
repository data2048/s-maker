import type { InputHTMLAttributes, ReactNode } from 'react';

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="input" {...input} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {error}
    </div>
  );
}

export function SuccessBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="alert ok" role="status">
      {message}
    </div>
  );
}
