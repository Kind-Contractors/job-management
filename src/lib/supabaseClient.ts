// Browser Supabase client. Only ever uses the publishable/anon key (see
// .env.example) — RLS is the actual security boundary (see CLAUDE.md section
// 11 and the auth/RLS design), so this key is safe to embed in the bundle.
// A service-role key must never be added here.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — copy .env.example to .env.local and fill them in.');
}

// Dev-only safety guard: `import.meta.env.DEV` is true only under `npm run
// dev` (vite), never under `vite build` (what Netlify's production build
// runs) — so this can never affect the deployed app, only a local dev
// server accidentally still pointed at the production project.
const PRODUCTION_PROJECT_REF = 'rgcxybsnoqjnbywzycfx';

if (import.meta.env.DEV && supabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error(
    'Local dev server (`npm run dev`) is configured to use the PRODUCTION Supabase ' +
      'project. Update VITE_SUPABASE_URL in your local .env.local to point at the ' +
      'development project instead of production.',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
