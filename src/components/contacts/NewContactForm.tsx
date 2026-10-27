import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Contact } from '../../domain/types';
import { createContactForClient } from '../../repository/contactsRepository';
import { ACCOUNTS_ONLY_HINT, ACCOUNTS_ONLY_LABEL, BLANK_CONTACT_FORM, checkContactForm, duplicateEmailWarning, normalEmail, type ContactFormFields } from '../../lib/contactForm';

export interface NewContactFormProps {
  /** The client the contact is created for (contacts are client-level, shared by all its buildings and jobs). */
  clientId: string;
  title: string;
  /** The client's current contacts (for the duplicate-email warning and the primary-contact note). */
  contacts: Pick<Contact, 'id' | 'name' | 'email' | 'isPrimary'>[];
  /** The invoice screen's new recipient needs a valid email (see checkContactForm). */
  requireEmail?: boolean;
  /** Queries that show this client's contacts, refreshed after a save. onCreated runs once they have reloaded. */
  refreshKeys: QueryKey[];
  /** Shown above the buttons (for example, what saving does and does not do). */
  note?: ReactNode;
  onCancel: () => void;
  onCreated: (contact: Contact) => void;
}

/**
 * The "new contact" form shared by the Building File and the invoice screen: the same fields, checks (checkContactForm) and save
 * (createContactForClient) as All Live Jobs' contact popover. It creates the contact in the app only - nothing is created in or
 * linked to Xero, and nothing else is saved or sent.
 *
 * An email another contact of this client already has is not saved straight away: a warning names that contact and the manager
 * must confirm ("Add as a separate contact"). One accounts mailbox may need several contacts, each linked to a different Xero
 * contact (one per building). Changing the email withdraws the confirmation. The existing contact is never changed.
 */
export default function NewContactForm({ clientId, title, contacts, requireEmail = false, refreshKeys, note, onCancel, onCreated }: NewContactFormProps) {
  const queryClient = useQueryClient();
  // The client's first contact defaults to primary, as in All Live Jobs.
  const [form, setForm] = useState<ContactFormFields>({ ...BLANK_CONTACT_FORM, isPrimary: contacts.length === 0 });
  const [error, setError] = useState<string | null>(null);
  // Set when the last save attempt found the email on another contact: which email (normalised) and whose. Shown only while the
  // email field still holds that same address.
  const [duplicate, setDuplicate] = useState<{ email: string; name: string } | null>(null);
  const duplicateShown = duplicate !== null && duplicate.email === normalEmail(form.email);

  const createMutation = useMutation({
    mutationFn: async (input: Parameters<typeof createContactForClient>[1]) => {
      const created = await createContactForClient(clientId, input);
      // Wait for the lists that show this client's contacts to reload, so the new contact can be chosen straight away.
      await Promise.all(refreshKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      return created;
    },
    onSuccess: (created) => onCreated(created),
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create contact.'),
  });

  // allowDuplicateEmail is passed only from the warning's own confirm button, for the address that warning names.
  const submit = (allowDuplicateEmail = false) => {
    const checked = checkContactForm(form, contacts, null, { requireEmail, allowDuplicateEmail });
    if (!checked.ok) {
      if (checked.duplicateOf) {
        setDuplicate({ email: normalEmail(form.email), name: checked.duplicateOf.name });
        setError(null);
      } else {
        setDuplicate(null);
        setError(checked.error);
      }
      return;
    }
    setError(null);
    createMutation.mutate(checked.input);
  };

  return (
    <div data-testid="new-contact-form" className="flex flex-col gap-1.5">
      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">{title}</div>
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Name
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          aria-required="true"
          autoFocus
          className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Email
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          aria-required={requireEmail ? 'true' : undefined}
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
        <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} />
        Set as this client&apos;s primary contact
      </label>
      {/* Unchecked for every new contact: being accounts-only is always Luke's explicit choice, never inferred. */}
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
      {form.isPrimary && contacts.some((c) => c.isPrimary) && (
        <div className="text-[11px] text-due-fg">This will replace the client&apos;s current primary contact.</div>
      )}
      {note}
      {duplicateShown && duplicate && (
        <div role="alert" data-testid="duplicate-email-warning" className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
          {duplicateEmailWarning(duplicate.name)}
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={createMutation.isPending}
              className="cursor-pointer border border-due-fg px-2 py-1 text-[11px] font-semibold text-due-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              Add as a separate contact
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="text-[11.5px] text-missed-fg">
          {error}
        </div>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => submit()}
          disabled={createMutation.isPending}
          className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {createMutation.isPending ? 'Saving…' : 'Create contact'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={createMutation.isPending}
          className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-[11.5px] text-neutral-600 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
