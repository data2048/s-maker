import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 127.0.0.1, not localhost: Node may resolve localhost to IPv6 (::1) while the server listens on IPv4.
const apiTarget = `http://127.0.0.1:${process.env.API_PORT ?? 44566}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The sandboxed player iframe has an opaque origin ("null"); it must be allowed to load modules.
    cors: { origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, 'null'] },
    proxy: {
      '/api': apiTarget,
      '/health': apiTarget,
      '/ws': { target: apiTarget, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // Strudel is large; that is expected for the player bundle.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        sandbox: resolve(import.meta.dirname, 'sandbox.html'),
      },
    },
  },
});
