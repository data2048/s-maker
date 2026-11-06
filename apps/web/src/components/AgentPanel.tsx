import { diffLines, type AgentProposalDto, type AgentUsageDto, type ModelTier } from '@s-maker/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import type { AgentProposalState } from './useAgentProposal';

interface Props {
  songId: number;
  code: string;
  baseVersionId: number;
  trackNames: string[];
  sectionNames: string[];
  /** Asked for from the mixer: limit the change to this track. */
  focusTrack: string | null;
  onFocusTrack(track: string | null): void;
  agent: AgentProposalState;
}

const SECTION_PREFIX = 'section:';

export const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** Gives the agent an instruction and shows its proposal as a diff to accept or reject. */
export function AgentPanel(props: Props) {
  const { songId, code, baseVersionId, trackNames, sectionNames, focusTrack, agent } = props;
  const { proposal, busy, error, spent } = agent;
  const [usage, setUsage] = useState<AgentUsageDto | null>(null);
  const [instruction, setInstruction] = useState('');
  const [tier, setTier] = useState<ModelTier>('fast');

  const loadUsage = useCallback(() => {
    api<AgentUsageDto>('GET', '/api/agent/usage')
      .then(setUsage)
      .catch(() => {});
  }, []);
  useEffect(loadUsage, [loadUsage, spent]);

  const ask = async () => {
    if (!instruction.trim() || busy) return;
    agent.setError(null);
    agent.setBusy('The agent is working…');
    const scope = focusTrack?.startsWith(SECTION_PREFIX)
      ? { section: focusTrack.slice(SECTION_PREFIX.length) }
      : focusTrack
        ? { track: focusTrack }
        : {};
    try {
      const first = await api<AgentProposalDto>('POST', `/api/songs/${songId}/agent/proposals`, {
        instruction,
        tier,
        code,
        baseVersionId,
        ...scope,
      });
      setInstruction('');
      await agent.present(first);
    } catch (e) {
      agent.setError(errorMessage(e));
      agent.setBusy(null);
      loadUsage();
    }
  };

  const diff = useMemo(
    () => (proposal ? diffLines(proposal.baseCode, proposal.code).filter((l) => l.type !== 'same') : []),
    [proposal],
  );

  if (usage && !usage.enabled) {
    return <p className="muted small agent-off">The agent is not configured on this server.</p>;
  }
  const overLimit =
    !!usage && (usage.spentUsd >= usage.limitUsd || usage.groupSpentUsd >= usage.groupLimitUsd);

  return (
    <section className="agent" aria-label="Agent">
      <form
        className="row wrap agent-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <select
          className="input compact"
          value={focusTrack ?? ''}
          onChange={(e) => props.onFocusTrack(e.target.value || null)}
          aria-label="Agent scope"
        >
          <option value="">Whole song</option>
          {trackNames.map((t) => (
            <option key={t} value={t}>
              Track: {t}
            </option>
          ))}
          {sectionNames.map((s) => (
            <option key={s} value={`${SECTION_PREFIX}${s}`}>
              Section: {s}
            </option>
          ))}
        </select>
        <input
          className="input compact grow"
          placeholder="Tell the agent what to change, in any language"
          value={instruction}
          maxLength={2000}
          onChange={(e) => setInstruction(e.target.value)}
          aria-label="Instruction for the agent"
          disabled={!!busy}
        />
        <select
          className="input compact"
          value={tier}
          onChange={(e) => setTier(e.target.value as ModelTier)}
          aria-label="Agent model"
          title="Strong costs more; use it for bigger changes"
        >
          <option value="fast">Fast</option>
          <option value="strong">Strong</option>
        </select>
        <button className="btn primary" disabled={!!busy || !instruction.trim() || overLimit}>
          {busy ?? 'Ask agent'}
        </button>
        {usage && (
          <span className="muted small" title="Spent in the last 7 days">
            {money(usage.spentUsd)} / {money(usage.limitUsd)}
          </span>
        )}
      </form>
      {overLimit && <p className="alert warn small">The weekly agent limit is used up.</p>}
      {error && <p className="alert error small">{error}</p>}
      {proposal && (
        <div className="proposal">
          <div className="row wrap">
            <strong className="grow">{proposal.summary}</strong>
            <span className="muted small">
              {proposal.model} · {money(proposal.costUsd)}
            </span>
            <button
              className="btn small primary"
              onClick={() => {
                void agent.accept();
                props.onFocusTrack(null);
              }}
              disabled={!!busy}
            >
              Accept
            </button>
            <button className="btn small" onClick={() => void agent.reject()} disabled={!!busy}>
              Reject
            </button>
          </div>
          <p className="muted small">It is in the editor now: press Play to listen.</p>
          <pre className="diff agent-diff">
            {diff.map((l, i) => (
              <div key={i} className={l.type === 'add' ? 'diff-add' : 'diff-del'}>
                {l.type === 'add' ? '+ ' : '- '}
                {l.text}
              </div>
            ))}
            {diff.length === 0 && <div className="muted">No changes.</div>}
          </pre>
        </div>
      )}
    </section>
  );
}
