// Downloads the Strudel documentation with Firecrawl into kb/raw/ (not committed).
// kb/strudel-cheatsheet.md is written from it by hand: review the raw pages when Strudel changes.
//
//   node --env-file=.env scripts/build-strudel-kb.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGES = [
  'learn/mini-notation',
  'learn/notes',
  'learn/samples',
  'learn/synths',
  'learn/gm',
  'learn/effects',
  'learn/time-modifiers',
  'learn/control-parameters',
  'learn/signals',
  'learn/random-modifiers',
  'learn/conditional-modifiers',
  'learn/accumulation',
  'learn/tonal',
  'learn/factories',
  'understand/cycles',
  'understand/voicings',
];

const key = process.env.FIRECRAWL_API_KEY;
if (!key) throw new Error('FIRECRAWL_API_KEY is not set');

const outDir = join(process.cwd(), 'kb', 'raw');
mkdirSync(outDir, { recursive: true });

for (const page of PAGES) {
  const file = join(outDir, `${page.replace('/', '-')}.md`);
  if (existsSync(file)) continue;
  // Firecrawl's free plan allows only a few requests per minute.
  await new Promise((r) => setTimeout(r, 20000));
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `https://strudel.cc/${page}/`,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
  });
  const json = (await res.json()) as { success?: boolean; data?: { markdown?: string } };
  if (!res.ok || !json.data?.markdown) {
    console.log(`FAILED ${page}: HTTP ${res.status}`);
    continue;
  }
  writeFileSync(file, json.data.markdown);
  console.log(`ok ${page} (${json.data.markdown.length} chars)`);
}
