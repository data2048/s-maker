// Compresses the built files once, so that the server can send them smaller without working for each request.
// HTML is left out: it is small, and the player page must keep its exact security headers.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const MIN_SIZE = 1024;
let before = 0;
let after = 0;

for (const name of readdirSync(root)) {
  if (!/\.(js|css|json|wasm|svg)$/.test(name)) continue;
  const file = join(root, name);
  if (statSync(file).size < MIN_SIZE) continue;
  const data = readFileSync(file);
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(`${file}.br`, br);
  writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
  before += data.length;
  after += br.length;
}

const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`precompress: ${mb(before)} MB -> ${mb(after)} MB with brotli`);
