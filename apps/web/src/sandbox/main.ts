// Entry of the sandboxed Strudel player (sandbox.html). Runs in an iframe with an opaque origin:
// no cookies, no access to the app page or the API. It talks to the app only via postMessage.
import './storage-shim';
import './sandbox.css';
import {
  DEFAULT_EDITOR_SETTINGS,
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  editorSettingsSchema,
  fromSandboxSchema,
  toSandboxSchema,
  type EditorSettings,
  type FromSandbox,
} from '@s-maker/shared';
import { codemirrorSettings, StrudelMirror } from '@strudel/codemirror';
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
const smallerBtn = $<HTMLButtonElement>('font-smaller');
const biggerBtn = $<HTMLButtonElement>('font-bigger');
const fontSizeEl = $('font-size');
const wrapBtn = $<HTMLButtonElement>('wrap');

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

// ---------- editor preferences ----------

let settings: EditorSettings = { ...DEFAULT_EDITOR_SETTINGS };

function applySettings(next: EditorSettings): void {
  settings = next;
  // updateSettings() reconfigures every editor extension from the object it gets, so always pass the
  // full settings (otherwise pattern highlighting, line numbers etc. get switched off).
  editor.updateSettings({
    ...codemirrorSettings.get(),
    isPatternHighlightingEnabled: true,
    isFlashEnabled: true,
    isLineNumbersDisplayed: true,
    fontFamily: "ui-monospace, 'Cascadia Code', Menlo, monospace",
    fontSize: settings.fontSize,
    isLineWrappingEnabled: settings.lineWrap,
  });
  fontSizeEl.textContent = String(settings.fontSize);
  smallerBtn.disabled = settings.fontSize <= EDITOR_FONT_MIN;
  biggerBtn.disabled = settings.fontSize >= EDITOR_FONT_MAX;
  wrapBtn.setAttribute('aria-pressed', String(settings.lineWrap));
}

function changeSettings(patch: Partial<EditorSettings>): void {
  const next = editorSettingsSchema.parse({ ...settings, ...patch });
  applySettings(next);
  send({ type: 'settings', settings: next });
}

smallerBtn.addEventListener('click', () => changeSettings({ fontSize: settings.fontSize - 1 }));
biggerBtn.addEventListener('click', () => changeSettings({ fontSize: settings.fontSize + 1 }));
wrapBtn.addEventListener('click', () => changeSettings({ lineWrap: !settings.lineWrap }));

applySettings(settings);

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
    case 'settings':
      applySettings(msg.settings);
      break;
  }
});

renderState(false, false, null);
send({ type: 'ready' });
