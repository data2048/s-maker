import {
  AGENT_RUN_RETENTION_DAYS,
  diffLines,
  partialJsonString,
  type AgentAdminDto,
  type AgentHistoryEventDto,
  type AgentRunAttemptDto,
  type AgentRunDetailDto,
  type AgentRunListDto,
  type AgentRunSummaryDto,
  type AgentSettings,
  type AgentSongHistoryDto,
} from '@s-maker/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { money } from './AgentPanel';
import { ErrorBox } from './Form';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Text from people and models. React shows it as text: it must never be rendered as HTML. */
function TextBlock({ label, text, open }: { label: string; text: string; open?: boolean }) {
  return (
    <details open={open}>
      <summary className="small">{label}</summary>
      <pre className="log-text">{text}</pre>
    </details>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after).filter((l) => l.type !== 'same'), [before, after]);
  if (!lines.length) return <p className="muted small">No changes in the code.</p>;
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.type === 'add' ? 'diff-add' : 'diff-del'}>
          {l.type === 'add' ? '+ ' : '- '}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function SystemPrompt({ hash }: { hash: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (content !== null) return <TextBlock label={`System prompt ${hash.slice(0, 12)}`} text={content} open />;
  return (
    <p className="small">
      <button
        className="btn small ghost"
        onClick={() =>
          void api<{ content: string }>('GET', `/api/admin/agent/prompts/${hash}`)
            .then((r) => setContent(r.content))
            .catch((e: unknown) => setError(errorMessage(e)))
        }
      >
        Show system prompt {hash.slice(0, 12)}
      </button>
      {error && <span className="alert error small">{error}</span>}
    </p>
  );
}

function tokens(a: AgentRunAttemptDto): string {
  const parts = [`${a.promptTokens ?? '?'} in`, `${a.completionTokens ?? '?'} out`];
  if (a.reasoningTokens !== null) parts.push(`${a.reasoningTokens} thinking`);
  if (a.cachedTokens !== null) parts.push(`${a.cachedTokens} cached`);
  return parts.join(', ');
}

function Attempt({ attempt }: { attempt: AgentRunAttemptDto }) {
  return (
    <div className="log-event">
      <p className="small">
        <strong>Attempt {attempt.number}</strong> · <span className="mono">{attempt.model}</span> ·{' '}
        {tokens(attempt)} · finish: {attempt.finishReason ?? 'not given'} · {money(attempt.costUsd)} ·{' '}
        {seconds(attempt.durationMs)}
      </p>
      {attempt.rejection && <p className="alert warn small">Turned down: {attempt.rejection}</p>}
      {attempt.error && <p className="alert error small">Failed: {attempt.error}</p>}
      {attempt.systemPromptHash && <SystemPrompt hash={attempt.systemPromptHash} />}
      {attempt.messages.map((m, i) => (
        <TextBlock key={i} label={`Sent: ${m.role}`} text={m.content} />
      ))}
      {attempt.answer !== null && <TextBlock label="Answer" text={attempt.answer} />}
    </div>
  );
}

/** A run with everything sent and received. */
function RunBody({ run }: { run: AgentRunDetailDto }) {
  return (
    <>
      {run.error && <p className="alert error small">{run.error}</p>}
      <TextBlock label="Request" text={run.request} open />
      {run.inputCode !== null && <TextBlock label="Code sent" text={run.inputCode} />}
      {run.outputCode !== null && <TextBlock label="Code that came out" text={run.outputCode} />}
      {run.attempts.map((a) => (
        <Attempt key={a.number} attempt={a} />
      ))}
      {!run.attempts.length && <p className="muted small">No model was asked.</p>}
    </>
  );
}

function runLine(run: { purpose: string; status: string; decision: string | null; at: string }) {
  return `${new Date(run.at).toLocaleString()} · ${run.purpose} · ${run.status}${run.decision ? ` · ${run.decision}` : ''}`;
}

function RunDetails(props: {
  run: AgentRunDetailDto;
  onChanged(): void;
  onHistory(songId: number): void;
  onClose(): void;
}) {
  const { run, onChanged } = props;
  const [note, setNote] = useState(run.note);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const saveNote = async () => {
    setError(null);
    setSaved(false);
    try {
      await api('PATCH', `/api/admin/agent/runs/${run.id}`, { note });
      setSaved(true);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section className="card" aria-label={`Run ${run.id}`}>
      <div className="row wrap">
        <h3>Run {run.id}</h3>
        <span className="muted small">
          {runLine(run)} · {run.username ?? 'someone'} · {run.songTitle ?? 'no song'}
        </span>
        <span className="spacer" />
        {run.songId !== null && (
          <button className="btn small" onClick={() => props.onHistory(run.songId!)}>
            Song history
          </button>
        )}
        <button className="icon-btn" aria-label="Close run" onClick={props.onClose}>
          ×
        </button>
      </div>
      <RunBody run={run} />
      <label className="field">
        <span className="field-label">Note</span>
        <textarea
          className="input compact"
          rows={2}
          maxLength={2000}
          value={note}
          aria-label="Note on this run"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <ErrorBox error={error} />
      {saved && <p className="alert ok small">Saved.</p>}
      <button className="btn small" onClick={() => void saveNote()}>
        Save note
      </button>
    </section>
  );
}

function HistoryEvent({ event, previousCode }: { event: AgentHistoryEventDto; previousCode: string | null }) {
  if (event.kind === 'version') {
    const v = event.version;
    const byHand = v.authorKind === 'user';
    return (
      <div className={`log-event ${byHand ? 'by-hand' : ''}`}>
        <p className="small">
          <strong>
            v{v.number} · {byHand ? 'saved by hand' : 'saved from the agent'}
          </strong>{' '}
          · {new Date(event.at).toLocaleString()}
          {v.message ? ` · ${v.message}` : ''}
        </p>
        {previousCode !== null ? (
          <Diff before={previousCode} after={v.code} />
        ) : (
          <TextBlock label="Code" text={v.code} />
        )}
      </div>
    );
  }
  const { run } = event;
  const last = run.attempts.at(-1)?.answer ?? null;
  // Chat and change answers are JSON: show the part the person saw.
  const visible =
    last === null
      ? null
      : run.purpose === 'explain'
        ? last
        : (partialJsonString(last, 'reply') ?? partialJsonString(last, 'summary') ?? last);
  return (
    <div className="log-event run">
      <p className="small">
        <strong>Run {run.id}</strong> · {runLine(run)} · {run.username ?? 'someone'}
      </p>
      <pre className="log-text">{run.request}</pre>
      {event.editedSinceLastVersion && previousCode !== null && run.inputCode !== null && (
        <>
          <p className="small">Edits in the editor, not saved, sent with this request:</p>
          <Diff before={previousCode} after={run.inputCode} />
        </>
      )}
      {visible !== null && <pre className="log-text">{visible}</pre>}
      <details>
        <summary className="small">All attempts ({run.attempts.length})</summary>
        <RunBody run={run} />
      </details>
    </div>
  );
}

function SongHistory({ history, onClose }: { history: AgentSongHistoryDto; onClose(): void }) {
  let saved: string | null = null;
  return (
    <section className="card" aria-label="Song history">
      <div className="row wrap">
        <h3>History of {history.song.title}</h3>
        <span className="spacer" />
        <a className="btn small" href={`/api/admin/agent/songs/${history.song.id}/export`} download>
          Download this song
        </a>
        <button className="icon-btn" aria-label="Close history" onClick={onClose}>
          ×
        </button>
      </div>
      {history.events.map((event, i) => {
        const previousCode = saved;
        if (event.kind === 'version') saved = event.version.code;
        return <HistoryEvent key={i} event={event} previousCode={previousCode} />;
      })}
    </section>
  );
}

function RunRow(props: {
  run: AgentRunSummaryDto;
  onMark(run: AgentRunSummaryDto, flagged: boolean): void;
  onOpen(id: number): void;
  onHistory(songId: number): void;
}) {
  const { run: r } = props;
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          aria-label={`Mark run ${r.id}`}
          checked={r.flagged}
          onChange={(e) => props.onMark(r, e.target.checked)}
        />
      </td>
      <td className="actions">
        <button className="btn small" aria-label={`Open run ${r.id}`} onClick={() => props.onOpen(r.id)}>
          Open
        </button>
        {r.songId !== null && (
          <button
            className="btn small"
            aria-label={`History of the song of run ${r.id}`}
            onClick={() => props.onHistory(r.songId!)}
          >
            History
          </button>
        )}
      </td>
      <td className="small">{new Date(r.at).toLocaleString()}</td>
      <td>{r.username ?? '-'}</td>
      <td>{r.songTitle ?? '-'}</td>
      <td>{r.purpose}</td>
      <td className="small log-request">{r.request}</td>
      <td className="mono small">{r.model ?? '-'}</td>
      <td className="small">
        {r.attemptCount}
        {r.rejectedCount ? ` (${r.rejectedCount} turned down)` : ''}
      </td>
      <td className="small">
        {r.promptTokens} + {r.completionTokens}
        {r.reasoningTokens ? ` (${r.reasoningTokens} thinking)` : ''}
      </td>
      <td>{money(r.costUsd)}</td>
      <td className="small">{seconds(r.durationMs)}</td>
      <td>
        {r.status}
        {r.decision ? `, ${r.decision}` : ''}
      </td>
    </tr>
  );
}

/** Admin: every run of the agent, to find out why results were poor and to replay them on other models. */
function AgentRuns() {
  const [list, setList] = useState<(AgentRunListDto & { pageSize: number }) | null>(null);
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [offset, setOffset] = useState(0);
  const [run, setRun] = useState<AgentRunDetailDto | null>(null);
  const [history, setHistory] = useState<AgentSongHistoryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const query = `?offset=${offset}${onlyMarked ? '&flagged=1' : ''}`;
    api<AgentRunListDto & { pageSize: number }>('GET', `/api/admin/agent/runs${query}`)
      .then(setList)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [offset, onlyMarked]);
  useEffect(load, [load]);

  const open = (id: number) => {
    setError(null);
    setHistory(null);
    api<AgentRunDetailDto>('GET', `/api/admin/agent/runs/${id}`)
      .then(setRun)
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  const openHistory = (songId: number) => {
    setError(null);
    setRun(null);
    api<AgentSongHistoryDto>('GET', `/api/admin/agent/songs/${songId}/history`)
      .then(setHistory)
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  const mark = (r: AgentRunSummaryDto, flagged: boolean) => {
    // A checkbox answers at once; a failure puts back what the server has.
    setList((l) => l && { ...l, runs: l.runs.map((x) => (x.id === r.id ? { ...x, flagged } : x)) });
    api('PATCH', `/api/admin/agent/runs/${r.id}`, { flagged })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(load);
  };

  return (
    <>
      <div className="card">
        <div className="row wrap">
          <h3>Agent runs{list ? `: ${list.total}` : ''}</h3>
          <span className="spacer" />
          <label className="small">
            <input
              type="checkbox"
              checked={onlyMarked}
              onChange={(e) => {
                setOffset(0);
                setOnlyMarked(e.target.checked);
              }}
            />{' '}
            Marked only
          </label>
          <a className="btn small" href="/api/admin/agent/runs/export" download>
            Download marked runs
          </a>
        </div>
        <p className="muted small">
          Holds requests and code from everyone, private songs included. Runs that are not marked are deleted
          after {AGENT_RUN_RETENTION_DAYS} days. Files have no user names; keep them in kb/raw/.
        </p>
        <ErrorBox error={error} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mark</th>
                <th />
                <th>When</th>
                <th>User</th>
                <th>Song</th>
                <th>What</th>
                <th>Request</th>
                <th>Model</th>
                <th>Attempts</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Time</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {list?.runs.map((r) => (
                <RunRow key={r.id} run={r} onMark={mark} onOpen={open} onHistory={openHistory} />
              ))}
            </tbody>
          </table>
        </div>
        {list && list.total > list.pageSize && (
          <div className="row">
            <button
              className="btn small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - list.pageSize))}
            >
              Newer
            </button>
            <button
              className="btn small"
              disabled={offset + list.pageSize >= list.total}
              onClick={() => setOffset(offset + list.pageSize)}
            >
              Older
            </button>
          </div>
        )}
      </div>
      {run && (
        <RunDetails
          key={run.id}
          run={run}
          onChanged={load}
          onHistory={openHistory}
          onClose={() => setRun(null)}
        />
      )}
      {history && <SongHistory history={history} onClose={() => setHistory(null)} />}
    </>
  );
}

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

      <AgentRuns />

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
