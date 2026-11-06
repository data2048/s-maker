import type { SongDto, SongSummaryDto } from '@s-maker/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorBox } from '../components/Form';

export const timeAgo = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};

function SongList({ songs, showOwner }: { songs: SongSummaryDto[]; showOwner?: boolean }) {
  return (
    <ul className="song-list">
      {songs.map((s) => (
        <li key={s.id}>
          <Link to={`/songs/${s.id}`} className="song-row">
            <span className="song-title">{s.title}</span>
            {s.visibility === 'private' && <span className="badge">private</span>}
            <span className="spacer" />
            {showOwner && <span className="muted small">{s.owner.displayName}</span>}
            <span className="muted small">
              v{s.versionCount} · {timeAgo(s.updatedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mine, setMine] = useState<SongSummaryDto[] | null>(null);
  const [group, setGroup] = useState<SongSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api<{ songs: SongSummaryDto[] }>('GET', '/api/songs?scope=mine')
      .then((r) => setMine(r.songs))
      .catch((e: unknown) => setError(errorMessage(e)));
    api<{ songs: SongSummaryDto[] }>('GET', '/api/songs?scope=group')
      .then((r) => setGroup(r.songs))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  const createSong = async () => {
    setCreating(true);
    try {
      const song = await api<SongDto>('POST', '/api/songs', { title: 'Untitled song' });
      navigate(`/songs/${song.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setCreating(false);
    }
  };

  return (
    <section className="stack">
      <div className="row">
        <h1>Hi, {user?.displayName}</h1>
        <div className="spacer" />
        <Link to="/import" className="btn">
          Import MIDI
        </Link>
        <Link className="btn" to="/compose">
          Compose with agent
        </Link>
        <button className="btn primary" onClick={createSong} disabled={creating}>
          New song
        </button>
      </div>
      <ErrorBox error={error} />

      <div className="card">
        <h3>My songs</h3>
        {mine === null ? (
          <p className="muted">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="muted">No songs yet. Start one with “New song”, or try ideas in the Playground.</p>
        ) : (
          <SongList songs={mine} />
        )}
      </div>

      <div className="card">
        <h3>From the group</h3>
        {group === null ? (
          <p className="muted">Loading…</p>
        ) : group.length === 0 ? (
          <p className="muted">Nothing shared by others yet.</p>
        ) : (
          <SongList songs={group} showOwner />
        )}
      </div>
    </section>
  );
}
