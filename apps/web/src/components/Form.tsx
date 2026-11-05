import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" aria-describedby={hint ? hintId : undefined} {...input} />
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
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
