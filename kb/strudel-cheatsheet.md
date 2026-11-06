# Strudel reference

Strudel code is JavaScript with pattern functions. Double-quoted and backtick strings are mini-notation.
Every `strudel` code block in this file is run by a test, so it is known to work.

## Song layout in s-maker

A song is one piece of code: a header, then tracks. A track is a top-level label followed by a pattern.

```strudel
setcpm(120/4)

drums: s("bd ~ sd ~, hh*8").bank("RolandTR909")
bass: note("<c2 g1>").s("gm_electric_bass_finger")
keys: note("<[c3,e3,g3] [g2,b2,d3]>").s("gm_epiano1").gain(.6)
```

- `setcpm(bpm/beatsPerBar)` sets the tempo. One cycle is one bar, so 120 BPM in 4/4 is `setcpm(120/4)`.
- Track names are lowercase letters, digits and `_`, starting with a letter.
- Prefix `_` mutes a track (`_bass:`), prefix `S` solos it (`Sbass:`). Keep these prefixes when editing.
- Repeated material can live in `const` declarations in the header, above the tracks.

## Mini-notation

| Syntax     | Meaning                                  | Example                    |
| ---------- | ---------------------------------------- | -------------------------- |
| `a b c`    | events share the cycle evenly            | `"c3 e3 g3"`               |
| `~`        | rest                                     | `"c3 ~ e3 ~"`              |
| `[a b]`    | group in the time of one step            | `"c3 [e3 g3]"`             |
| `<a b>`    | one per cycle (alternate)                | `"<c3 e3>"`                |
| `[a,b]`    | play together (chord, layers)            | `"[c3,e3,g3]"`             |
| `a, b`     | layers at the top level                  | `"c2*2, g3 a3"`            |
| `a*n`      | repeat n times in the step               | `"hh*8"`                   |
| `a/n`      | stretch over n cycles                    | `"[c3 e3 g3 b3]/2"`        |
| `a!n`      | repeat as n separate steps               | `"c3!3 e3"`                |
| `a@n`      | weight: lasts n steps                    | `"c3@3 e3"`                |
| `a?`       | plays half of the time                   | `"hh*8?"`                  |
| `a\|b`     | random choice each cycle                 | `"c3\|e3\|g3"`             |
| `a(k,n,r)` | euclidean rhythm: k hits in n steps      | `"bd(3,8)"`, `"c3(5,8,2)"` |
| `a:n`      | sample number n, or a value with a colon | `"hh:2"`                   |

Notes are `c4`, `c#4`, `eb4` (`c4` is MIDI 60). Without an octave the default is 3. A rest is `~`; there is no other rest letter.

```strudel
note("c3 [e3 g3] <a3 b3> ~").s("gm_piano")
```

```strudel
note("<[c3,e3,g3]@3 [f3,a3,c4]>").s("gm_piano")
```

## Sounds

- `note("...").s("gm_...")`: General MIDI soundfonts. Only names from the list below exist.
- `s("bd sd hh").bank("RolandTR909")`: drum machines.
- `note("...").s("sawtooth")`: synths `sine`, `sawtooth`, `square`, `triangle`, `supersaw`, and noise `white`, `pink`, `brown`.

Drum sounds: `bd sd rim cp hh oh lt mt ht cr rd`.
Drum banks: `RolandTR808 RolandTR909 RolandTR707 RolandTR606 LinnDrum AkaiLinn BossDR110 AlesisHR16 CasioRZ1 EmuSP12`.

General MIDI sounds:
`gm_piano gm_epiano1 gm_epiano2 gm_harpsichord gm_clavinet gm_celesta gm_glockenspiel gm_music_box gm_vibraphone gm_marimba gm_xylophone gm_tubular_bells gm_dulcimer gm_drawbar_organ gm_percussive_organ gm_rock_organ gm_church_organ gm_reed_organ gm_accordion gm_harmonica gm_bandoneon gm_acoustic_guitar_nylon gm_acoustic_guitar_steel gm_electric_guitar_jazz gm_electric_guitar_clean gm_electric_guitar_muted gm_overdriven_guitar gm_distortion_guitar gm_guitar_harmonics gm_acoustic_bass gm_electric_bass_finger gm_electric_bass_pick gm_fretless_bass gm_slap_bass_1 gm_slap_bass_2 gm_synth_bass_1 gm_synth_bass_2 gm_violin gm_viola gm_cello gm_contrabass gm_tremolo_strings gm_pizzicato_strings gm_orchestral_harp gm_timpani gm_string_ensemble_1 gm_string_ensemble_2 gm_synth_strings_1 gm_synth_strings_2 gm_choir_aahs gm_voice_oohs gm_synth_choir gm_orchestra_hit gm_trumpet gm_trombone gm_tuba gm_muted_trumpet gm_french_horn gm_brass_section gm_synth_brass_1 gm_synth_brass_2 gm_soprano_sax gm_alto_sax gm_tenor_sax gm_baritone_sax gm_oboe gm_english_horn gm_bassoon gm_clarinet gm_piccolo gm_flute gm_recorder gm_pan_flute gm_blown_bottle gm_shakuhachi gm_whistle gm_ocarina gm_lead_1_square gm_lead_2_sawtooth gm_lead_3_calliope gm_lead_4_chiff gm_lead_5_charang gm_lead_6_voice gm_lead_7_fifths gm_lead_8_bass_lead gm_pad_new_age gm_pad_warm gm_pad_poly gm_pad_choir gm_pad_bowed gm_pad_metallic gm_pad_halo gm_pad_sweep gm_fx_rain gm_fx_soundtrack gm_fx_crystal gm_fx_atmosphere gm_fx_brightness gm_fx_goblins gm_fx_echoes gm_fx_sci_fi gm_sitar gm_banjo gm_shamisen gm_koto gm_kalimba gm_bagpipe gm_fiddle gm_shanai gm_tinkle_bell gm_agogo gm_steel_drums gm_woodblock gm_taiko_drum gm_melodic_tom gm_synth_drum gm_reverse_cymbal gm_guitar_fret_noise gm_breath_noise gm_seashore gm_bird_tweet gm_telephone gm_helicopter gm_applause gm_gunshot`

## Scales and chords

`n()` with `.scale()` picks scale degrees, starting at 0. This keeps a line in key.

```strudel
n("0 2 4 <5 7>").scale("C4:major").s("gm_flute")
```

```strudel
n("0 1 2 3 4 3 2 1").scale("A3:minor:pentatonic").s("gm_marimba")
```

Scale names: `major minor dorian phrygian lydian mixolydian locrian harmonic:minor melodic:minor minor:pentatonic major:pentatonic blues`.

Chord symbols with automatic voicing. A symbol has no spaces (`Bb^7`, not `Bb maj7`), and a wrong symbol plays nothing:

```strudel
chord("<Am7 Dm7 G7 C^7>").voicing().s("gm_epiano1")
```

Move pitches: `.add(note(12))` on notes, `.transpose(2)` on notes, `.scaleTranspose(2)` within a scale.

```strudel
note("c3 e3 g3").add(note("<0 5 7>")).s("gm_piano")
```

## Combining patterns

```strudel
stack(note("c3 e3"), note("g2").s("gm_acoustic_bass")).s("gm_piano")
```

```strudel
cat(note("c3 e3"), note("g3 a3")).s("gm_piano")
```

`arrange([cycles, pattern], ...)` builds the form. Use `silence` for a rest.

```strudel
const verse = note("<c3 e3>").s("gm_piano")
const chorus = note("<[c4,e4] [g3,c4]>").s("gm_piano")
arrange([4, verse], [4, chorus], [2, silence], [4, verse])
```

## Time

`.fast(2)`, `.slow(2)`, `.rev()`, `.palindrome()`, `.iter(4)`, `.ply(2)`, `.early(.25)`, `.late(.25)`.
`.swing(4)` or `.swingBy(1/3, 4)` adds swing. `.clip(.5)` shortens notes to a part of their step, `.clip(1.5)` makes them overlap.

```strudel
s("hh*8").swingBy(1/3, 4).bank("RolandTR909")
```

```strudel
note("c3 e3 g3 b3").clip(.5).s("gm_pizzicato_strings")
```

`.euclid(3,8)` or `"(3,8)"` in the mini-notation spreads hits evenly.
`.off(1/8, x => x.add(note(12)))` layers a delayed copy. `.jux(rev)` plays a changed copy on one side.
`.every(4, x => x.fast(2))` and `.firstOf(4, x => x.rev())`, `.lastOf(4, x => x.rev())` change some cycles.
`.sometimes(x => x.ply(2))`, `.rarely(...)`, `.often(...)`, `.degradeBy(.2)` add chance.

```strudel
note("c3 e3 g3").off(1/8, x => x.add(note(12))).s("gm_vibraphone")
```

```strudel
s("bd sd").lastOf(4, x => x.fast(2)).bank("RolandTR808")
```

## Dynamics and accents

`.velocity(.8)` (0–1) is the force of a note. `.gain(.7)` is the level of a track.
Patterns set accents: `.velocity("1 .5 .7 .5")`. The structure comes from the left side, so give velocity the same steps.

```strudel
note("c3 e3 g3 b3").velocity("1 .5 .7 .5").s("gm_piano")
```

Slow changes use signals: `sine`, `saw`, `tri`, `square`, `rand`, `perlin`, with `.range(a, b)` and `.slow(n)`.

```strudel
note("c3*8").gain(sine.range(.3, .9).slow(4)).s("gm_string_ensemble_1")
```

## Tone and effects

Envelope: `.attack(.1)`, `.decay(.2)`, `.sustain(.5)`, `.release(.3)`, or `.adsr(".1:.2:.5:.3")`.
Filters: `.lpf(800)` with `.lpq(5)`, `.hpf(300)`, `.bpf(1000)`, `.vowel("a e")`.
Space: `.room(.4)`, `.size(2)`, `.delay(.4)`, `.delaytime(.25)`, `.delayfeedback(.4)`, `.pan(.2)` (0 left, 1 right).
Character: `.distort(.5)`, `.shape(.3)`, `.crush(6)`, `.coarse(4)`, `.vib(5)`, `.vibmod(.2)`, `.phaser(2)`.
Samples: `.speed(.5)`, `.begin(.25)`, `.end(.75)`, `.cut(1)`.

```strudel
note("c2 c2 eb2 g1").s("sawtooth").lpf(sine.range(300, 2000).slow(8)).lpq(6).adsr(".01:.1:.6:.1")
```

```strudel
note("<[c4,e4,g4] [a3,c4,e4]>").s("gm_pad_warm").attack(.3).release(.8).room(.5).delay(.3)
```

## What Strudel cannot do

- No gradual tempo change (no accelerando or ritardando). `setcpm` is one value for the whole song; a different tempo per section needs `.fast()`/`.slow()` on that section's pattern.
- Time signature is implied: one cycle is one bar, and a different meter means a different number of steps in the bar.
- No ties across bars: a note lasts until the end of its step, so long notes use `@` within the bar, `/n`, or `.clip()`.
