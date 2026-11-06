import type { AgentProposalDto } from '@s-maker/shared';
import { useCallback, useState } from 'react';
import { api, errorMessage } from '../api';

export interface ProposalHandlers {
  songId: number;
  /** Tries code in the sandboxed player without playing it. Returns the problem, or null. */
  checkCode(code: string): Promise<string | null>;
  /** Puts code in the editor for listening. */
  onListen(code: string): void;
  onAccepted(result: { songCode: string; versionId: number }): void;
  /** Called after a rejection so the editor can go back to the code before the proposal. */
  onRejected(baseCode: string): void;
}

/** A change from the agent on its way to the user, whether it came from a command or the chat. */
export function useAgentProposal(h: ProposalHandlers) {
  const { songId, checkCode } = h;
  const [proposal, setProposal] = useState<AgentProposalDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Grows whenever money may have been spent. */
  const [spent, setSpent] = useState(0);

  /** Tries the proposal in the player and lets the model fix what fails there. */
  const tryInPlayer = useCallback(
    async (start: AgentProposalDto): Promise<AgentProposalDto> => {
      let current = start;
      for (let i = current.repairs; i < 2; i++) {
        setBusy('Trying it in the player…');
        const problem = await checkCode(current.code);
        if (!problem) return current;
        setBusy('Fixing an error…');
        current = await api<AgentProposalDto>(
          'POST',
          `/api/songs/${songId}/agent/proposals/${current.id}/repair`,
          { error: problem },
        );
      }
      const problem = await checkCode(current.code);
      if (problem) setError(`This proposal may not play correctly: ${problem}`);
      return current;
    },
    [checkCode, songId],
  );

  /** Checks a new proposal and puts it in the editor for listening. */
  const present = async (p: AgentProposalDto) => {
    setProposal(null);
    setBusy('Trying it in the player…');
    try {
      const checked = await tryInPlayer(p);
      setProposal(checked);
      h.onListen(checked.code);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      setSpent((n) => n + 1);
    }
  };

  const accept = async () => {
    if (!proposal) return;
    setBusy('Saving…');
    setError(null);
    try {
      const r = await api<{ version: { id: number; code: string } }>(
        'POST',
        `/api/songs/${songId}/agent/proposals/${proposal.id}/accept`,
      );
      h.onAccepted({ songCode: r.version.code, versionId: r.version.id });
      setProposal(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!proposal) return;
    const base = proposal.baseCode;
    setProposal(null);
    h.onRejected(base);
    await api('POST', `/api/songs/${songId}/agent/proposals/${proposal.id}/reject`).catch(() => {});
  };

  return { proposal, busy, setBusy, error, setError, spent, setSpent, present, accept, reject };
}

export type AgentProposalState = ReturnType<typeof useAgentProposal>;
