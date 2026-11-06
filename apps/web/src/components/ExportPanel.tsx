import {
  cyclesPerSecond,
  estimateBars,
  EXPORT_FORMATS,
  exportFileName,
  isExportedAudio,
  MAX_EXPORT_BARS,
  midiExportToSpec,
  writeMidi,
  type ExportFormat,
} from '@s-maker/shared';
import { useMemo, useState } from 'react';
import { errorMessage } from '../api';
import type { ExportStage, StrudelPlayerHandle } from './StrudelPlayer';

interface Props {
  title: string;
  code: string;
  player: StrudelPlayerHandle | null;
  onClose(): void;
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  mp3: 'MP3: small file',
  wav: 'WAV: full quality',
  midi: 'MIDI: notes only',
};

const STAGE_LABEL: Record<ExportStage, string> = {
  sounds: 'Loading sounds…',
  render: 'Rendering…',
  encode: 'Writing the file…',
};

const MIME: Record<ExportFormat, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', midi: 'audio/midi' };

function saveFile(bytes: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const megabytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Makes a file in the browser and saves it on this device. Nothing is sent to the server. */
export function ExportPanel({ title, code, player, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>('mp3');
  const [bars, setBars] = useState(() => estimateBars(code));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const cps = useMemo(() => cyclesPerSecond(code), [code]);
  const seconds = cps ? Math.round(bars / cps) : null;
  const validBars = Number.isInteger(bars) && bars >= 1 && bars <= MAX_EXPORT_BARS;

  const run = async () => {
    if (!player || !validBars) return;
    setError(null);
    setDone(null);
    setStatus('Starting…');
    try {
      const result = await player.exportSong(code, format, bars, (stage) => setStatus(STAGE_LABEL[stage]));
      const name = exportFileName(title, format);
      let size: number;
      let note = '';
      if (format === 'midi') {
        if (!result.midi?.tracks.length) throw new Error('This song has no notes that MIDI can hold.');
        const bytes = writeMidi(midiExportToSpec(result.midi));
        size = bytes.length;
        saveFile(new Uint8Array(bytes), name, MIME.midi);
        if (result.midi.skipped) note = ` Left out ${result.midi.skipped} events that MIDI cannot hold.`;
      } else {
        if (!result.bytes || !isExportedAudio(format, result.bytes))
          throw new Error('The player returned something that is not an audio file.');
        size = result.bytes.byteLength;
        saveFile(result.bytes, name, MIME[format]);
      }
      setDone(`Saved ${name} (${megabytes(size)}).${note}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus(null);
    }
  };

  return (
    <aside className="history export-panel" aria-label="Export">
      <div className="row">
        <h3>Export</h3>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Close export" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="muted small">
        Exports what is in the editor. The file is made in your browser and saved on this device; nothing is
        sent to the server.
      </p>
      <label className="field">
        <span className="field-label">Format</span>
        <select
          className="input compact"
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
          disabled={!!status}
        >
          {EXPORT_FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABEL[f]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Length in bars</span>
        <input
          className="input compact"
          type="number"
          min={1}
          max={MAX_EXPORT_BARS}
          step={1}
          value={Number.isNaN(bars) ? '' : bars}
          onChange={(e) => setBars(e.target.valueAsNumber)}
          disabled={!!status}
        />
      </label>
      {seconds !== null && validBars && <p className="muted small">About {seconds} s of music.</p>}
      {format === 'midi' && (
        <p className="muted small">
          MIDI holds notes, lengths, dynamics and instruments. Effects and synth sounds are not part of it.
        </p>
      )}
      {format !== 'midi' && (
        <p className="muted small">
          Playback stops during the export. Long songs can run out of memory on phones.
        </p>
      )}
      <button className="btn primary" onClick={() => void run()} disabled={!!status || !validBars || !player}>
        {status ?? `Export ${format === 'midi' ? 'MIDI' : format.toUpperCase()}`}
      </button>
      {error && <p className="alert error small">{error}</p>}
      {done && <p className="alert ok small">{done}</p>}
    </aside>
  );
}
