import type { AgentChatMessageDto, AgentStreamEvent, ModelTier, MusicBrief } from '@s-maker/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, streamApi } from '../api';
import type { AgentProposalState } from './useAgentProposal';

interface Props {
  songId: number;
  code: string;
  baseVersionId: number;
  agent: AgentProposalState;
  onBriefChanged(brief: MusicBrief): void;
  onClose(): void;
}

const STATUS_LABEL = { pending: 'waiting for you', accepted: 'accepted', rejected: 'rejected' };

/** A conversation with the agent about the song. Changes it proposes appear above the editor. */
export function ChatPanel({ songId, code, baseVersionId, agent, onBriefChanged, onClose }: Props) {
  const [messages, setMessages] = useState<AgentChatMessageDto[] | null>(null);
  const [text, setText] = useState('');
  const [tier, setTier] = useState<ModelTier>('fast');
  const [status, setStatus] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = !!status || !!agent.busy;

  useEffect(() => {
    api<{ messages: AgentChatMessageDto[] }>('GET', `/api/songs/${songId}/agent/chat`)
      .then((r) => setMessages(r.messages))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [songId, agent.proposal?.id, agent.proposal?.status]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, partial]);

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setPartial('');
    setText('');
    setStatus('The agent is working…');
    const optimistic: AgentChatMessageDto = {
      id: -Date.now(),
      role: 'user',
      content: message,
      at: new Date().toISOString(),
      proposalId: null,
      proposalStatus: null,
    };
    setMessages((m) => [...(m ?? []), optimistic]);
    const onEvent = (event: AgentStreamEvent) => {
      if (event.type === 'status') setStatus(event.text);
      else if (event.type === 'delta') setPartial((p) => p + event.text);
      else if (event.type === 'reset') setPartial('');
      else if (event.type === 'error') setError(event.error);
      else if (event.type === 'done') {
        const answer = event.message;
        if (answer) setMessages((m) => [...(m ?? []), answer]);
        if (event.brief) onBriefChanged(event.brief);
        if (event.proposal) void agent.present(event.proposal);
      }
    };
    try {
      await streamApi(`/api/songs/${songId}/agent/chat`, { message, tier, code, baseVersionId }, onEvent);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus(null);
      setPartial('');
      agent.setSpent((n) => n + 1);
    }
  };

  return (
    <aside className="history chat-panel" aria-label="Chat with the agent">
      <div className="row">
        <h3>Chat with the agent</h3>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Close chat" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="chat-log" role="log" aria-live="polite">
        {messages?.length === 0 && (
          <p className="muted small">
            Ask about the song, talk through ideas, or ask for a change. You listen to every change before it
            is saved.
          </p>
        )}
        {messages?.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.content}
            {m.proposalStatus && (
              <span className="muted small chat-status"> · {STATUS_LABEL[m.proposalStatus]}</span>
            )}
          </div>
        ))}
        {partial && <div className="chat-msg assistant">{partial}</div>}
        {status && !partial && <p className="muted small">{status}</p>}
        <div ref={end} />
      </div>
      {error && <p className="alert error small">{error}</p>}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          className="input compact"
          rows={2}
          maxLength={2000}
          placeholder="Write in any language. Enter sends, Shift+Enter adds a line."
          aria-label="Message to the agent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="row">
          <select
            className="input compact"
            value={tier}
            onChange={(e) => setTier(e.target.value as ModelTier)}
            aria-label="Chat model"
            title="Strong costs more; use it for bigger changes"
          >
            <option value="fast">Fast</option>
            <option value="strong">Strong</option>
          </select>
          <span className="spacer" />
          <button className="btn primary small" disabled={busy || !text.trim()}>
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}
