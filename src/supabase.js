// Supabase client (Phase 2). Keys come ONLY from env vars — never hard-coded.
// Local: set them in .env (gitignored). Production: set in Vercel env.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Supabase env vars missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
    'in .env (local) or Vercel project settings (production).'
  );
}

export const supabase = createClient(url, anonKey);
