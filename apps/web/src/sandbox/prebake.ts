// Loads Strudel functions and sounds into the evaluation scope.
// Based on @strudel/repl's prebake (AGPL-3.0, Strudel contributors), without hydra (visuals) and
// Web MIDI (needs permissions the sandbox does not grant).
import * as codemirror from '@strudel/codemirror';
import * as core from '@strudel/core';
import * as draw from '@strudel/draw';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';

const { aliasBank, registerSynthSounds, registerZZFXSounds, samples } = webaudio;

const { evalScope, noteToMidi, valueToMidi, Pattern } = core;

const DOUGH = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const TODEPOND = 'https://raw.githubusercontent.com/todepond/samples/main';
const UZU = 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main';

export async function prebake(): Promise<void> {
  const modulesLoading = evalScope(
    core,
    draw,
    mini,
    tonal,
    webaudio,
    codemirror,
    // Loaded lazily: it touches browser-only globals at import time.
    import('@strudel/soundfonts'),
  );

  await Promise.all([
    modulesLoading,
    registerSynthSounds(),
    registerZZFXSounds(),
    // General MIDI instruments: s("gm_acoustic_grand_piano"), s("gm_electric_bass_finger"), ...
    import('@strudel/soundfonts').then(({ registerSoundfonts }) => registerSoundfonts()),
    samples(`${DOUGH}/tidal-drum-machines.json`),
    samples(`${DOUGH}/piano.json`),
    samples(`${DOUGH}/Dirt-Samples.json`),
    samples(`${DOUGH}/vcsl.json`),
    samples(`${DOUGH}/mridangam.json`),
    samples(`${UZU}/strudel.json`),
  ]);
  aliasBank(`${TODEPOND}/tidal-drum-machines-alias.json`);
}

// .piano(): the same helper strudel.cc offers (piano samples, panned by pitch).
const maxPan = noteToMidi('C8');
const panwidth = (pan: number, width: number) => pan * width + (1 - width) / 2;
Pattern.prototype.piano = function () {
  return this.fmap((v: Record<string, unknown>) => ({ ...v, clip: v.clip ?? 1 }))
    .s('piano')
    .release(0.1)
    .fmap((value: Record<string, unknown>) => {
      const midi = valueToMidi(value);
      const pan = panwidth(Math.min(Math.round(midi) / maxPan, 1), 0.5);
      return { ...value, pan: ((value.pan as number) || 1) * pan };
    });
};
