import {
  DRUM_BANKS,
  GM_SOUNDS,
  addTrack,
  gmLabel,
  removeTrack,
  renameTrack,
  setTrackBank,
  setTrackInstrument,
  setTrackMuted,
  setTrackSolo,
  type ParseResult,
  type TrackInfo,
} from '@s-maker/shared';
import { useState, type FormEvent } from 'react';

/** Starting code for new tracks. */
const TRACK_TEMPLATES: Record<string, { label: string; body: string }> = {
  drums: { label: 'Drums', body: 's("bd ~ sd ~, hh*8").bank("RolandTR909")' },
  bass: { label: 'Bass', body: 'note("<c2 c2 g1 a1>").s("gm_acoustic_bass")' },
  chords: { label: 'Chords', body: 'note("<[c3,e3,g3] [a2,c3,e3]>").s("gm_epiano1").gain(.6)' },
  melody: { label: 'Melody', body: 'n("0 2 4 <5 7>").scale("C4:major").s("gm_flute")' },
  empty: { label: 'Empty', body: 'note("c3")' },
};

interface Props {
  parsed: ParseResult;
  code: string;
  readOnly?: boolean;
  /** Apply an edited version of the song code. */
  onChange(code: string): void;
  /** Asks the agent about one track. */
  onAskAgent?(track: string): void;
}

function InstrumentSelect({
  track,
  disabled,
  onPick,
}: {
  track: TrackInfo;
  disabled?: boolean;
  onPick(v: string): void;
}) {
  // Drum patterns (s("bd sd") + .bank) choose a drum machine instead of a GM instrument.
  if (!track.instrument && track.bank !== null) {
    const banks: readonly string[] = DRUM_BANKS.includes(track.bank as (typeof DRUM_BANKS)[number])
      ? DRUM_BANKS
      : [track.bank, ...DRUM_BANKS];
    return (
      <select
        className="input compact"
        value={track.bank}
        disabled={disabled}
        onChange={(e) => onPick(`bank:${e.target.value}`)}
        aria-label={`Drum machine of ${track.name}`}
      >
        {banks.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
    );
  }
  const value = track.instrument ?? '';
  const known = (GM_SOUNDS as readonly string[]).includes(value);
  return (
    <select
      className="input compact"
      value={value}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value)}
      aria-label={`Instrument of ${track.name}`}
    >
      {!value && <option value="">(set in code)</option>}
      {value && !known && <option value={value}>{value}</option>}
      {GM_SOUNDS.map((g) => (
        <option key={g} value={g}>
          {gmLabel(g)}
        </option>
      ))}
    </select>
  );
}

export function Mixer({ parsed, code, readOnly, onChange, onAskAgent }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [template, setTemplate] = useState('melody');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = (fn: () => string) => {
    try {
      setError(null);
      onChange(fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the code');
    }
  };

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    const t = TRACK_TEMPLATES[template]!;
    apply(() => addTrack(code, newName || template, t.body));
    setAdding(false);
    setNewName('');
  };

  const submitRename = (e: FormEvent, index: number) => {
    e.preventDefault();
    if (renameValue.trim()) apply(() => renameTrack(code, index, renameValue));
    setRenaming(null);
  };

  if (!parsed.ok) {
    return (
      <div className="mixer">
        <h3>Tracks</h3>
        <p className="alert error small">
          The code has a syntax error, so the track list is paused. Fix it in the editor.
        </p>
      </div>
    );
  }

  const anySolo = parsed.tracks.some((t) => t.solo);

  return (
    <div className="mixer">
      <div className="row">
        <h3>Tracks</h3>
        <span className="spacer" />
        {!readOnly && (
          <button className="btn small" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : '+ Track'}
          </button>
        )}
      </div>

      {adding && (
        <form className="track-add" onSubmit={submitAdd}>
          <input
            className="input compact"
            placeholder="name (e.g. lead)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={32}
            aria-label="New track name"
            autoFocus
          />
          <select
            className="input compact"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            aria-label="Track type"
          >
            {Object.entries(TRACK_TEMPLATES).map(([k, t]) => (
              <option key={k} value={k}>
                {t.label}
              </option>
            ))}
          </select>
          <button className="btn primary small">Add</button>
        </form>
      )}

      {parsed.tracks.length === 0 && (
        <p className="muted small">
          No tracks yet. A track is a labeled pattern like <code>bass: note("c2")</code>.
        </p>
      )}

      <ul className="tracks">
        {parsed.tracks.map((t) => (
          <li
            key={`${t.index}-${t.label}`}
            className={`track ${t.muted || (anySolo && !t.solo) ? 'silent' : ''}`}
          >
            <div className="track-head">
              <button
                className={`toggle ${t.muted ? 'on mute' : ''}`}
                disabled={readOnly}
                title={t.muted ? 'Unmute' : 'Mute'}
                aria-pressed={t.muted}
                aria-label={`Mute ${t.name}`}
                onClick={() => apply(() => setTrackMuted(code, t.index, !t.muted))}
              >
                M
              </button>
              <button
                className={`toggle ${t.solo ? 'on solo' : ''}`}
                disabled={readOnly}
                title={t.solo ? 'Unsolo' : 'Solo'}
                aria-pressed={t.solo}
                aria-label={`Solo ${t.name}`}
                onClick={() => apply(() => setTrackSolo(code, t.index, !t.solo))}
              >
                S
              </button>
              {renaming === t.index ? (
                <form onSubmit={(e) => submitRename(e, t.index)} className="grow">
                  <input
                    className="input compact"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => setRenaming(null)}
                    maxLength={32}
                    aria-label="Track name"
                    autoFocus
                  />
                </form>
              ) : (
                <button
                  className="track-name"
                  disabled={readOnly}
                  title="Rename"
                  onClick={() => {
                    setRenaming(t.index);
                    setRenameValue(t.name === '$' ? '' : t.name);
                  }}
                >
                  {t.name === '$' ? `track ${t.index + 1}` : t.name}
                </button>
              )}
              {!readOnly && onAskAgent && (
                <button
                  className="icon-btn"
                  title="Ask the agent to change this track"
                  aria-label={`Ask agent about ${t.name}`}
                  onClick={() => onAskAgent(t.name)}
                >
                  ✦
                </button>
              )}
              {!readOnly && (
                <button
                  className="icon-btn"
                  title="Remove track"
                  aria-label={`Remove ${t.name}`}
                  onClick={() => {
                    if (confirm(`Remove track "${t.name}"?`)) apply(() => removeTrack(code, t.index));
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <InstrumentSelect
              track={t}
              disabled={readOnly}
              onPick={(v) =>
                apply(() =>
                  v.startsWith('bank:')
                    ? setTrackBank(code, t.index, v.slice(5))
                    : setTrackInstrument(code, t.index, v),
                )
              }
            />
          </li>
        ))}
      </ul>
      {error && <p className="alert error small">{error}</p>}
    </div>
  );
}
