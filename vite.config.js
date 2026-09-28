import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    testTimeout: 30_000,
    hookTimeout: 90_000,
    // DB test files share one database; run files one after another
    fileParallelism: false,
  },
});
