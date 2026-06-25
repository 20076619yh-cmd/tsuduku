import { defineConfig } from 'vite';

// Phase 1: minimal config. base:'/' suits Vercel (root). Supabase env wiring comes Phase 2.
export default defineConfig({
  base: '/',
});
