import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import {
  createUser,
  deleteUser,
  listUsers,
  setUserActive,
  updateUser,
  type AppRole,
  type AppUserRow,
  type CreatedUser,
} from '../repository/usersRepository';

type Tab = 'all' | 'technicians' | 'administrators' | 'inactive';

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All users' },
  { key: 'technicians', label: 'Technicians' },
  { key: 'administrators', label: 'Administrators' },
  { key: 'inactive', label: 'Inactive' },
];

const LAST_LOGIN_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function roleLabel(role: AppRole): string {
  return role === 'manager' ? 'Administrator' : 'Technician';
}

const ROLE_DESCRIPTION: Record<AppRole, string> = {
  technician: 'Access to assigned jobs, building information, reports, and photo uploads.',
  manager: 'Access to scheduling, buildings, reports, invoices, and user management.',
};

/** Good-enough shape check (not full RFC 5322) — matches the level of validation used elsewhere in this app; the real authority is still Supabase's own server-side check. */
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Softens the two known Supabase Auth failure shapes handleCreate's own
 * `Failed to create the account: ${createError.message}` wrapping can
 * produce, without ever hiding an error this doesn't recognize — anything
 * unmatched still falls through to that original, already-reasonable
 * message rather than a generic "something went wrong."
 */
function friendlyCreateErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('already') && (lower.includes('registered') || lower.includes('exists'))) {
    return 'An account with this email already exists.';
  }
  if (lower.includes('email') && (lower.includes('invalid') || lower.includes('valid'))) {
    return 'Please enter a valid email address.';
  }
  return raw;
}

/** A small uppercase section label — same micro-label convention used for "Contact (optional)" in BuildingCreator.tsx, reused here to group the create/edit form into clearer sections. */
function FormSectionLabel({ children }: { children: string }) {
  return <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">{children}</div>;
}

/**
 * The right-side "Add team member" / "Edit user" panel — same drawer shell
 * (right-side, teal header band) established for ScheduleDayDrawer.tsx,
 * reused here for visual consistency rather than inventing a new pattern.
 * Add and Edit share one component since the fields overlap almost
 * entirely; `editingUser` present means edit mode (name only — email and
 * role are fixed once created, out of scope for this pass).
 */
function UserFormDrawer({
  editingUser,
  onClose,
  onCreated,
  onSaved,
}: {
  editingUser: AppUserRow | null;
  onClose: () => void;
  onCreated: (result: CreatedUser) => void;
  /** Called (in addition to onClose) once an edit is saved successfully — lets the parent show a confirmation toast. Not used for create, which already shows its own dedicated success panel. */
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!editingUser;
  const [firstName, setFirstName] = useState(() => editingUser?.displayName?.split(' ')[0] ?? '');
  const [lastName, setLastName] = useState(() => editingUser?.displayName?.split(' ').slice(1).join(' ') ?? '');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AppRole>('technician');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['users'] });
    queryClient.invalidateQueries({ queryKey: ['technicians'] });
  };

  const createMutation = useMutation({
    mutationFn: () => createUser({ firstName, lastName, email, role }),
    onSuccess: (result) => {
      invalidate();
      onCreated(result);
    },
    onError: (err) => setError(friendlyCreateErrorMessage(err instanceof Error ? err.message : 'Failed to create user.')),
  });

  const updateMutation = useMutation({
    mutationFn: () => updateUser({ userId: editingUser!.id, firstName, lastName }),
    onSuccess: () => {
      invalidate();
      onSaved?.();
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to update user.'),
  });

  const pending = createMutation.isPending || updateMutation.isPending;
  const trimmedEmail = email.trim();
  const emailFormatValid = trimmedEmail.length === 0 || isValidEmail(trimmedEmail);
  const canSubmit =
    firstName.trim().length > 0 && (isEdit || (trimmedEmail.length > 0 && isValidEmail(trimmedEmail)));

  return (
    <div className="flex w-[380px] flex-none flex-col overflow-y-auto border-l border-neutral-300 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.04)]">
      <div className="flex items-start gap-2 border-b border-neutral-300 bg-teal-100 px-5 py-4">
        <div className="min-w-0">
          <div className="font-heading text-[10px] font-semibold tracking-[0.14em] text-teal-700 uppercase">Users</div>
          <h2 className="mt-0.5 font-heading text-xl leading-tight font-semibold text-ink">
            {isEdit ? 'Edit user' : 'Add team member'}
          </h2>
        </div>
        <button onClick={onClose} title="Close" aria-label="Close" className="ml-auto cursor-pointer px-1 text-neutral-600 hover:text-ink">
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-col gap-2.5">
          <FormSectionLabel>Personal details</FormSectionLabel>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            First name
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Last name (optional)
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-divider pt-3.5">
          <FormSectionLabel>Login details</FormSectionLabel>
          {isEdit ? (
            <div className="text-[11.5px] text-neutral-500">
              Email: <span className="text-neutral-700">{editingUser!.email ?? '—'}</span>
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
                />
              </label>
              {!emailFormatValid && (
                <div className="text-[11px] text-missed-fg">Please enter a valid email address.</div>
              )}
              <div className="border border-neutral-300 bg-neutral-100 p-2.5 text-[11px] leading-relaxed text-neutral-600">
                A temporary password is generated automatically and shown once, right after the account is created.
                Share it securely with them — if a password-change option is available in the app, ask them to update
                it once they've signed in.
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2.5 border-t border-divider pt-3.5">
          <FormSectionLabel>Role</FormSectionLabel>
          {isEdit ? (
            <div className="text-[11.5px] text-neutral-500">
              <span className="text-neutral-700">{roleLabel(editingUser!.role)}</span> — not editable here.
            </div>
          ) : (
            <>
              <div className="flex border border-neutral-300">
                <button
                  type="button"
                  onClick={() => setRole('technician')}
                  className={`flex-1 cursor-pointer px-2 py-1.5 text-[12.5px] ${
                    role === 'technician' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
                  }`}
                >
                  Technician
                </button>
                <button
                  type="button"
                  onClick={() => setRole('manager')}
                  className={`flex-1 cursor-pointer border-l border-neutral-300 px-2 py-1.5 text-[12.5px] ${
                    role === 'manager' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
                  }`}
                >
                  Administrator
                </button>
              </div>
              <div className="text-[11px] leading-relaxed text-neutral-500">{ROLE_DESCRIPTION[role]}</div>
              {role === 'technician' && (
                <div className="text-[11px] leading-relaxed text-neutral-500">
                  A technician record is created and linked automatically — they'll appear in the Schedule's technician
                  list right away.
                </div>
              )}
            </>
          )}
        </div>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

        <div className="flex gap-1.5">
          <button
            onClick={() => (isEdit ? updateMutation.mutate() : createMutation.mutate())}
            disabled={!canSubmit || pending}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
          </button>
          <button onClick={onClose} className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A small "Copy" action that briefly confirms itself as "Copied" — used for
 * the email/password/login-details copy actions below. Fails quietly if the
 * Clipboard API is unavailable/blocked (e.g. a non-secure context): the
 * value stays visible on screen to copy by hand either way, so there's
 * nothing useful to show as an error for a pure convenience action.
 */
function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // See doc comment — nothing useful to surface here.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={className ?? 'cursor-pointer text-[11px] font-semibold text-teal-700 hover:underline'}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Shown once, right after a successful create — the only time the temporary password is ever visible. Never persisted, logged, or exposed anywhere else — this component's props are the only place `tempPassword` exists once the create response has been received. */
function CreatedUserPanel({ result, onClose }: { result: CreatedUser; onClose: () => void }) {
  const loginDetailsText = `Email: ${result.email}\nTemporary password: ${result.tempPassword}`;

  return (
    <div className="flex w-[380px] flex-none flex-col overflow-y-auto border-l border-neutral-300 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.04)]">
      <div className="flex items-start gap-2 border-b border-neutral-300 bg-teal-100 px-5 py-4">
        <div className="min-w-0">
          <div className="font-heading text-[10px] font-semibold tracking-[0.14em] text-teal-700 uppercase">Users</div>
          <h2 className="mt-0.5 font-heading text-xl leading-tight font-semibold text-ink">User created</h2>
        </div>
        <button onClick={onClose} title="Close" aria-label="Close" className="ml-auto cursor-pointer px-1 text-neutral-600 hover:text-ink">
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="text-[12.5px] leading-relaxed text-neutral-700">
          Share these sign-in details with them directly — the temporary password is shown only this once and can't be
          retrieved again.
        </div>
        <div className="border border-neutral-300 bg-neutral-100 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Email</div>
            <CopyButton value={result.email} />
          </div>
          <div className="text-[13px] text-ink">{result.email}</div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
              Temporary password
            </div>
            <CopyButton value={result.tempPassword} />
          </div>
          <div className="font-mono text-[13px] text-ink">{result.tempPassword}</div>
        </div>
        <CopyButton
          value={loginDetailsText}
          label="Copy login details"
          className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
        />
        <button onClick={onClose} className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * A real, irreversible delete — unlike Deactivate, this cannot be undone —
 * so it gets its own confirm step, reusing the same modal-overlay shell
 * ReadyForClientPage.tsx's SendConfirmDialog already established rather
 * than inventing a second pattern.
 */
function DeleteConfirmDialog({
  user,
  isDeleting,
  error,
  onCancel,
  onConfirm,
}: {
  user: AppUserRow;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-[420px] border border-neutral-300 bg-white p-4">
        <div className="border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-missed-fg uppercase">Delete user</div>
          <h2 className="mt-1 font-heading text-lg font-semibold">{user.displayName || user.email}</h2>
          <div className="text-[12.5px] text-neutral-600">
            {user.email} · {roleLabel(user.role)}
            {user.technicianId ? ' · has a linked technician record' : ''}
          </div>
        </div>

        <div className="mt-3 text-[12.5px] text-ink">
          This permanently removes their sign-in, their user record{user.technicianId ? ', and their linked technician record' : ''}
          . This cannot be undone. Only do this for an account with no jobs, visits, reports, or photos attached.
        </div>

        {error && <div className="mt-2 text-[11.5px] text-missed-fg">{error}</div>}

        <div className="mt-3.5 flex gap-1.5">
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="cursor-pointer bg-missed px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isDeleting ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const currentUserId = session?.user.id;
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [drawer, setDrawer] = useState<'closed' | 'add' | { edit: AppUserRow } | { created: CreatedUser }>('closed');
  const [deletingUser, setDeletingUser] = useState<AppUserRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Transient bottom-right confirmation toast — same pattern already used
  // in JobsGrid.tsx ("Saved") and ThisWeekPage.tsx ("Booked — ...").
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast(message);
    toastTimeoutRef.current = setTimeout(() => setToast(null), 2500);
  };

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const { data: users = [], isLoading, isError, error } = useQuery({ queryKey: ['users'], queryFn: listUsers });

  const setActiveMutation = useMutation({
    mutationFn: ({ userId, isActive }: { userId: string; isActive: boolean }) => setUserActive(userId, isActive),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['technicians'] });
      showToast(variables.isActive ? 'User reactivated' : 'User deactivated');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => deleteUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['technicians'] });
      setDeletingUser(null);
      setDeleteError(null);
      showToast('User deleted');
    },
    onError: (err) => setDeleteError(err instanceof Error ? err.message : 'Failed to delete user.'),
  });

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return users.filter((u) => {
      if (tab === 'technicians' && u.role !== 'technician') return false;
      if (tab === 'administrators' && u.role !== 'manager') return false;
      // "Inactive" is the only tab that filters by status — every other tab
      // (All users/Technicians/Administrators) shows a user regardless of
      // active state, exactly like "All users" should read literally.
      if (tab === 'inactive' && u.isActive) return false;
      if (!query) return true;
      const haystack = `${u.displayName ?? ''} ${u.email ?? ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [users, tab, q]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-none items-center gap-4 px-5 pt-4 pb-3">
          <div>
            <h1 className="font-heading text-[26px] leading-none font-semibold text-ink">Users</h1>
            <p className="mt-1 text-[13px] text-neutral-600">
              Manage administrators and technicians who use Kind Contractors.
            </p>
          </div>
          <button
            onClick={() => setDrawer('add')}
            className="ml-auto flex-none cursor-pointer bg-teal px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
          >
            + Add team member
          </button>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2 border-y border-neutral-300 bg-neutral-100 px-5 py-2.5">
          <div className="flex border border-neutral-300 bg-white">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`border-l border-neutral-300 px-3 py-1.5 text-xs first:border-l-0 ${
                  tab === t.key ? 'bg-teal font-semibold text-white' : 'cursor-pointer text-neutral-700 hover:bg-neutral-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or email…"
            className="w-[220px] border border-neutral-300 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-teal"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {isLoading ? (
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading users…</div>
          ) : isError ? (
            <div className="border border-missed bg-missed/10 p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">Couldn't load users</div>
              <div className="mt-1.5 text-[13px] text-ink">{error instanceof Error ? error.message : 'Something went wrong.'}</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">No users match</div>
            </div>
          ) : (
            <table className="w-full border border-neutral-300 bg-white text-left text-[13px]">
              <thead>
                <tr className="border-b border-neutral-300 bg-neutral-100 font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">App access</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last login</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="border-b border-divider last:border-b-0 hover:bg-neutral-100">
                    <td className="px-3 py-2 font-semibold text-ink">
                      {u.displayName || '—'}
                      {u.id === currentUserId && <span className="ml-1.5 font-normal text-neutral-400">(you)</span>}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">{u.email ?? '—'}</td>
                    <td className="px-3 py-2 text-neutral-600">{roleLabel(u.role)}</td>
                    <td className="px-3 py-2">
                      {/* Whether this technician-role user is cross-linked to a real `technicians` row (technicianId) — the Schedule page's own technician list, not this login itself. Doesn't apply to administrators, so they get a plain dash rather than a misleading "Not linked". */}
                      {u.role === 'technician' ? (
                        <span
                          className={`border px-1.5 py-0.5 text-[11px] ${
                            u.technicianId
                              ? 'border-teal bg-teal-100 text-teal-700'
                              : 'border-neutral-300 bg-neutral-100 text-neutral-500'
                          }`}
                        >
                          {u.technicianId ? 'Linked' : 'Not linked'}
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`border px-1.5 py-0.5 text-[11px] ${
                          u.isActive ? 'border-teal bg-teal-100 text-teal-700' : 'border-neutral-300 bg-neutral-100 text-neutral-500'
                        }`}
                      >
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-neutral-600">
                      {u.lastSignInAt ? LAST_LOGIN_FORMAT.format(new Date(u.lastSignInAt)) : 'Never'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2.5">
                        <button onClick={() => setDrawer({ edit: u })} className="cursor-pointer text-[12px] text-teal-700 hover:underline">
                          Edit
                        </button>
                        <button
                          onClick={() => setActiveMutation.mutate({ userId: u.id, isActive: !u.isActive })}
                          disabled={setActiveMutation.isPending || u.id === currentUserId}
                          title={u.id === currentUserId ? "You can't deactivate your own account." : undefined}
                          className="cursor-pointer text-[12px] text-teal-700 hover:underline disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline disabled:opacity-60"
                        >
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                        <button
                          onClick={() => {
                            setDeleteError(null);
                            setDeletingUser(u);
                          }}
                          disabled={u.id === currentUserId}
                          title={u.id === currentUserId ? "You can't delete your own account." : undefined}
                          className="cursor-pointer text-[12px] text-missed-fg hover:underline disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline disabled:opacity-60"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {drawer === 'add' && <UserFormDrawer editingUser={null} onClose={() => setDrawer('closed')} onCreated={(result) => setDrawer({ created: result })} />}
      {typeof drawer === 'object' && 'edit' in drawer && (
        <UserFormDrawer
          editingUser={drawer.edit}
          onClose={() => setDrawer('closed')}
          onCreated={() => setDrawer('closed')}
          onSaved={() => showToast('User saved')}
        />
      )}
      {typeof drawer === 'object' && 'created' in drawer && (
        <CreatedUserPanel result={drawer.created} onClose={() => setDrawer('closed')} />
      )}
      {deletingUser && (
        <DeleteConfirmDialog
          user={deletingUser}
          isDeleting={deleteMutation.isPending}
          error={deleteError}
          onCancel={() => (deleteMutation.isPending ? null : setDeletingUser(null))}
          onConfirm={() => deleteMutation.mutate(deletingUser.id)}
        />
      )}

      {toast && (
        <div className="pointer-events-none absolute right-3 bottom-3 z-10 border border-teal-700 bg-teal-100 px-3 py-1.5 text-[12px] font-semibold text-teal-700 shadow-md">
          {toast}
        </div>
      )}
    </div>
  );
}
