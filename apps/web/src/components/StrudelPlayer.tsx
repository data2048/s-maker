import {
  DEFAULT_EDITOR_SETTINGS,
  editorSettingsSchema,
  fromSandboxSchema,
  SANDBOX_PATH,
  type EditorSettings,
  type ToSandbox,
} from '@s-maker/shared';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

const SETTINGS_KEY = 'smaker.editor.settings';

/** Editor preferences live in the app's localStorage; the sandboxed player cannot store anything. */
function loadSettings(): EditorSettings {
  try {
    const parsed = editorSettingsSchema.safeParse(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'));
    return parsed.success ? parsed.data : DEFAULT_EDITOR_SETTINGS;
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

export interface PlayerState {
  ready: boolean;
  started: boolean;
  pending: boolean;
  error: string | null;
}

export interface StrudelPlayerHandle {
  play(): void;
  stop(): void;
  setCode(code: string): void;
}

interface Props {
  /** Code loaded into the editor when the player is ready (and whenever this prop changes). */
  code: string;
  onCodeChange?(code: string): void;
  onStateChange?(state: PlayerState): void;
  /** Ctrl+S pressed inside the player. */
  onSave?(): void;
  className?: string;
}

/**
 * Strudel editor + audio, isolated in a sandboxed iframe.
 *
 * sandbox="allow-scripts" without allow-same-origin gives the frame an opaque origin: song code (which is
 * JavaScript, possibly written by someone else or by the LLM) cannot read our cookies, call the API
 * as the user or touch this page. We only exchange validated messages with it.
 */
export const StrudelPlayer = forwardRef<StrudelPlayerHandle, Props>(function StrudelPlayer(
  { code, onCodeChange, onStateChange, onSave, className },
  ref,
) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const lastSent = useRef<string | null>(null);
  const callbacks = useRef({ onCodeChange, onStateChange, onSave });
  callbacks.current = { onCodeChange, onStateChange, onSave };

  const post = (msg: ToSandbox) => {
    // The frame's origin is opaque, so '*' is the only possible target. We send only song code.
    frame.current?.contentWindow?.postMessage(msg, '*');
  };

  useImperativeHandle(ref, () => ({
    play: () => post({ type: 'play' }),
    stop: () => post({ type: 'stop' }),
    setCode: (c: string) => {
      lastSent.current = c;
      post({ type: 'setCode', code: c });
    },
  }));

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const parsed = fromSandboxSchema.safeParse(event.data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'ready') {
        post({ type: 'settings', settings: loadSettings() });
        setReady(true);
        callbacks.current.onStateChange?.({ ready: true, started: false, pending: false, error: null });
      } else if (msg.type === 'state') {
        callbacks.current.onStateChange?.({ ready: true, ...msg });
      } else if (msg.type === 'command') {
        if (msg.command === 'save') callbacks.current.onSave?.();
      } else if (msg.type === 'settings') {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(msg.settings));
      } else if (msg.type === 'code') {
        lastSent.current = msg.code;
        callbacks.current.onCodeChange?.(msg.code);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Push code to the frame when it is ready or when the prop changes from outside (not our own echo).
  useEffect(() => {
    if (ready && code !== lastSent.current) {
      lastSent.current = code;
      post({ type: 'setCode', code });
    }
  }, [ready, code]);

  // Stop the music when the component unmounts (navigating away).
  useEffect(() => () => post({ type: 'stop' }), []);

  return (
    <iframe
      ref={frame}
      className={className ?? 'strudel-frame'}
      src={SANDBOX_PATH}
      title="Strudel player"
      sandbox="allow-scripts"
      allow="autoplay"
      referrerPolicy="no-referrer"
    />
  );
});
