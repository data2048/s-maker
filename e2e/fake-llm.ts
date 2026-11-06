// A stand-in for OpenRouter in e2e tests: predictable answers, no cost, no network.
import { createServer, type Server } from 'node:http';

export const FAKE_LLM_PORT = 44578;

const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  cost: 0.01,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 40 },
};

interface Body {
  messages: { role: string; content: string }[];
  model: string;
  stream?: boolean;
}

function answerFor(body: Body): object {
  const all = body.messages.map((m) => m.content).join('\n');
  const request = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  if (request.includes('# COMPOSE')) {
    return {
      title: 'Fake Song',
      summary: 'Composed a short piece',
      changes: [
        { type: 'header', code: 'setcpm(90/4)\nconst verse_bass = note("c2 g1").s("gm_acoustic_bass")' },
        { type: 'add', name: 'drums', code: 's("bd sd").bank("RolandTR909")' },
        { type: 'add', name: 'bass', code: 'arrange([4, verse_bass])' },
      ],
      brief: { tempo: '90 BPM', key: 'C minor' },
    };
  }
  if (request.includes('# CHAT')) {
    const asked = request.slice(request.indexOf('# REQUEST'));
    if (asked.includes('What key')) return { reply: 'It is in C major, and the "bass" follows the chords.' };
    if (asked.includes('slow'))
      return { reply: 'I noted a slow tempo.', brief: { tempo: 'slow, about 70 BPM' } };
    return {
      reply: 'Changed the bass to a synth.',
      summary: 'Bass to synth',
      changes: [{ type: 'track', name: 'bass', code: 'note("c2 g1").s("gm_synth_bass_2")' }],
    };
  }
  if (all.includes('USE A BAD SOUND')) {
    return all.includes('it failed with')
      ? {
          summary: 'Fixed the sound',
          changes: [{ type: 'track', name: 'bass', code: 'note("c2").s("gm_tuba")' }],
        }
      : {
          summary: 'Tried a sound',
          changes: [{ type: 'track', name: 'bass', code: 'note("c2").s("gm_does_not_exist")' }],
        };
  }
  return {
    summary: 'Changed the bass',
    changes: [{ type: 'track', name: 'bass', code: 'note("c2 g1").s("gm_synth_bass_1")' }],
  };
}

/** What a model might write after reading a hostile song. None of it may run. */
function explanationFor(request: string): string {
  const level = request.includes('Level: short') ? 'Short' : 'Detailed';
  return `${level} explanation with **bold** text.

<img src="https://evil.example/x.png" onerror="window.xss=true">
<script>window.xss=true</script>
<iframe src="https://evil.example"></iframe>
<p onclick="window.xss=true" style="color:red">Click</p>

![tracking](https://evil.example/pixel.png)

[bad link](javascript:window.xss=true) and [Strudel docs](https://strudel.cc/)`;
}

function contentFor(body: Body): string {
  const request = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  return request.includes('# EXPLAIN') ? explanationFor(request) : JSON.stringify(answerFor(body));
}

export function startFakeLlm(): Server {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/models')) {
        res.end(
          JSON.stringify({
            data: [{ id: 'test/compare-model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
          }),
        );
        return;
      }
      const body = JSON.parse(raw) as Body;
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        const content = contentFor(body);
        const chunks = content.match(/[\s\S]{1,12}/g) ?? [];
        res.write(': OPENROUTER PROCESSING\n\n');
        for (const c of chunks)
          res.write(
            `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: c }, finish_reason: c === chunks.at(-1) ? 'stop' : null }] })}\n\n`,
          );
        res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage: USAGE })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { content: contentFor(body) }, finish_reason: 'stop' }],
          usage: USAGE,
        }),
      );
    });
  });
  server.listen(FAKE_LLM_PORT, '127.0.0.1');
  server.unref();
  return server;
}
