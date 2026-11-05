// Entry of the sandboxed Strudel player (sandbox.html). Runs in an iframe with an opaque origin:
// no cookies, no access to the app page or the API. It talks to the app only via postMessage.
import './storage-shim';
import './sandbox.css';
import { fromSandboxSchema, toSandboxSchema, type FromSandbox } from '@s-maker/shared';
import { StrudelMirror } from '@strudel/codemirror';
import { getDrawContext } from '@strudel/draw';
import { transpiler } from '@strudel/transpiler';
import { getAudioContext, initAudioOnFirstClick, webaudioOutput } from '@strudel/webaudio';
import { prebake } from './prebake';

interface ReplState {
  code: string;
  started: boolean;
  pending: boolean;
  error?: { message?: string } | string | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const playBtn = $<HTMLButtonElement>('play');
const stopBtn = $<HTMLButtonElement>('stop');
const statusEl = $('status');
const errorEl = $('error');

const embedded = window.parent !== window;
function send(msg: FromSandbox): void {
  // The parent cannot be identified by origin from an opaque-origin frame, hence '*'.
  // Only song code and player state are ever sent.
  if (embedded) window.parent.postMessage(fromSandboxSchema.parse(msg), '*');
}

initAudioOnFirstClick();

let lastCodeFromParent = '';
let codeTimer: ReturnType<typeof setTimeout> | undefined;
let lastState = '';

const editor = new StrudelMirror({
  root: $('editor'),
  initialCode: '',
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  drawContext: getDrawContext(),
  drawTime: [-2, 2],
  prebake,
  solo: true,
  onUpdateState: (state: ReplState) => {
    const error =
      state.error == null
        ? null
        : typeof state.error === 'string'
          ? state.error
          : (state.error.message ?? 'Error');
    renderState(state.started, state.pending, error);

    const key = JSON.stringify([state.started, state.pending, error]);
    if (key !== lastState) {
      lastState = key;
      send({
        type: 'state',
        started: state.started,
        pending: state.pending,
        error: error?.slice(0, 2000) ?? null,
      });
    }

    // Report edits made in the editor (debounced); skip the echo of code the parent just set.
    if (state.code !== lastCodeFromParent) {
      clearTimeout(codeTimer);
      codeTimer = setTimeout(() => {
        lastCodeFromParent = state.code;
        send({ type: 'code', code: state.code });
      }, 300);
    }
  },
});

editor.updateSettings({ fontSize: 15, fontFamily: "ui-monospace, 'Cascadia Code', Menlo, monospace" });

function renderState(started: boolean, pending: boolean, error: string | null): void {
  playBtn.textContent = started ? 'Update' : 'Play';
  playBtn.disabled = pending;
  stopBtn.disabled = !started;
  statusEl.textContent = pending ? 'loading sounds…' : started ? 'playing' : '';
  errorEl.hidden = !error;
  errorEl.textContent = error ?? '';
}

playBtn.addEventListener('click', () => void editor.evaluate());
stopBtn.addEventListener('click', () => void editor.stop());

window.addEventListener('message', (event: MessageEvent) => {
  // Accept commands only from the page that embeds us.
  if (event.source !== window.parent) return;
  const parsed = toSandboxSchema.safeParse(event.data);
  if (!parsed.success) return;
  const msg = parsed.data;
  switch (msg.type) {
    case 'setCode':
      lastCodeFromParent = msg.code;
      editor.setCode(msg.code);
      break;
    case 'play':
      void editor.evaluate();
      break;
    case 'stop':
      void editor.stop();
      break;
  }
});

renderState(false, false, null);
send({ type: 'ready' });
