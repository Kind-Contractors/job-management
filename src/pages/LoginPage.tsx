import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) setError(error.message);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-200">
      <form onSubmit={onSubmit} className="w-[320px] border border-divider bg-white p-6">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-[22px] w-[22px] items-center justify-center bg-teal font-heading text-xs font-bold text-white">
            K
          </div>
          <div className="font-heading text-sm font-semibold tracking-[0.1em] uppercase">Kind Contractors</div>
        </div>
        <h1 className="mb-4 font-heading text-lg font-semibold">Manager sign in</h1>

        <label className="mb-3 block text-xs text-neutral-600">
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full border border-neutral-300 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-teal"
          />
        </label>
        <label className="mb-4 block text-xs text-neutral-600">
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full border border-neutral-300 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-teal"
          />
        </label>

        {error && <div className="mb-3 text-xs text-missed-fg">{error}</div>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full cursor-pointer bg-teal px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
