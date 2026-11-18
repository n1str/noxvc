import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.RELAY_DEV_BACKEND ?? 'http://127.0.0.1:8099';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/uploads': backend,
      '/gateway': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
