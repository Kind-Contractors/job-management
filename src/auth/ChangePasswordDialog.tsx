import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// Supabase Auth's own hard floor — the project's dashboard could require
// more, but this is the one requirement guaranteed true for every project
// without a way to introspect the actual configured policy from the
// browser. Anything stricter is still enforced server-side by
// updateUser() itself; a rejection there is shown via
// friendlyPasswordErrorMessage() below, never silently accepted.
const MIN_PASSWORD_LENGTH = 6;

/**
 * Softens the couple of known supabase-js/GoTrue error shapes that read
 * awkwardly verbatim; anything unrecognized still falls through to the
 * original message rather than a generic "something went wrong" — GoTrue's
 * own wording is already specific and accurate for cases this doesn't
 * special-case (e.g. a policy stricter than MIN_PASSWORD_LENGTH).
 */
function friendlyPasswordErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('different from the old password') || (lower.includes('same') && lower.includes('password'))) {
    return 'Your new password must be different from your current password.';
  }
  if (lower.includes('session')) {
    return 'Your session has expired — please sign in again, then retry.';
  }
  return raw;
}

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}

/** A password input with a plain text Show/Hide toggle — matches this app's existing plain-button convention rather than an icon (no icon library is used anywhere else in this codebase). */
function PasswordField({ label, value, onChange, autoComplete }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
      {label}
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className="w-full border border-neutral-300 py-1.5 pr-14 pl-2 text-[12.5px] text-ink outline-none focus:border-teal"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-[11px] font-semibold text-teal-700 hover:underline"
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </label>
  );
}

/**
 * Self-service password change for the currently signed-in user — Manager
 * or Technician alike, since both sign in through the same Supabase Auth
 * session. Calls supabase.auth.updateUser() directly: this always targets
 * the caller's OWN session (there is no userId parameter to pass, and none
 * is accepted here), so it can only ever change the password of whoever is
 * currently signed in. No admin-users Edge Function involvement, no
 * app_users/technicians/role changes, no schema changes — this only ever
 * touches the caller's own auth.users row, via Supabase's own Auth API.
 * Forgot-password-by-email is explicitly out of scope here; this dialog
 * only ever runs for an already-authenticated session.
 */
export default function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const meetsLength = newPassword.length >= MIN_PASSWORD_LENGTH;

  const handleSubmit = async () => {
    setError(null);

    if (newPassword.length === 0) {
      setError('Enter a new password.');
      return;
    }
    if (!meetsLength) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setSubmitting(false);

    if (updateError) {
      setError(friendlyPasswordErrorMessage(updateError.message));
      return;
    }

    setSuccess(true);
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-[380px] border border-neutral-300 bg-white p-4">
        {success ? (
          <>
            <div className="border-b border-divider pb-2.5">
              <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-teal-700 uppercase">Account</div>
              <h2 className="mt-1 font-heading text-lg font-semibold">Password changed</h2>
            </div>
            <div className="mt-3 border border-teal-700/40 bg-teal-100 p-2.5 text-[12.5px] text-teal-700">
              Your password has been updated. Use it next time you sign in.
            </div>
            <button
              onClick={onClose}
              className="mt-3.5 cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <div className="border-b border-divider pb-2.5">
              <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Account</div>
              <h2 className="mt-1 font-heading text-lg font-semibold">Change password</h2>
            </div>

            <div className="mt-3 flex flex-col gap-2.5">
              <PasswordField label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
              <PasswordField
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
              />

              <ul className="list-inside list-disc text-[11px] leading-relaxed text-neutral-500">
                <li className={newPassword.length > 0 && !meetsLength ? 'text-missed-fg' : undefined}>
                  At least {MIN_PASSWORD_LENGTH} characters
                </li>
              </ul>

              {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

              <div className="mt-1 flex gap-1.5">
                <button
                  onClick={() => void handleSubmit()}
                  disabled={submitting}
                  className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Saving…' : 'Change password'}
                </button>
                <button
                  onClick={onClose}
                  disabled={submitting}
                  className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
