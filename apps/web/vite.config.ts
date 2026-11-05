import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = `http://localhost:${process.env.PORT ?? 44566}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
  },
});
