// Starter snippets for the playground.
export interface Example {
  name: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    name: 'General MIDI band',
    code: `// General MIDI instruments are available as gm_* sounds
setcpm(90/4)

$: note("<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>")
  .s("gm_piano").legato(1).gain(.6)

$: note("<c2 a1 f1 g1>").s("gm_acoustic_bass").legato(.9)

$: n("0 2 4 5 4 2 <7 9> ~").scale("C4:major")
  .s("gm_flute").gain(.5)

$: s("bd ~ sd ~, hh*8").bank("RolandTR707").gain(.8)
`,
  },
  {
    name: 'Drum machine',
    code: `setcpm(120/4)

$: s("bd*4, [~ sd]*2, hh*8, ~ ~ ~ oh")
  .bank("RolandTR909")
  .gain("1 .7 .85 .7")   // accents
`,
  },
  {
    name: 'Acid synth',
    code: `setcpm(124/4)

$: note("<a1 a1 f1 g1>*8").s("sawtooth")
  .lpf(sine.range(300, 2200).slow(4)).lpq(10)
  .decay(.15).sustain(0).gain(.5)

$: s("bd*4").bank("RolandTR808")
`,
  },
  {
    name: 'Dynamics & articulation',
    code: `// crescendo with a slow ramp, staccato vs legato
setcpm(80/4)

$: n("0 1 2 3 4 5 6 7").scale("D4:minor")
  .s("gm_violin")
  .gain(saw.range(.15, .9).slow(4))
  .legato("<.2 1>")
`,
  },
];
