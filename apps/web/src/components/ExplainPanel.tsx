import {
  AGENT_PRIVACY_NOTE,
  EXPLANATION_LEVELS,
  MAX_EXPLANATION_NOTE_LENGTH,
  type ExplanationLevel,
  type ModelTier,
  type SongExplanationDto,
} from '@s-maker/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, streamApi } from '../api';
import { renderMarkdown } from '../markdown';
import { timeAgo } from '../pages/HomePage';

interface Props {
  songId: number;
  versionId: number;
  versionNumber: number;
  /** The editor has changes that are not saved, and so are not explained. */
  dirty: boolean;
  onSpent(): void;
  onClose(): void;
}

const LEVEL_LABEL: Record<ExplanationLevel, string> = {
  short: 'Short',
  normal: 'Normal',
  detailed: 'Detailed',
};

function Explanation({ item, onDelete }: { item: SongExplanationDto; onDelete(): void }) {
  // Sanitized in renderMarkdown.
  const html = useMemo(() => renderMarkdown(item.content), [item.content]);
  return (
    <div>
      <div className="row wrap">
        <a className="btn small" href={`/api/songs/${item.songId}/explanations/${item.id}/download`} download>
          Download .md
        </a>
        {item.canDelete && (
          <button className="btn small ghost danger-text" onClick={onDelete}>
            Delete
          </button>
        )}
        <span className="muted small">{item.model}</span>
      </div>
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** Explanations of the song, written on request, visible to everyone who can see the song. */
export function ExplainPanel({ songId, versionId, versionNumber, dirty, onSpent, onClose }: Props) {
  const [items, setItems] = useState<SongExplanationDto[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [level, setLevel] = useState<ExplanationLevel>('normal');
  const [note, setNote] = useState('');
  const [tier, setTier] = useState<ModelTier>('fast');
  const [status, setStatus] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ explanations: SongExplanationDto[] }>('GET', `/api/songs/${songId}/explanations`)
      .then((r) => setItems(r.explanations))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [songId]);

  const ask = async () => {
    setError(null);
    setPartial('');
    setStatus('The agent is writing…');
    try {
      await streamApi(`/api/songs/${songId}/explanations`, { level, note, tier, versionId }, (event) => {
        if (event.type === 'status') setStatus(event.text);
        else if (event.type === 'delta') setPartial((p) => p + event.text);
        else if (event.type === 'reset') setPartial('');
        else if (event.type === 'error') setError(event.error);
        else if (event.type === 'done' && event.explanation) {
          const made = event.explanation;
          setItems((list) => [made, ...list]);
          setOpen(made.id);
          setNote('');
        }
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus(null);
      setPartial('');
      onSpent();
    }
  };

  const remove = async (item: SongExplanationDto) => {
    if (!confirm('Delete this explanation?')) return;
    try {
      await api('DELETE', `/api/songs/${songId}/explanations/${item.id}`);
      setItems((list) => list.filter((x) => x.id !== item.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <aside className="history explain-panel" aria-label="Explanations">
      <div className="row">
        <h3>Explanations</h3>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Close explanations" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="stack explain-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <div className="row wrap">
          <select
            className="input compact"
            value={level}
            onChange={(e) => setLevel(e.target.value as ExplanationLevel)}
            aria-label="Level of detail"
            disabled={!!status}
          >
            {EXPLANATION_LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
          <select
            className="input compact"
            value={tier}
            onChange={(e) => setTier(e.target.value as ModelTier)}
            aria-label="Explanation model"
            disabled={!!status}
          >
            <option value="fast">Fast</option>
            <option value="strong">Strong</option>
          </select>
          <button className="btn primary small" disabled={!!status}>
            {status ?? `Explain v${versionNumber}`}
          </button>
        </div>
        <input
          className="input compact"
          value={note}
          maxLength={MAX_EXPLANATION_NOTE_LENGTH}
          placeholder="Optional: language, what to focus on (po polsku, skup się na harmonii)"
          aria-label="Note for the explanation"
          onChange={(e) => setNote(e.target.value)}
          disabled={!!status}
        />
        {dirty && (
          <p className="muted small">Unsaved edits are not explained, only the saved v{versionNumber}.</p>
        )}
        <p className="muted small agent-privacy">{AGENT_PRIVACY_NOTE}</p>
      </form>
      {error && <p className="alert error small">{error}</p>}
      {partial && <div className="chat-msg assistant">{partial}</div>}
      {items.length === 0 && !status && <p className="muted small">No explanations yet.</p>}
      <ul className="versions explanations">
        {items.map((item) => (
          <li key={item.id}>
            <button
              className={`version ${open === item.id ? 'active' : ''}`}
              aria-expanded={open === item.id}
              onClick={() => setOpen(open === item.id ? null : item.id)}
            >
              <span className="mono">v{item.versionNumber}</span> {LEVEL_LABEL[item.level]}
              <span className="muted small">
                {' '}
                · {item.author?.displayName ?? 'someone'} · {timeAgo(item.at)}
              </span>
            </button>
            {open === item.id && <Explanation item={item} onDelete={() => void remove(item)} />}
          </li>
        ))}
      </ul>
    </aside>
  );
}
