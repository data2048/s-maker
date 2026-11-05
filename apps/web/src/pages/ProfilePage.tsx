import { PASSWORD_MIN, type UserDto } from '@s-maker/shared';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Field, SuccessBox } from '../components/Form';

export function ProfilePage() {
  const { user, setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileMsg(null);
    setProfileErr(null);
    try {
      const res = await api<{ user: UserDto }>('PATCH', '/api/me', { displayName });
      setUser(res.user);
      setProfileMsg('Saved');
    } catch (err) {
      setProfileErr(errorMessage(err));
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    setPwErr(null);
    if (next !== confirm) return setPwErr('Passwords do not match');
    try {
      await api('POST', '/api/me/password', { currentPassword: current, newPassword: next });
      setPwMsg('Password changed. Other devices were logged out.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setPwErr(errorMessage(err));
    }
  };

  return (
    <section className="stack">
      <h1>Profile</h1>
      <form className="card" onSubmit={saveProfile}>
        <h3>Account</h3>
        <p className="muted small">
          Username: <code>{user?.username}</code> · role: {user?.role}
        </p>
        <Field
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={48}
          required
        />
        <ErrorBox error={profileErr} />
        <SuccessBox message={profileMsg} />
        <button className="btn primary">Save</button>
      </form>

      <form className="card" onSubmit={changePassword}>
        <h3>Change password</h3>
        <Field
          label="Current password"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
        <Field
          label="New password"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          hint={`At least ${PASSWORD_MIN} characters`}
          required
        />
        <Field
          label="Repeat new password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        <ErrorBox error={pwErr} />
        <SuccessBox message={pwMsg} />
        <button className="btn primary">Change password</button>
      </form>
    </section>
  );
}
