# The 14 musical elements and how to write them in Strudel

Before you answer, go through this list. For each element decide: does the request change it, or must it stay consistent with the song and its Music Brief? Do not write this checklist in your answer.

| Element       | Means in Strudel                                                                                      | Limits                                                |
| ------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Melody        | the notes of a lead: `note("...")`, or `n("...").scale("C4:major")` to stay in key                    | keep a recognisable motif when varying                |
| Rhythm        | steps, rests `~`, groups `[ ]`, weights `@`, euclid `(3,8)`                                           | keep the drum and bass groove locked together         |
| Meter         | number of beats per cycle; 1 cycle = 1 bar; in 3/4 every bar of every track has 3 equal parts         | `setcpm` must divide by the beats in the bar          |
| Tempo         | `setcpm(bpm/beats)`; per section `.fast()` or `.slow()`                                               | no gradual tempo changes                              |
| Harmony       | chords `[c3,e3,g3]`, `chord("Am7").voicing()`, progressions with `<...>`                              | all tracks must agree on the chord of each bar        |
| Key           | note names, `.scale("A3:minor")`, `.add(note(n))` to transpose                                        | transposing one track only breaks the harmony         |
| Dynamics      | `.velocity()`, `.gain()`, signals for swells: `.gain(sine.range(.4,.9).slow(8))`                      | keep the total level sensible: `gain` at most about 1 |
| Articulation  | note length: `.clip(.5)` for staccato, `.clip(1.2)` for legato; `.attack()`, `.release()`             | soundfont notes end with their step                   |
| Timbre        | `.s("gm_...")`, `.bank("...")`, synths, `.lpf()`, `.vowel()`, `.distort()`                            | use only sounds from the reference                    |
| Texture       | number of tracks and layers; `stack()`, `,` layers, `.off()`, `.jux()`, `.room()`                     | more tracks is not better; leave space                |
| Form          | sections in `const` plus `arrange([cycles, section], ...)`; `.every()`, `.lastOf()` for small changes | section lengths must add up across tracks             |
| Style         | the choices above taken together: groove, sounds, chords, density typical for the genre               | do not name or copy existing songs                    |
| Accentuation  | a velocity pattern with the same steps as the notes: `.velocity("1 .5 .7 .5")`                        | velocity takes its structure from the notes           |
| Ornamentation | grace notes and runs in groups `[c4 d4]`, `.ply(2)`, `.off(1/16, ...)`, fills with `.lastOf(4, ...)`  | sparing use; ornaments should not hide the melody     |

Agogics (expressive tempo changes inside a phrase) are not available in Strudel. Do not attempt them.
