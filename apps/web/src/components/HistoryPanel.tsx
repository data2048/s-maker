import { diffLines, type VersionDto, type VersionSummaryDto } from '@s-maker/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { timeAgo } from '../pages/HomePage';

interface Props {
  songId: number;
  /** Changes whenever a new version is saved, to reload the list. */
  currentVersionId: number;
  /** Code currently in the editor (compared against the selected version). */
  editorCode: string;
  canEdit: boolean;
  dirty: boolean;
  onLoadIntoEditor(code: string): void;
  onRestore(version: VersionSummaryDto): void;
  onFork(version: VersionSummaryDto): void;
  onClose(): void;
}

export function HistoryPanel(props: Props) {
  const { songId, currentVersionId, editorCode } = props;
  const [list, setList] = useState<VersionSummaryDto[]>([]);
  const [selected, setSelected] = useState<VersionDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ versions: VersionSummaryDto[] }>('GET', `/api/songs/${songId}/versions`)
      .then((r) => setList(r.versions))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [songId, currentVersionId]);

  const select = async (v: VersionSummaryDto) => {
    try {
      setSelected(await api<VersionDto>('GET', `/api/songs/${songId}/versions/${v.id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const diff = useMemo(() => (selected ? diffLines(selected.code, editorCode) : []), [selected, editorCode]);
  const changes = diff.filter((d) => d.type !== 'same').length;

  return (
    <aside className="history card">
      <div className="row">
        <h3>History</h3>
        <span className="spacer" />
        <button className="btn ghost small" onClick={props.onClose}>
          Close
        </button>
      </div>
      {error && <p className="alert error small">{error}</p>}
      <ul className="versions">
        {list.map((v) => (
          <li key={v.id}>
            <button
              className={`version ${selected?.id === v.id ? 'active' : ''}`}
              onClick={() => void select(v)}
            >
              <span className="mono">v{v.number}</span>
              <span className="version-msg">{v.message ?? '—'}</span>
              <span className="muted small">
                {v.authorKind === 'agent' ? 'agent' : (v.author?.displayName ?? '?')} · {timeAgo(v.createdAt)}
              </span>
              {v.id === currentVersionId && <span className="badge ok">current</span>}
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <div className="stack">
          <p className="small muted">
            Changes from v{selected.number} to the editor: {changes === 0 ? 'none' : `${changes} lines`}
          </p>
          <pre className="diff">
            {diff.map((d, i) => (
              <div key={i} className={`diff-${d.type}`}>
                {d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  '}
                {d.text}
              </div>
            ))}
          </pre>
          <div className="row wrap">
            <button className="btn small" onClick={() => props.onLoadIntoEditor(selected.code)}>
              Load into editor
            </button>
            {props.canEdit && selected.id !== currentVersionId && (
              <button
                className="btn small"
                disabled={props.dirty}
                title={props.dirty ? 'Save or discard your changes first' : undefined}
                onClick={() => props.onRestore(selected)}
              >
                Restore as new version
              </button>
            )}
            <button className="btn small" onClick={() => props.onFork(selected)}>
              New song from v{selected.number}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
