import {
  AGENT_PRIVACY_NOTE,
  isBriefEmpty,
  MAX_BRIEF_ELEMENT_LENGTH,
  MUSIC_ELEMENT_HINTS,
  MUSIC_ELEMENTS,
  type MusicBrief,
  type SongDto,
} from '@s-maker/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage, streamApi } from '../api';
import { ErrorBox } from '../components/Form';
import { ModelSelect, useModelChoice } from '../components/ModelSelect';

function cleanBrief(brief: MusicBrief): MusicBrief {
  return Object.fromEntries(
    MUSIC_ELEMENTS.flatMap((e) => (brief[e]?.trim() ? [[e, brief[e]!.trim()]] : [])),
  ) as MusicBrief;
}

/** A new song from a description, the 14 musical elements, or a conversation. */
export function ComposePage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [brief, setBrief] = useState<MusicBrief>({});
  const model = useModelChoice('strong');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasInput = !!description.trim() || !isBriefEmpty(cleanBrief(brief));

  const compose = async () => {
    setError(null);
    setStatus('The agent is composing…');
    let songId: number | undefined;
    try {
      await streamApi(
        '/api/agent/compose',
        {
          description,
          brief: cleanBrief(brief),
          ...model.request,
          ...(title.trim() ? { title } : {}),
        },
        (event) => {
          if (event.type === 'status') setStatus(event.text);
          else if (event.type === 'error') setError(event.error);
          else if (event.type === 'done') songId = event.songId;
        },
      );
      // The first version waits on the song page, to be listened to and accepted.
      if (songId) navigate(`/songs/${songId}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus(null);
    }
  };

  /** Starts an empty song and continues in the chat. */
  const talk = async () => {
    setError(null);
    setStatus('Creating the song…');
    try {
      const song = await api<SongDto>('POST', '/api/songs', {
        title: title.trim() || 'New song',
        visibility: 'private',
        code: 'setcpm(120/4)\n',
      });
      const clean = cleanBrief(brief);
      if (!isBriefEmpty(clean)) await api('PATCH', `/api/songs/${song.id}`, { brief: clean });
      navigate(`/songs/${song.id}?chat=1`);
    } catch (e) {
      setError(errorMessage(e));
      setStatus(null);
    }
  };

  return (
    <section className="stack compose-page">
      <h1>Compose with the agent</h1>
      <p className="muted">
        Describe the song, fill in any of the elements, or both. The agent decides the rest. You listen to the
        first version before it is saved.
      </p>
      <p className="muted small agent-privacy">{AGENT_PRIVACY_NOTE}</p>
      <ErrorBox error={error} />
      <label className="field">
        <span className="field-label">Title (optional)</span>
        <input
          className="input"
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!!status}
        />
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          className="input"
          rows={4}
          maxLength={2000}
          placeholder="A calm lo-fi piece in D minor, about 75 BPM, with a sparse vibraphone melody…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!!status}
        />
      </label>
      <details className="compose-elements">
        <summary>The 14 musical elements (optional)</summary>
        <div className="compose-grid">
          {MUSIC_ELEMENTS.map((e) => (
            <label key={e} className="brief-field">
              <span className="field-label">{e.charAt(0).toUpperCase() + e.slice(1)}</span>
              <textarea
                className="input compact"
                rows={2}
                maxLength={MAX_BRIEF_ELEMENT_LENGTH}
                placeholder={MUSIC_ELEMENT_HINTS[e]}
                value={brief[e] ?? ''}
                onChange={(ev) => setBrief({ ...brief, [e]: ev.target.value })}
                disabled={!!status}
              />
            </label>
          ))}
        </div>
      </details>
      <div className="row wrap">
        <ModelSelect
          choice={model}
          label="Agent model"
          disabled={!!status}
          tiers={[
            { value: 'strong', label: 'Strong model' },
            { value: 'fast', label: 'Fast model' },
          ]}
        />
        <button className="btn primary" onClick={() => void compose()} disabled={!!status || !hasInput}>
          {status ?? 'Compose'}
        </button>
        <button className="btn" onClick={() => void talk()} disabled={!!status}>
          Talk it through in chat instead
        </button>
      </div>
    </section>
  );
}
