import { describe, expect, it } from 'vitest';
import { agentAnswerSchema, composeRequestSchema, listSections, partialJsonString } from '../src';

describe('partialJsonString', () => {
  it('reads a string that is still arriving', () => {
    expect(partialJsonString('{"reply":"Hel', 'reply')).toBe('Hel');
    expect(partialJsonString('{"reply": "Hello", "changes": []}', 'reply')).toBe('Hello');
    expect(partialJsonString('{"summ', 'reply')).toBeNull();
  });
  it('decodes escapes, and waits for one that is cut in half', () => {
    expect(partialJsonString('{"reply":"a\\nb \\"c\\" \\u0105"}', 'reply')).toBe('a\nb "c" \u0105');
    expect(partialJsonString('{"reply":"ab\\', 'reply')).toBe('ab');
    expect(partialJsonString('{"reply":"ab\\u01', 'reply')).toBe('ab');
  });
});

describe('agentAnswerSchema in a chat', () => {
  it('needs no changes or summary next to a reply', () => {
    expect(agentAnswerSchema.parse({ reply: 'Hello' })).toEqual({
      reply: 'Hello',
      summary: 'Hello',
      changes: [],
    });
  });
  it('still needs them without a reply', () => {
    expect(agentAnswerSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(agentAnswerSchema.safeParse({ summary: 'x' }).success).toBe(false);
  });
});

describe('listSections', () => {
  it('lists const declarations above the first track', () => {
    const code = 'setcpm(1)\nconst verse_a = note("c")\nconst b = note("d")\n\nlead: arrange([4, verse_a])\n';
    expect(listSections(code)).toEqual(['verse_a', 'b']);
  });
  it('is empty when there are none', () => {
    expect(listSections('setcpm(1)\n\nlead: note("c")\n')).toEqual([]);
  });
});

describe('composeRequestSchema', () => {
  it('needs a description or an element', () => {
    expect(composeRequestSchema.safeParse({ description: '  ' }).success).toBe(false);
    expect(composeRequestSchema.safeParse({ description: 'Calm' }).success).toBe(true);
    expect(composeRequestSchema.safeParse({ brief: { key: 'C minor' } }).success).toBe(true);
  });
});
