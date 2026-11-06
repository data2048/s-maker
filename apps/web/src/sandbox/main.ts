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
  type ToSandbox,
  isValidNote,
  parseTracks,
} from '@s-maker/shared';
import { codemirrorSettings, StrudelMirror } from '@strudel/codemirror';
import { getDrawContext } from '@strudel/draw';
import { evaluate as evaluateCode, transpiler } from '@strudel/transpiler';
import { getAudioContext, initAudioOnFirstClick, soundMap, webaudioOutput } from '@strudel/webaudio';
import { exportAudio, exportMidi, withTempoStub } from './export';
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
function send(msg: FromSandbox, transfer: Transferable[] = []): void {
  // The parent cannot be identified by origin from an opaque-origin frame, hence '*'.
  // Only song code, player state and exported files are ever sent.
  if (embedded) window.parent.postMessage(fromSandboxSchema.parse(msg), '*', transfer);
}

initAudioOnFirstClick();

let exporting = false;

// Browsers start audio only from a user's action, and phones are strict about which one: Strudel listens only
// for mousedown. The context can also be suspended later, for example by a phone call, so keep listening.
function resumeAudio(): void {
  if (exporting) return;
  const context = getAudioContext();
  if (context.state !== 'running') void context.resume().catch(() => {});
}
for (const event of ['pointerup', 'touchend', 'click', 'keydown']) {
  document.addEventListener(event, resumeAudio, { capture: true, passive: true });
}

let lastCodeFromParent = '';
let codeTimer: ReturnType<typeof setTimeout> | undefined;
let lastState = '';
let isPlaying = false;

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
  isPlaying = started;
  playBtn.textContent = started ? 'Update' : 'Play';
  playBtn.disabled = pending;
  stopBtn.disabled = !started;
  statusEl.textContent = pending ? 'loading sounds…' : started ? 'playing' : '';
  errorEl.hidden = !error;
  errorEl.textContent = error ?? '';
}

playBtn.addEventListener('click', () => void editor.evaluate());
stopBtn.addEventListener('click', () => void editor.stop());

// Ctrl+S asks the app to save. Ctrl+Enter (Cmd+Enter on Mac) toggles play/stop. Strudel's own binding (kept for Alt+Enter) re-evaluates
// the code, i.e. applies changes while playing. Capture phase: runs before CodeMirror's keymap.
document.addEventListener(
  'keydown',
  (e) => {
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      send({ type: 'command', command: 'save' });
      return;
    }
    if (e.key !== 'Enter' || !mod) return;
    e.preventDefault();
    e.stopPropagation();
    void (isPlaying ? editor.stop() : editor.evaluate());
  },
  true,
);

// ---------- trying code without playing it ----------

const CHECK_CYCLES = 8;
/** A track may stay silent for a while: look this far before saying it plays nothing. */
const CHECK_CYCLES_SILENT = 64;

interface CheckHap {
  value: { s?: unknown; bank?: unknown; note?: unknown } | null;
}

/** Evaluates every track on its own and looks at its first cycles. Returns the first problem, or null. */
async function checkCode(code: string): Promise<string | null> {
  const parsed = parseTracks(code);
  if (!parsed.ok) return `Syntax error: ${parsed.error}`;
  await (editor as { prebaked?: Promise<unknown> }).prebaked;
  const first = parsed.tracks[0];
  const header = first ? code.slice(0, first.range[0]) : code;
  const sounds = soundMap.get() as Record<string, unknown>;
  // Trying a song must not change the tempo of what is playing.
  return withTempoStub(
    () => {},
    async () => {
      for (const track of parsed.tracks) {
        try {
          const { pattern } = (await evaluateCode(`${header}\n${track.body}`)) as {
            pattern: { queryArc(a: number, b: number): CheckHap[] };
          };
          const haps = pattern.queryArc(0, CHECK_CYCLES);
          for (const hap of haps) {
            const note = hap.value?.note;
            if (note !== undefined && !isValidNote(note))
              return `Track "${track.name}": invalid note "${String(note)}"`;
            const s = hap.value?.s;
            if (typeof s !== 'string') continue;
            const name = (typeof hap.value?.bank === 'string' ? `${hap.value.bank}_${s}` : s).toLowerCase();
            if (!sounds[name.split(':')[0]!]) return `Track "${track.name}": unknown sound "${name}"`;
          }
          // A wrong scale name, for example, runs without an error and plays nothing.
          if (
            !haps.length &&
            track.body.trim() !== 'silence' &&
            !pattern.queryArc(0, CHECK_CYCLES_SILENT).length
          )
            return `Track "${track.name}" plays nothing. Check scale and chord names.`;
        } catch (e) {
          return `Track "${track.name}": ${e instanceof Error ? e.message : String(e)}`.slice(0, 1500);
        }
      }
      return null;
    },
  );
}

async function exportSong(msg: Extract<ToSandbox, { type: 'export' }>): Promise<void> {
  const { id, code, format, bars } = msg;
  if (exporting) {
    send({ type: 'exported', id, error: 'Another export is still running.' });
    return;
  }
  exporting = true;
  try {
    await editor.stop();
    await (editor as { prebaked?: Promise<unknown> }).prebaked;
    if (format === 'midi') {
      send({ type: 'exported', id, error: null, midi: await exportMidi(code, bars) });
    } else {
      const bytes = await exportAudio(code, format, bars, (stage) =>
        send({ type: 'exportProgress', id, stage }),
      );
      send({ type: 'exported', id, error: null, bytes }, [bytes]);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    send({ type: 'exported', id, error: error.slice(0, 2000) || 'The export failed' });
  } finally {
    exporting = false;
  }
}

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
    case 'check':
      void checkCode(msg.code).then((error) => send({ type: 'checked', id: msg.id, error }));
      break;
    case 'export':
      void exportSong(msg);
      break;
  }
});

renderState(false, false, null);
send({ type: 'ready' });
