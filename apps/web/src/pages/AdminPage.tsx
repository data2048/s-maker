import { AgentAdminTab } from '../components/AgentAdminTab';
import type { AuditEntryDto, CreateInviteResponse, InviteDto, Role, UserDto } from '@s-maker/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox } from '../components/Form';

type Tab = 'users' | 'invites' | 'agent' | 'audit';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <section className="stack">
      <h1>Admin</h1>
      <div className="tabs" role="tablist">
        {(['users', 'invites', 'agent', 'audit'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'audit' ? 'Audit log' : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'invites' && <InvitesTab />}
      {tab === 'agent' && <AgentAdminTab />}
      {tab === 'audit' && <AuditTab />}
    </section>
  );
}

function UsersTab() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ users: UserDto[] }>('GET', '/api/admin/users')
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const update = async (id: number, patch: { active?: boolean; role?: Role }) => {
    setError(null);
    try {
      await api('PATCH', `/api/admin/users/${id}`, patch);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="card">
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName} <span className="muted small">@{u.username}</span>
                </td>
                <td>{u.role}</td>
                <td>
                  {u.active ? (
                    <span className="badge ok">active</span>
                  ) : (
                    <span className="badge">disabled</span>
                  )}
                </td>
                <td className="small">{fmt(u.createdAt)}</td>
                <td className="actions">
                  {u.id !== me?.id && (
                    <>
                      <button
                        className="btn ghost small"
                        onClick={() => update(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })}
                      >
                        {u.role === 'admin' ? 'Make user' : 'Make admin'}
                      </button>
                      <button
                        className={`btn small ${u.active ? 'danger' : 'ghost'}`}
                        onClick={() => update(u.id, { active: !u.active })}
                      >
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvitesTab() {
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [hours, setHours] = useState(72);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api<{ invites: InviteDto[] }>('GET', '/api/admin/invites')
      .then((r) => setInvites(r.invites))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setCopied(false);
    try {
      const res = await api<CreateInviteResponse>('POST', '/api/admin/invites', {
        role,
        note: note || undefined,
        expiresInHours: hours,
      });
      setLink(res.link);
      setNote('');
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const revoke = async (id: number) => {
    try {
      await api('DELETE', `/api/admin/invites/${id}`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <div className="stack">
      <form className="card row-form" onSubmit={create}>
        <label className="field">
          <span className="field-label">Note (who is it for?)</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} />
        </label>
        <label className="field">
          <span className="field-label">Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Valid for</span>
          <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>1 day</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
          </select>
        </label>
        <button className="btn primary">Create invite</button>
      </form>

      {link && (
        <div className="card highlight">
          <p className="small">Send this link to your friend. It works once and is shown only now.</p>
          <div className="copy-row">
            <code className="link">{link}</code>
            <button className="btn small" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Note</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.note ?? (i.username ? `setup: @${i.username}` : '—')}</td>
                  <td>{i.role}</td>
                  <td>
                    <span className={`badge ${i.status === 'pending' ? 'ok' : ''}`}>{i.status}</span>
                    {i.usedBy && <span className="muted small"> by @{i.usedBy}</span>}
                  </td>
                  <td className="small">{fmt(i.createdAt)}</td>
                  <td className="small">{fmt(i.expiresAt)}</td>
                  <td className="actions">
                    {i.status === 'pending' && (
                      <button className="btn ghost small" onClick={() => revoke(i.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ entries: AuditEntryDto[] }>('GET', '/api/admin/audit?limit=200')
      .then((r) => setEntries(r.entries))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  return (
    <div className="card">
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Who</th>
              <th>IP</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="small">{fmt(e.at)}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>{e.actor ? `@${e.actor}` : '—'}</td>
                <td className="small">{e.ip ?? '—'}</td>
                <td className="small mono">{e.details ? JSON.stringify(e.details) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
