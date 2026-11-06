import {
  MAX_BRIEF_ELEMENT_LENGTH,
  MUSIC_ELEMENT_HINTS,
  MUSIC_ELEMENTS,
  type MusicBrief,
  type MusicElement,
} from '@s-maker/shared';
import { useState } from 'react';

interface Props {
  brief: MusicBrief | null;
  canEdit: boolean;
  onSave(brief: MusicBrief): Promise<void>;
  onClose(): void;
}

const label = (e: MusicElement) => e.charAt(0).toUpperCase() + e.slice(1);

/** The song's Music Brief: the 14 musical elements, read by the agent. */
export function BriefPanel({ brief, canEdit, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<MusicBrief>(brief ?? {});
  const [saving, setSaving] = useState(false);
  const dirty = MUSIC_ELEMENTS.some((e) => (draft[e] ?? '') !== (brief?.[e] ?? ''));

  const save = async () => {
    setSaving(true);
    try {
      const clean = Object.fromEntries(
        MUSIC_ELEMENTS.flatMap((e) => (draft[e]?.trim() ? [[e, draft[e]!.trim()]] : [])),
      ) as MusicBrief;
      await onSave(clean);
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="history brief-panel" aria-label="Music brief">
      <div className="row">
        <h3>Music brief</h3>
        <span className="spacer" />
        {canEdit && (
          <button className="btn small primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save brief' : 'Saved'}
          </button>
        )}
        <button className="icon-btn" aria-label="Close brief" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="brief-fields">
        {MUSIC_ELEMENTS.map((e) => (
          <label key={e} className="brief-field">
            <span className="field-label">{label(e)}</span>
            {canEdit ? (
              <textarea
                className="input compact"
                rows={2}
                maxLength={MAX_BRIEF_ELEMENT_LENGTH}
                placeholder={MUSIC_ELEMENT_HINTS[e]}
                value={draft[e] ?? ''}
                onChange={(ev) => setDraft({ ...draft, [e]: ev.target.value })}
              />
            ) : (
              <span className="small">{brief?.[e] || <span className="muted">not set</span>}</span>
            )}
          </label>
        ))}
      </div>
    </aside>
  );
}
