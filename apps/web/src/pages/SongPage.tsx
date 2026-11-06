import {
  parseTracks,
  type MusicBrief,
  type SongDto,
  type VersionDto,
  type VersionSummaryDto,
  type Visibility,
} from '@s-maker/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../api';
import { BriefPanel } from '../components/BriefPanel';
import { ErrorBox } from '../components/Form';
import { HistoryPanel } from '../components/HistoryPanel';
import { Mixer } from '../components/Mixer';
import { StrudelPlayer, type PlayerState, type StrudelPlayerHandle } from '../components/StrudelPlayer';

interface Draft {
  baseVersionId: number;
  code: string;
  at: number;
}
const draftKey = (songId: number) => `smaker.draft.${songId}`;

function readDraft(songId: number): Draft | null {
  try {
    return JSON.parse(localStorage.getItem(draftKey(songId)) ?? 'null') as Draft | null;
  } catch {
    return null;
  }
}

export function SongPage() {
  const { id } = useParams();
  const songId = Number(id);
  const navigate = useNavigate();
  const player = useRef<StrudelPlayerHandle>(null);

  const [song, setSong] = useState<SongDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const [baseVersionId, setBaseVersionId] = useState(0);
  const [playerState, setPlayerState] = useState<PlayerState>({
    ready: false,
    started: false,
    pending: false,
    error: null,
  });
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
  const [title, setTitle] = useState('');

  const dirty = code !== savedCode;
  const canEdit = song?.canEdit ?? false;
  const parsed = useMemo(() => parseTracks(code), [code]);

  const applyLoaded = useCallback((s: SongDto) => {
    setSong(s);
    setTitle(s.title);
    setCode(s.currentVersion.code);
    setSavedCode(s.currentVersion.code);
    setBaseVersionId(s.currentVersion.id);
    const d = readDraft(s.id);
    if (d && d.baseVersionId === s.currentVersion.id && d.code !== s.currentVersion.code && s.canEdit)
      setDraft(d);
    else localStorage.removeItem(draftKey(s.id));
  }, []);

  useEffect(() => {
    if (!Number.isInteger(songId) || songId <= 0) {
      setLoadError('Song not found');
      return;
    }
    api<SongDto>('GET', `/api/songs/${songId}`)
      .then(applyLoaded)
      .catch((e: unknown) => setLoadError(errorMessage(e)));
  }, [songId, applyLoaded]);

  // Keep unsaved edits in this browser, so leaving the page does not lose work.
  useEffect(() => {
    if (!song || !canEdit || draft) return;
    const t = setTimeout(() => {
      if (dirty)
        localStorage.setItem(draftKey(song.id), JSON.stringify({ baseVersionId, code, at: Date.now() }));
      else localStorage.removeItem(draftKey(song.id));
    }, 500);
    return () => clearTimeout(t);
  }, [code, dirty, song, canEdit, baseVersionId, draft]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** Code edits made by the app (mixer, history): push to the player and re-evaluate if playing. */
  const replaceCode = (next: string) => {
    setCode(next);
    player.current?.setCode(next);
    if (playerState.started) player.current?.play();
  };

  const save = async () => {
    if (!song || !canEdit || saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const v = await api<VersionDto>('POST', `/api/songs/${song.id}/versions`, {
        code,
        baseVersionId,
        message: message || undefined,
      });
      setSavedCode(v.code);
      setBaseVersionId(v.id);
      setSong({ ...song, currentVersion: v, versionCount: song.versionCount + 1 });
      setMessage('');
      localStorage.removeItem(draftKey(song.id));
      setNotice(`Saved v${v.number}`);
      setTimeout(() => setNotice(null), 2500);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${e.message}` : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const updateMeta = async (patch: { title?: string; visibility?: Visibility; brief?: MusicBrief }) => {
    if (!song) return;
    try {
      const s = await api<SongDto>('PATCH', `/api/songs/${song.id}`, patch);
      setSong({ ...song, title: s.title, visibility: s.visibility, brief: s.brief });
      setTitle(s.title);
    } catch (e) {
      setError(errorMessage(e));
      setTitle(song.title);
    }
  };

  const restore = async (v: VersionSummaryDto) => {
    if (!song) return;
    try {
      const nv = await api<VersionDto>('POST', `/api/songs/${song.id}/versions/${v.id}/restore`);
      setSavedCode(nv.code);
      setBaseVersionId(nv.id);
      setSong({ ...song, currentVersion: nv, versionCount: song.versionCount + 1 });
      replaceCode(nv.code);
      setNotice(`Restored as v${nv.number}`);
      setTimeout(() => setNotice(null), 2500);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const fork = async (versionId?: number) => {
    if (!song) return;
    try {
      const copy = await api<SongDto>('POST', `/api/songs/${song.id}/fork`, versionId ? { versionId } : {});
      setShowHistory(false);
      // The page reloads the song when the id in the URL changes.
      navigate(`/songs/${copy.id}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!song || !confirm(`Delete "${song.title}" with all its versions? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/songs/${song.id}`);
      localStorage.removeItem(draftKey(song.id));
      navigate('/');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (loadError) {
    return (
      <section className="stack">
        <h1>Song not available</h1>
        <p className="muted">{loadError}</p>
      </section>
    );
  }
  if (!song) return <p className="muted">Loading…</p>;

  return (
    <section className="song-page">
      <div className="song-head">
        {canEdit ? (
          <input
            className="title-input"
            value={title}
            maxLength={100}
            aria-label="Song title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== song.title && void updateMeta({ title })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h1>{song.title}</h1>
        )}
        <span className="muted small">
          by {song.owner.displayName} · v{song.currentVersion.number}
          {song.forkedFrom && (
            <> · variant of {song.forkedFrom.title ? `“${song.forkedFrom.title}”` : 'a song'}</>
          )}
        </span>
        <span className="spacer" />
        <span className="muted small">
          {!playerState.ready
            ? 'starting player…'
            : playerState.pending
              ? 'loading…'
              : playerState.started
                ? '● playing'
                : 'stopped'}
        </span>
      </div>

      <div className="song-toolbar">
        {canEdit ? (
          <>
            <input
              className="input compact grow"
              placeholder="What changed? (optional)"
              value={message}
              maxLength={200}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
              aria-label="Version message"
            />
            <button
              className="btn primary"
              onClick={() => void save()}
              disabled={!dirty || saving}
              title="Ctrl+S"
            >
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            <select
              className="input compact"
              value={song.visibility}
              onChange={(e) => void updateMeta({ visibility: e.target.value as Visibility })}
              aria-label="Visibility"
            >
              <option value="group">Visible to group</option>
              <option value="private">Private</option>
            </select>
          </>
        ) : (
          <>
            <span className="muted small grow">
              Read-only: this song belongs to {song.owner.displayName}.
            </span>
            <button className="btn primary" onClick={() => void fork()}>
              Make my own copy
            </button>
          </>
        )}
        <button
          className="btn"
          onClick={() => {
            setShowBrief((b) => !b);
            setShowHistory(false);
          }}
          aria-pressed={showBrief}
        >
          Brief
        </button>
        <button
          className="btn"
          onClick={() => {
            setShowHistory((h) => !h);
            setShowBrief(false);
          }}
          aria-pressed={showHistory}
        >
          History ({song.versionCount})
        </button>
        {canEdit && (
          <button className="btn ghost danger-text" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>

      {notice && <div className="alert ok">{notice}</div>}
      <ErrorBox error={error} />
      {draft && (
        <div className="alert warn row wrap">
          <span className="grow">You have unsaved changes from {new Date(draft.at).toLocaleString()}.</span>
          <button
            className="btn small"
            onClick={() => {
              replaceCode(draft.code);
              setDraft(null);
            }}
          >
            Restore them
          </button>
          <button
            className="btn small ghost"
            onClick={() => {
              localStorage.removeItem(draftKey(song.id));
              setDraft(null);
            }}
          >
            Discard
          </button>
        </div>
      )}

      <div className={`song-grid ${showHistory || showBrief ? 'with-history' : ''}`}>
        <Mixer parsed={parsed} code={code} readOnly={!canEdit} onChange={replaceCode} />
        <StrudelPlayer
          ref={player}
          code={code}
          onCodeChange={setCode}
          onStateChange={setPlayerState}
          onSave={() => void saveRef.current()}
          className="strudel-frame song-frame"
        />
        {showBrief && (
          <BriefPanel
            key={song.id}
            brief={song.brief}
            canEdit={canEdit}
            onSave={(brief) => updateMeta({ brief })}
            onClose={() => setShowBrief(false)}
          />
        )}
        {showHistory && (
          <HistoryPanel
            songId={song.id}
            currentVersionId={song.currentVersion.id}
            editorCode={code}
            canEdit={canEdit}
            dirty={dirty}
            onLoadIntoEditor={replaceCode}
            onRestore={(v) => void restore(v)}
            onFork={(v) => void fork(v.id)}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>
    </section>
  );
}
