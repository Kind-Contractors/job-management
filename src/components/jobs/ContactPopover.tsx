import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JobContactSummary } from '../../domain/types';
import { listJobRows } from '../../repository/jobsRepository';
import { createContactForClient, updateContact, type ContactFieldsInput } from '../../repository/contactsRepository';
import { resolveDisplayContact } from '../../lib/contactDisplay';
import { ACCOUNTS_ONLY_HINT, ACCOUNTS_ONLY_LABEL, checkContactForm } from '../../lib/contactForm';
import { linkStatusLabel, localLinkStatus, VERIFY_STATE_TEXT } from '../../lib/xeroLinkStatus';
import { unlinkContact, verifyContactLink, type XeroLinkVerification } from '../../repository/xeroLinksRepository';
import LinkXeroContactDialog from './LinkXeroContactDialog';
import { backdropDismiss } from '../../lib/dialogHooks';

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
  isAccountsContact: boolean;
}

// The edit form starts from the SAVED values - including the accounts-only flag - so saving other fields never changes it.
function toFormState(c: JobContactSummary): ContactFormState {
  return { name: c.name, email: c.email ?? '', phoneNumber: c.phoneNumber ?? '', isPrimary: c.isPrimary, isAccountsContact: c.isAccountsContact === true };
}

const BLANK_FORM: ContactFormState = { name: '', email: '', phoneNumber: '', isPrimary: false, isAccountsContact: false };

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
  // Closes on a backdrop click only when the press also started on the backdrop (never mid-typing: see backdropDismiss).
  const backdrop = backdropDismiss(onClose);
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
  const [linking, setLinking] = useState(false);
  const [verification, setVerification] = useState<XeroLinkVerification | null>(null);

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

  const verifyMutation = useMutation({
    mutationFn: (id: string) => verifyContactLink(id),
    onSuccess: (v) => {
      setVerification(v);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The link could not be verified.'),
  });

  const unlinkMutation = useMutation({
    mutationFn: (id: string) => unlinkContact(id),
    onSuccess: () => {
      invalidate();
      setVerification(null);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The link could not be removed.'),
  });

  const selectContact = (contact: JobContactSummary) => {
    setVerification(null);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" {...backdrop}>
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
                  {c.isAccountsContact && (
                    <span className="border border-teal-700 bg-teal-100 px-1 text-[9.5px] font-semibold tracking-[0.08em] text-teal-700 uppercase">
                      Accounts only
                    </span>
                  )}
                </div>
                <div className="text-neutral-600">{[c.email, c.phoneNumber].filter(Boolean).join(' · ') || 'No email or phone on file'}</div>
                <div className={localLinkStatus(c) === 'linked' ? 'text-[11px] text-teal-700' : 'text-[11px] text-due-fg'}>{linkStatusLabel(c)}</div>
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

        {selected && !adding && (
          <div className="mt-2.5 flex flex-col gap-1.5 border-t border-divider pt-2.5">
            <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Xero link</div>
            <div className="text-[12px] text-ink">{linkStatusLabel(selected)}</div>
            {verification && (
              <div className={`text-[11.5px] ${VERIFY_STATE_TEXT[verification.state].ok ? 'text-teal-700' : 'text-missed-fg'}`}>
                {VERIFY_STATE_TEXT[verification.state].text}
                {verification.nameChanged ? ' The name in Xero has changed since it was linked.' : ''}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setLinking(true)}
                className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100"
              >
                {localLinkStatus(selected) === 'not_linked' ? 'Link to Xero contact…' : 'Change link…'}
              </button>
              {localLinkStatus(selected) !== 'not_linked' && (
                <>
                  <button
                    onClick={() => verifyMutation.mutate(selected.id)}
                    disabled={verifyMutation.isPending}
                    className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                  >
                    {verifyMutation.isPending ? 'Checking…' : 'Verify link'}
                  </button>
                  <button
                    onClick={() => unlinkMutation.mutate(selected.id)}
                    disabled={unlinkMutation.isPending}
                    className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                  >
                    {unlinkMutation.isPending ? 'Removing…' : 'Unlink'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {linking && selected && (
          <LinkXeroContactDialog
            localContactId={selected.id}
            localContactName={selected.name}
            localContactEmail={selected.email}
            suggestedTerm={clientName}
            currentXeroContactId={selected.xeroContactId}
            onClose={() => setLinking(false)}
            onLinked={() => {
              setVerification(null);
              invalidate();
            }}
          />
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
            <label className="flex items-start gap-1.5 text-[11.5px] text-neutral-700">
              <input
                type="checkbox"
                checked={form.isAccountsContact}
                onChange={(e) => setForm({ ...form, isAccountsContact: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                {ACCOUNTS_ONLY_LABEL}
                <span className="block text-[11px] text-neutral-500">{ACCOUNTS_ONLY_HINT}</span>
              </span>
            </label>
            {form.isPrimary && contacts.some((c) => c.isPrimary && c.id !== selectedId) && (
              <div className="text-[11px] text-due-fg">This will replace the client's current primary contact.</div>
            )}

            {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

            <div className="flex gap-1.5">
              <button
                onClick={() => {
                  // The same checks as the Building File's Add contact (lib/contactForm.ts).
                  const checked = checkContactForm(form, contacts, adding ? null : selectedId);
                  if (!checked.ok) {
                    setError(checked.error);
                    return;
                  }
                  const input: ContactFieldsInput = checked.input;
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