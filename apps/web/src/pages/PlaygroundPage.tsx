import { validateStrudelCode, type ValidationIssue } from '@s-maker/shared';
import { useEffect, useRef, useState } from 'react';
import { StrudelPlayer, type PlayerState, type StrudelPlayerHandle } from '../components/StrudelPlayer';
import { EXAMPLES } from '../examples';

const STORAGE_KEY = 'smaker.playground.code';

export function PlaygroundPage() {
  const [code, setCode] = useState(() => localStorage.getItem(STORAGE_KEY) ?? EXAMPLES[0]!.code);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [state, setState] = useState<PlayerState>({
    ready: false,
    started: false,
    pending: false,
    error: null,
  });
  const player = useRef<StrudelPlayerHandle>(null);

  // Check the code while typing (debounced). The sandbox runs it anyway; this explains problems early.
  useEffect(() => {
    const t = setTimeout(() => {
      setIssues(validateStrudelCode(code, 'lenient').issues);
      localStorage.setItem(STORAGE_KEY, code);
    }, 300);
    return () => clearTimeout(t);
  }, [code]);

  const loadExample = (name: string) => {
    const ex = EXAMPLES.find((e) => e.name === name);
    if (ex) setCode(ex.code);
  };

  return (
    <section className="playground">
      <div className="playground-head">
        <h1>Playground</h1>
        <span className="muted small">
          {!state.ready
            ? 'starting player…'
            : state.pending
              ? 'loading…'
              : state.started
                ? '● playing'
                : 'stopped'}
        </span>
        <div className="spacer" />
        <select
          className="input"
          value=""
          onChange={(e) => loadExample(e.target.value)}
          aria-label="Load example"
        >
          <option value="" disabled>
            Load example…
          </option>
          {EXAMPLES.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      <StrudelPlayer
        ref={player}
        code={code}
        onCodeChange={setCode}
        onStateChange={setState}
        className="strudel-frame"
      />

      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i, idx) => (
            <li key={idx} className={i.severity}>
              <span className="mono">
                {i.line}:{i.column}
              </span>{' '}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Learn Strudel in the{' '}
        <a href="https://strudel.cc/workshop/getting-started/" target="_blank" rel="noreferrer">
          workshop
        </a>
        . Code runs in an isolated sandbox.
      </p>
    </section>
  );
}
