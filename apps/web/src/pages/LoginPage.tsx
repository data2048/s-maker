import type { MeResponse } from '@s-maker/shared';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage, safeNext } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field } from '../components/Form';

export function LoginPage() {
  const { user, loading, signedIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to={next} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signedIn(await api<MeResponse>('POST', '/api/auth/login', { username, password }));
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="card narrow" onSubmit={onSubmit}>
        <h1 className="logo">s-maker</h1>
        <Field
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <p className="muted small">No account? Ask the admin for an invite link.</p>
      </form>
    </div>
  );
}
