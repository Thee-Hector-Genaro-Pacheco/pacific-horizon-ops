import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Command Center API (src/dashboard/server.ts) is read-only and binds to 127.0.0.1.
const apiTarget = process.env.PHRO_DASHBOARD_API ?? 'http://127.0.0.1:3200';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
