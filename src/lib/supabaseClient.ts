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

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
