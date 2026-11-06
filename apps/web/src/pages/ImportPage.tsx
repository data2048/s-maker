import {
  GRID_LABELS,
  MIDI_TYPE_LABELS,
  MIDI_TYPES,
  GRIDS,
  MAX_IMPORT_BARS,
  MAX_MIDI_BYTES,
  noteName,
  type GridSteps,
  type ImportMode,
  type MidiType,
  type MidiConvertResponse,
  type MidiImportResponse,
  type MidiUploadDto,
  type Visibility,
} from '@s-maker/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage, uploadFile } from '../api';
import { ErrorBox } from '../components/Form';
import { StrudelPlayer, type PlayerState } from '../components/StrudelPlayer';
import { timeAgo } from './HomePage';

const titleFromFile = (name: string) =>
  name.replace(/\.(mid|midi|smf)$/i, '').slice(0, 100) || 'Imported song';

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ImportPage() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<MidiUploadDto[]>([]);
  const [upload, setUpload] = useState<MidiUploadDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [parts, setParts] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<ImportMode>('faithful');
  const [midiType, setMidiType] = useState<MidiType>('other');
  const [grid, setGrid] = useState<GridSteps | 'auto'>('auto');
  const [fromBar, setFromBar] = useState(1);
  const [toBar, setToBar] = useState(1);
  const [velocity, setVelocity] = useState(true);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('group');

  const [preview, setPreview] = useState<MidiConvertResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);

  useEffect(() => {
    api<{ uploads: MidiUploadDto[] }>('GET', '/api/midi')
      .then((r) => setRecent(r.uploads))
      .catch(() => {});
  }, []);

  const open = (u: MidiUploadDto) => {
    setUpload(u);
    setParts(new Set(u.analysis.parts.map((p) => p.index)));
    setGrid('auto');
    setMidiType(u.analysis.classification.type);
    setFromBar(1);
    setToBar(Math.min(u.analysis.bars, MAX_IMPORT_BARS));
    setTitle(titleFromFile(u.fileName));
    setPreview(null);
    setError(null);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_MIDI_BYTES) {
      setError('The file is too large (max 2 MB)');
      return;
    }
    setUploading(true);
    try {
      const u = await uploadFile<MidiUploadDto>(
        `/api/midi?name=${encodeURIComponent(file.name)}`,
        file,
        'audio/midi',
      );
      setRecent((r) => [u, ...r.filter((x) => x.id !== u.id)]);
      open(u);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const options = () => ({
    mode,
    parts: [...parts].sort((a, b) => a - b),
    grid,
    startBar: fromBar - 1,
    bars: Math.max(1, toBar - fromBar + 1),
    velocity,
  });

  // Live preview: convert again shortly after any setting changes.
  useEffect(() => {
    if (!upload) return;
    if (!parts.size) {
      setPreview(null);
      setPreviewError('Choose at least one track');
      return;
    }
    const t = setTimeout(() => {
      setConverting(true);
      api<MidiConvertResponse>('POST', `/api/midi/${upload.id}/convert`, options())
        .then((r) => {
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: unknown) => setPreviewError(errorMessage(e)))
        .finally(() => setConverting(false));
    }, 350);
    return () => clearTimeout(t);
    // options() reads exactly these values.
  }, [upload, mode, parts, grid, fromBar, toBar, velocity]);

  const doImport = async () => {
    if (!upload) return;
    setImporting(true);
    setError(null);
    try {
      const r = await api<MidiImportResponse>('POST', `/api/midi/${upload.id}/import`, {
        ...options(),
        title: title.trim() || titleFromFile(upload.fileName),
        midiType,
        visibility,
      });
      navigate(`/songs/${r.song.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setImporting(false);
    }
  };

  const removeUpload = async (u: MidiUploadDto) => {
    if (!confirm(`Remove "${u.fileName}" from your uploads? Songs made from it stay.`)) return;
    try {
      await api('DELETE', `/api/midi/${u.id}`);
      setRecent((r) => r.filter((x) => x.id !== u.id));
      if (upload?.id === u.id) setUpload(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const toggle = (index: number) =>
    setParts((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const a = upload?.analysis;
  const maxBar = a ? a.bars : 1;

  return (
    <section className="stack import-page">
      <div className="row">
        <h1>Import MIDI</h1>
        <span className="spacer" />
        <input
          ref={fileInput}
          type="file"
          accept=".mid,.midi,audio/midi,audio/x-midi"
          className="visually-hidden"
          id="midi-file"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <label htmlFor="midi-file" className={`btn primary ${uploading ? 'disabled' : ''}`}>
          {uploading ? 'Uploading…' : upload ? 'Choose another file' : 'Choose a .mid file'}
        </label>
      </div>
      <ErrorBox error={error} />

      {!upload && (
        <div
          className="card dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFile(e.dataTransfer.files[0]);
          }}
        >
          <p>
            Drop a MIDI file here or use the button above. Faithful mode converts it note for note into
            Strudel code: one cycle per bar, with the instruments mapped to General MIDI sounds.
          </p>
          <p className="muted small">Max 2 MB. Files are only visible to you.</p>
        </div>
      )}

      {upload && a && (
        <>
          <div className="card">
            <div className="row wrap">
              <h3 className="grow">{upload.fileName}</h3>
              <span className="muted small">
                {a.bpm} BPM · {a.timeSignature.numerator}/{a.timeSignature.denominator} ·{' '}
                {a.key
                  ? `${a.key.tonic} ${a.key.mode}${a.key.source === 'detected' ? ' (detected)' : ''}`
                  : 'key unknown'}{' '}
                · {a.bars} bars · {formatDuration(a.durationSeconds)} · {a.noteCount} notes
              </span>
            </div>
            {(a.tempoChanges > 0 || a.timeSignatureChanges > 0) && (
              <p className="muted small">
                {a.tempoChanges > 0 && `Tempo changes ${a.tempoChanges}×. `}
                {a.timeSignatureChanges > 0 && 'Time signature changes. '}
                The import uses the first tempo and meter.
              </p>
            )}

            <div className="table-wrap">
              <table className="table midi-parts">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="All tracks"
                        checked={parts.size === a.parts.length}
                        onChange={(e) =>
                          setParts(e.target.checked ? new Set(a.parts.map((p) => p.index)) : new Set())
                        }
                      />
                    </th>
                    <th>Track</th>
                    <th>Instrument</th>
                    <th>Notes</th>
                    <th>Range</th>
                    <th>Bars</th>
                  </tr>
                </thead>
                <tbody>
                  {a.parts.map((p) => (
                    <tr key={p.index} className={parts.has(p.index) ? '' : 'muted'}>
                      <td>
                        <input
                          type="checkbox"
                          checked={parts.has(p.index)}
                          onChange={() => toggle(p.index)}
                          aria-label={`Import ${p.name}`}
                        />
                      </td>
                      <td>
                        {p.name} <span className="muted small">ch {p.channel + 1}</span>
                      </td>
                      <td>
                        {p.isDrums ? (
                          'Drums → drum machine'
                        ) : (
                          <>
                            {p.programName} <span className="muted small mono">{p.sound}</span>
                          </>
                        )}
                      </td>
                      <td>
                        {p.noteCount}
                        {p.maxPolyphony > 1 && (
                          <span className="muted small"> · up to {p.maxPolyphony} at once</span>
                        )}
                      </td>
                      <td className="mono small">
                        {p.isDrums ? '' : `${noteName(p.low)}–${noteName(p.high)}`}
                      </td>
                      <td className="small">
                        {p.firstBar + 1}–{p.lastBar + 1}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="import-options">
              <label className="field">
                <span className="field-label">Mode</span>
                <select
                  className="input compact"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ImportMode)}
                >
                  <option value="faithful">Faithful: note for note</option>
                  <option value="essence">Essence: loops and sections</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">
                  Type
                  {midiType === a.classification.type && ' (detected)'}
                </span>
                <select
                  className="input compact"
                  value={midiType}
                  title={a.classification.reasons.join(', ')}
                  onChange={(e) => setMidiType(e.target.value as MidiType)}
                >
                  {MIDI_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {MIDI_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Grid</span>
                <select
                  className="input compact"
                  value={grid}
                  onChange={(e) =>
                    setGrid(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as GridSteps))
                  }
                >
                  <option value="auto">
                    Auto{preview && grid === 'auto' ? ` (${GRID_LABELS[preview.grid]})` : ''}
                  </option>
                  {GRIDS.map((g) => (
                    <option key={g} value={g}>
                      {GRID_LABELS[g]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">From bar</span>
                <input
                  className="input compact"
                  type="number"
                  min={1}
                  max={maxBar}
                  value={fromBar}
                  onChange={(e) => {
                    const v = Math.min(maxBar, Math.max(1, Number(e.target.value) || 1));
                    setFromBar(v);
                    if (toBar < v) setToBar(v);
                  }}
                />
              </label>
              <label className="field">
                <span className="field-label">To bar</span>
                <input
                  className="input compact"
                  type="number"
                  min={fromBar}
                  max={Math.min(maxBar, fromBar + MAX_IMPORT_BARS - 1)}
                  value={toBar}
                  onChange={(e) =>
                    setToBar(
                      Math.min(
                        maxBar,
                        fromBar + MAX_IMPORT_BARS - 1,
                        Math.max(fromBar, Number(e.target.value) || fromBar),
                      ),
                    )
                  }
                />
              </label>
              <label className="check">
                <input type="checkbox" checked={velocity} onChange={(e) => setVelocity(e.target.checked)} />
                Keep dynamics (velocity)
              </label>
            </div>
          </div>

          <div className="card">
            <div className="row wrap">
              <h3 className="grow">Preview</h3>
              <span className="muted small">
                {converting
                  ? 'converting…'
                  : preview
                    ? `${preview.stats.tracks} tracks · ${preview.stats.notes} notes · ${preview.code.length.toLocaleString()} characters`
                    : ''}
                {playerState?.started ? ' · ● playing' : ''}
              </span>
            </div>
            {previewError && <p className="alert error small">{previewError}</p>}
            {preview?.form && (
              <p className="muted small form-line">
                Form: {preview.form.map((s) => `${s.label} (${s.bars})`).join(' ')}
                {preview.keptNotes !== undefined &&
                  ` · ${preview.keptNotes} of ${preview.stats.notes} notes written out`}
              </p>
            )}
            {preview && preview.warnings.length > 0 && (
              <ul className="alert warn small import-warnings">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {preview && (
              <StrudelPlayer
                code={preview.code}
                onStateChange={setPlayerState}
                className="strudel-frame import-frame"
              />
            )}
            <div className="row wrap import-actions">
              <input
                className="input compact grow"
                value={title}
                maxLength={100}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Song title"
                placeholder="Song title"
              />
              <select
                className="input compact"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as Visibility)}
                aria-label="Visibility"
              >
                <option value="group">Visible to group</option>
                <option value="private">Private</option>
              </select>
              <button
                className="btn primary"
                onClick={() => void doImport()}
                disabled={!preview || importing || converting || !!previewError}
              >
                {importing ? 'Creating…' : 'Create song'}
              </button>
            </div>
          </div>
        </>
      )}

      {recent.length > 0 && (
        <div className="card">
          <h3>My MIDI files</h3>
          <ul className="song-list">
            {recent.map((u) => (
              <li key={u.id} className="song-row">
                <button className="link-btn song-title" onClick={() => open(u)}>
                  {u.fileName}
                </button>
                <span className="spacer" />
                <span className="muted small">
                  {u.analysis.parts.length} tracks · {u.analysis.bars} bars · {timeAgo(u.createdAt)}
                </span>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${u.fileName}`}
                  onClick={() => void removeUpload(u)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
