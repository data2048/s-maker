// A stand-in for OpenRouter in e2e tests: predictable answers, no cost, no network.
import { createServer, type Server } from 'node:http';

export const FAKE_LLM_PORT = 44578;

interface Body {
  messages: { role: string; content: string }[];
  model: string;
}

function answerFor(body: Body): object {
  const all = body.messages.map((m) => m.content).join('\n');
  const request = body.messages.find((m) => m.role === 'user')?.content ?? '';
  if (request.includes('USE A BAD SOUND')) {
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

export function startFakeLlm(): Server {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const body = JSON.parse(raw) as Body;
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { content: JSON.stringify(answerFor(body)) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 },
        }),
      );
    });
  });
  server.listen(FAKE_LLM_PORT, '127.0.0.1');
  server.unref();
  return server;
}
