import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import staffPreview from './config/staff-preview.json';

export default defineConfig(({ mode }) => ({
  // Public client configuration only. This specific test branch must never
  // inherit the live project's Supabase values from Vercel's Preview scope.
  define: mode === 'staging' || (
    process.env.VERCEL_ENV === 'preview' &&
    process.env.VERCEL_GIT_COMMIT_REF === 'feature/staff-roles-supplier-orders'
  ) ? Object.fromEntries(Object.entries(staffPreview).map(([key, value]) =>
    [`import.meta.env.${key}`, JSON.stringify(value)],
  )) : {},
  plugins: [react()],
  server: { port: 5173 },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
  test: {
    testTimeout: 30_000,
    hookTimeout: 90_000,
    // DB test files share one database; run files one after another
    fileParallelism: false,
  },
}));
