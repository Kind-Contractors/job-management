import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createUser,
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

/**
 * The right-side "Add user" / "Edit user" panel — same drawer shell
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
}: {
  editingUser: AppUserRow | null;
  onClose: () => void;
  onCreated: (result: CreatedUser) => void;
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
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create user.'),
  });

  const updateMutation = useMutation({
    mutationFn: () => updateUser({ userId: editingUser!.id, firstName, lastName }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to update user.'),
  });

  const pending = createMutation.isPending || updateMutation.isPending;
  const canSubmit = firstName.trim().length > 0 && (isEdit || email.trim().length > 0);

  return (
    <div className="flex w-[380px] flex-none flex-col overflow-y-auto border-l border-neutral-300 bg-white shadow-[-2px_0_8px_rgba(0,0,0,0.04)]">
      <div className="flex items-start gap-2 border-b border-neutral-300 bg-teal-100 px-5 py-4">
        <div className="min-w-0">
          <div className="font-heading text-[10px] font-semibold tracking-[0.14em] text-teal-700 uppercase">Users</div>
          <h2 className="mt-0.5 font-heading text-xl leading-tight font-semibold text-ink">
            {isEdit ? 'Edit user' : 'Add user'}
          </h2>
        </div>
        <button onClick={onClose} title="Close" aria-label="Close" className="ml-auto cursor-pointer px-1 text-neutral-600 hover:text-ink">
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-2.5 px-5 py-4">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          First name
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Last name
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        {isEdit ? (
          <>
            <div className="text-[11.5px] text-neutral-500">
              Email: <span className="text-neutral-700">{editingUser!.email ?? '—'}</span>
            </div>
            <div className="text-[11.5px] text-neutral-500">
              Role: <span className="text-neutral-700">{roleLabel(editingUser!.role)}</span> — not editable here.
            </div>
          </>
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
            <div className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Role
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
            </div>
            {role === 'technician' && (
              <div className="text-[11px] leading-relaxed text-neutral-500">
                A technician record is created and linked automatically — they'll appear in the Schedule's technician
                list right away.
              </div>
            )}
          </>
        )}

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

        <div className="mt-1 flex gap-1.5">
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

/** Shown once, right after a successful create — the only time the temporary password is ever visible. */
function CreatedUserPanel({ result, onClose }: { result: CreatedUser; onClose: () => void }) {
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
          <div className="font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Email</div>
          <div className="text-[13px] text-ink">{result.email}</div>
          <div className="mt-2 font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
            Temporary password
          </div>
          <div className="font-mono text-[13px] text-ink">{result.tempPassword}</div>
        </div>
        <button onClick={onClose} className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
          Done
        </button>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [drawer, setDrawer] = useState<'closed' | 'add' | { edit: AppUserRow } | { created: CreatedUser }>('closed');

  const { data: users = [], isLoading, isError, error } = useQuery({ queryKey: ['users'], queryFn: listUsers });

  const setActiveMutation = useMutation({
    mutationFn: ({ userId, isActive }: { userId: string; isActive: boolean }) => setUserActive(userId, isActive),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['technicians'] });
    },
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
    <div className="flex min-h-0 flex-1">
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
            + Add user
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
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last login</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="border-b border-divider last:border-b-0 hover:bg-neutral-100">
                    <td className="px-3 py-2 font-semibold text-ink">{u.displayName || '—'}</td>
                    <td className="px-3 py-2 text-neutral-600">{u.email ?? '—'}</td>
                    <td className="px-3 py-2 text-neutral-600">{roleLabel(u.role)}</td>
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
                          disabled={setActiveMutation.isPending}
                          className="cursor-pointer text-[12px] text-teal-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
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
        <UserFormDrawer editingUser={drawer.edit} onClose={() => setDrawer('closed')} onCreated={() => setDrawer('closed')} />
      )}
      {typeof drawer === 'object' && 'created' in drawer && (
        <CreatedUserPanel result={drawer.created} onClose={() => setDrawer('closed')} />
      )}
    </div>
  );
}
