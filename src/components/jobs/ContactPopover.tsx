import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobContactSummary } from '../../domain/types';
import { listJobRows } from '../../repository/jobsRepository';
import { createContactForClient, updateContact, type ContactFieldsInput } from '../../repository/contactsRepository';
import { resolveDisplayContact } from '../../lib/contactDisplay';

interface ContactPopoverProps {
  clientId: string;
  clientName: string;
  onClose: () => void;
}

interface ContactFormState {
  name: string;
  email: string;
  phoneNumber: string;
  isPrimary: boolean;
}

function toFormState(c: JobContactSummary): ContactFormState {
  return { name: c.name, email: c.email ?? '', phoneNumber: c.phoneNumber ?? '', isPrimary: c.isPrimary };
}

const BLANK_FORM: ContactFormState = { name: '', email: '', phoneNumber: '', isPrimary: false };

/**
 * A small modal overlay (not an AG Grid cell editor) — contact selection/
 * creation needs more than one value at a time and can involve picking
 * among several existing contacts, which doesn't fit JobsGrid's normal
 * inline-cell-edit pattern. Every write goes through
 * contactsRepository.ts's createContactForClient()/updateContact() —
 * always by the contact's real id, never inferred by matching name/email —
 * so this never creates a duplicate on an ordinary field edit, and never
 * touches an unrelated contact.
 */
export default function ContactPopover({ clientId, clientName, onClose }: ContactPopoverProps) {
  const queryClient = useQueryClient();
  const { data: jobRows = [] } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  // Any job at this client carries the exact same clientContacts list
  // (contacts are client-level, not per-job) — the first match is enough.
  const contacts = jobRows.find((j) => j.clientId === clientId)?.clientContacts ?? [];

  const initialDisplay = resolveDisplayContact(contacts);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialDisplay.kind === 'single' || initialDisplay.kind === 'primary' ? initialDisplay.contact.id : null,
  );
  const [adding, setAdding] = useState(contacts.length === 0);
  const [form, setForm] = useState<ContactFormState>(BLANK_FORM);
  const [error, setError] = useState<string | null>(null);

  const selected = contacts.find((c) => c.id === selectedId) ?? null;

  // Reseeds the edit form whenever the selected contact changes (or the
  // underlying data refreshes after a save) — same pattern as
  // InvoiceEditor.tsx's own seed-on-load effect.
  useEffect(() => {
    if (selected) setForm(toFormState(selected));
  }, [selected]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['jobRows'] });

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<ContactFieldsInput>) => {
      if (!selected) throw new Error('No contact selected.');
      return updateContact(selected.id, clientId, patch);
    },
    onSuccess: () => {
      invalidate();
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save contact.'),
  });

  const createMutation = useMutation({
    mutationFn: (input: ContactFieldsInput) => createContactForClient(clientId, input),
    onSuccess: (created) => {
      invalidate();
      setAdding(false);
      setSelectedId(created.id);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create contact.'),
  });

  const selectContact = (contact: JobContactSummary) => {
    setSelectedId(contact.id);
    setAdding(false);
    setError(null);
  };

  const startAdding = () => {
    setAdding(true);
    setSelectedId(null);
    setForm({ ...BLANK_FORM, isPrimary: contacts.length === 0 });
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-[420px] overflow-y-auto border border-neutral-300 bg-white p-4"
      >
        <div className="flex items-center gap-2 border-b border-divider pb-2.5">
          <div>
            <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Contact</div>
            <h2 className="font-heading text-lg leading-tight font-semibold">{clientName}</h2>
          </div>
          <button onClick={onClose} className="ml-auto cursor-pointer text-[11.5px] text-neutral-500 hover:text-ink">
            Close
          </button>
        </div>

        {contacts.length === 0 ? (
          <div className="mt-2.5 text-[12.5px] text-neutral-500">No contacts for this client yet.</div>
        ) : (
          <div className="mt-2.5 flex flex-col gap-1">
            {contacts.map((c) => (
              <div
                key={c.id}
                onClick={() => selectContact(c)}
                className={`cursor-pointer border px-2 py-1.5 text-[12.5px] ${
                  selectedId === c.id && !adding ? 'border-teal bg-teal-100' : 'border-neutral-300 hover:bg-neutral-100'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-ink">{c.name}</span>
                  {c.isPrimary && (
                    <span className="border border-teal-700 bg-teal-100 px-1 text-[9.5px] font-semibold tracking-[0.08em] text-teal-700 uppercase">
                      Primary
                    </span>
                  )}
                </div>
                <div className="text-neutral-600">{[c.email, c.phoneNumber].filter(Boolean).join(' · ') || 'No email or phone on file'}</div>
              </div>
            ))}
          </div>
        )}

        {!adding && (
          <button
            onClick={startAdding}
            className="mt-2 cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100"
          >
            + Add new contact
          </button>
        )}

        {(selected || adding) && (
          <div className="mt-2.5 flex flex-col gap-1.5 border-t border-divider pt-2.5">
            <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
              {adding ? 'New contact' : 'Edit contact'}
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Name
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Email
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Phone
              <input
                value={form.phoneNumber}
                onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>
            <label className="flex items-center gap-1.5 text-[11.5px] text-neutral-700">
              <input
                type="checkbox"
                checked={form.isPrimary}
                onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
              />
              Set as this client's primary contact
            </label>
            {form.isPrimary && contacts.some((c) => c.isPrimary && c.id !== selectedId) && (
              <div className="text-[11px] text-due-fg">This will replace the client's current primary contact.</div>
            )}

            {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

            <div className="flex gap-1.5">
              <button
                onClick={() => {
                  if (!form.name.trim()) {
                    setError('Enter a name.');
                    return;
                  }
                  const input: ContactFieldsInput = {
                    name: form.name.trim(),
                    email: form.email.trim() || null,
                    phoneNumber: form.phoneNumber.trim() || null,
                    isPrimary: form.isPrimary,
                  };
                  if (adding) createMutation.mutate(input);
                  else updateMutation.mutate(input);
                }}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createMutation.isPending || updateMutation.isPending ? 'Saving…' : adding ? 'Create contact' : 'Save changes'}
              </button>
              {adding && (
                <button
                  onClick={() => {
                    setAdding(false);
                    setError(null);
                    const fallback = resolveDisplayContact(contacts);
                    setSelectedId(fallback.kind === 'single' || fallback.kind === 'primary' ? fallback.contact.id : null);
                  }}
                  className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-[11.5px] text-neutral-600"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}