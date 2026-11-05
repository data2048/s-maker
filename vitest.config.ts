import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Strudel packages are browser ESM: let Vite resolve them (their "module" fields) for round-trip tests.
    server: { deps: { inline: [/@strudel\//, /@kabelsalat\//] } },
  },
});
