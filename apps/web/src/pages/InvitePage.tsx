import { PASSWORD_MIN, type InviteInfoResponse, type MeResponse } from '@s-maker/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field } from '../components/Form';

export function InvitePage() {
  const { token = '' } = useParams();
  const { signedIn } = useAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InviteInfoResponse | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InviteInfoResponse>('GET', `/api/invites/${encodeURIComponent(token)}`)
      .then((i) => {
        setInfo(i);
        if (i.username) {
          setUsername(i.username);
          setDisplayName(i.username);
        }
      })
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeResponse>('POST', `/api/invites/${encodeURIComponent(token)}/accept`, {
        username,
        displayName,
        password,
      });
      signedIn(me);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="centered muted">Checking invite…</div>;
  if (!info.valid) {
    return (
      <div className="centered">
        <div className="card narrow">
          <h2>Invite not valid</h2>
          <p className="muted">
            This link was already used, revoked or has expired. Ask the admin for a new one.
          </p>
          <Link to="/login">Go to login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="centered">
      <form className="card narrow" onSubmit={onSubmit}>
        <h1 className="logo">s-maker</h1>
        <p className="muted">
          {info.role === 'admin' ? 'Create the admin account.' : 'You were invited. Create your account.'}
        </p>
        <Field
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          readOnly={Boolean(info.username)}
          autoComplete="username"
          pattern="[A-Za-z0-9_.\-]{3,32}"
          hint="3–32 characters: letters, digits, . - _"
          required
        />
        <Field
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={48}
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          hint={`At least ${PASSWORD_MIN} characters. A few random words work well.`}
          required
        />
        <Field
          label="Repeat password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
