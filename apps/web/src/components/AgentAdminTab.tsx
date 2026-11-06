import { type AgentAdminDto, type AgentSettings } from '@s-maker/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { money } from './AgentPanel';
import { ErrorBox } from './Form';

/** Admin: models, spending limits and what the agent has cost. */
export function AgentAdminTab() {
  const [data, setData] = useState<AgentAdminDto | null>(null);
  const [form, setForm] = useState<AgentSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () =>
    api<AgentAdminDto>('GET', '/api/admin/agent')
      .then((d) => {
        setData(d);
        setForm(d.settings);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api('PUT', '/api/admin/agent/settings', form);
      setSaved(true);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!data || !form) return <ErrorBox error={error} />;
  const text = (key: 'modelFast' | 'modelStrong' | 'modelFallback', label: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );
  const number = (key: 'userWeeklyLimitUsd' | 'globalWeeklyLimitUsd', label: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        type="number"
        min={0}
        step={0.5}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
      />
    </label>
  );

  return (
    <div className="stack">
      {!data.enabled && (
        <p className="alert warn">OPENROUTER_API_KEY is not set on the server, so the agent is off.</p>
      )}
      <form className="card stack" onSubmit={(e) => void save(e)}>
        <h3>Models and limits</h3>
        {text('modelFast', 'Fast model')}
        {text('modelStrong', 'Strong model')}
        {text('modelFallback', 'Fallback model (optional)')}
        {number('userWeeklyLimitUsd', 'Limit per user, USD per 7 days')}
        {number('globalWeeklyLimitUsd', 'Limit for the group, USD per 7 days')}
        <ErrorBox error={error} />
        {saved && <p className="alert ok">Saved.</p>}
        <div>
          <button className="btn primary">Save</button>
        </div>
      </form>

      <div className="card">
        <h3>Last 7 days: {money(data.totalUsd)}</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Calls</th>
                <th>Spent</th>
              </tr>
            </thead>
            <tbody>
              {data.spending.map((s) => (
                <tr key={s.username}>
                  <td>{s.username}</td>
                  <td>{s.calls}</td>
                  <td>{money(s.spentUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Recent calls</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>What</th>
                <th>Model</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((c) => (
                <tr key={c.id}>
                  <td className="small">{new Date(c.at).toLocaleString()}</td>
                  <td>{c.username ?? '-'}</td>
                  <td>{c.purpose}</td>
                  <td className="mono small">{c.model}</td>
                  <td className="small">
                    {c.promptTokens} + {c.completionTokens}
                  </td>
                  <td>{money(c.costUsd)}</td>
                  <td>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
