import type { AgentModelOption, AgentModelsDto, ModelTier } from '@s-maker/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';

const PICKED = 'model:';

/** Which model the next request goes to: a tier, or a model the admin chose by name. */
export function useModelChoice(defaultTier: ModelTier) {
  const [value, setValue] = useState<string>(defaultTier);
  const [data, setData] = useState<AgentModelsDto>({ canPick: false, models: [] });

  const reload = useCallback(
    () =>
      api<AgentModelsDto>('GET', '/api/agent/models')
        .then(setData)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const picked = value.startsWith(PICKED) ? value.slice(PICKED.length) : null;
  // A model taken off the list can no longer be used.
  useEffect(() => {
    if (picked && !data.models.some((m) => m.id === picked)) setValue(defaultTier);
  }, [picked, data.models, defaultTier]);

  const request = useMemo(
    () => (picked ? { tier: defaultTier, model: picked } : { tier: value as ModelTier }),
    [picked, value, defaultTier],
  );

  return { value, setValue, data, setData, request };
}

export type ModelChoice = ReturnType<typeof useModelChoice>;

const price = (usd: number | null) => (usd === null ? '?' : `$${usd}`);
const priceLabel = (m: AgentModelOption) =>
  `${price(m.promptUsdPerM)} in / ${price(m.completionUsdPerM)} out per 1M tokens`;

interface Props {
  choice: ModelChoice;
  label: string;
  title?: string;
  disabled?: boolean;
  tiers?: { value: ModelTier; label: string }[];
}

const DEFAULT_TIERS: { value: ModelTier; label: string }[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'strong', label: 'Strong' },
];

export function ModelSelect({ choice, label, title, disabled, tiers = DEFAULT_TIERS }: Props) {
  const [managing, setManaging] = useState(false);
  const { data } = choice;
  return (
    <>
      <select
        className="input compact model-select"
        value={choice.value}
        onChange={(e) => choice.setValue(e.target.value)}
        aria-label={label}
        disabled={disabled}
        {...(title ? { title } : {})}
      >
        {tiers.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
        {data.models.length > 0 && (
          <optgroup label="Chosen models">
            {data.models.map((m) => (
              <option key={m.id} value={`${PICKED}${m.id}`} title={priceLabel(m)}>
                {m.id}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {data.canPick && (
        <button
          type="button"
          className="btn small"
          aria-expanded={managing}
          onClick={() => setManaging((open) => !open)}
        >
          Models…
        </button>
      )}
      {managing && <ModelManager choice={choice} />}
    </>
  );
}

/** Admin: which models can be chosen. Lives next to the choice, because that is where it is needed. */
function ModelManager({ choice }: { choice: ModelChoice }) {
  const [catalog, setCatalog] = useState<AgentModelOption[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listed = choice.data.models;

  useEffect(() => {
    api<{ models: AgentModelOption[] }>('GET', '/api/admin/agent/catalog')
      .then((r) => setCatalog(r.models))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  const typed = catalog.find((m) => m.id === text.trim());

  const save = async (models: string[]): Promise<boolean> => {
    setError(null);
    try {
      await api('PUT', '/api/admin/agent/models', { models });
      const known = (id: string) =>
        catalog.find((m) => m.id === id) ??
        listed.find((m) => m.id === id) ?? { id, promptUsdPerM: null, completionUsdPerM: null };
      choice.setData({ canPick: true, models: models.map(known) });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const add = async () => {
    const id = text.trim();
    if (!id) return;
    if (await save([...listed.map((m) => m.id).filter((m) => m !== id), id])) {
      setText('');
      choice.setValue(`${PICKED}${id}`);
    }
  };

  return (
    <div className="model-manager">
      {listed.length > 0 && (
        <ul>
          {listed.map((m) => (
            <li key={m.id} className="row">
              <span className="mono small grow">{m.id}</span>
              <span className="muted small">{priceLabel(m)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${m.id}`}
                onClick={() => void save(listed.filter((x) => x.id !== m.id).map((x) => x.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap">
        <input
          className="input compact grow"
          list="openrouter-models"
          placeholder="Model from OpenRouter, for example provider/model"
          aria-label="Model to add"
          value={text}
          maxLength={120}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // This sits inside the form that sends the request to the agent.
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <datalist id="openrouter-models">
          {catalog.map((m) => (
            <option key={m.id} value={m.id} label={priceLabel(m)} />
          ))}
        </datalist>
        <button type="button" className="btn small" disabled={!text.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      {typed && <p className="muted small">{priceLabel(typed)}</p>}
      {error && <p className="alert error small">{error}</p>}
    </div>
  );
}
