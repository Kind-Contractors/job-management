import { useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Contact } from '../../domain/types';
import { updateContact, type ContactFieldsInput } from '../../repository/contactsRepository';
import { ACCOUNTS_ONLY_HINT, ACCOUNTS_ONLY_LABEL, checkContactForm, duplicateEmailWarning, normalEmail, type ContactFormFields } from '../../lib/contactForm';

/** The form starts from the SAVED values (including primary and accounts-only), so saving one field never changes another. */
export function editFormFrom(c: Pick<Contact, 'name' | 'email' | 'phoneNumber' | 'isPrimary' | 'isAccountsContact'>): ContactFormFields {
  return { name: c.name, email: c.email ?? '', phoneNumber: c.phoneNumber ?? '', isPrimary: c.isPrimary, isAccountsContact: c.isAccountsContact === true };
}

/** Only the fields that differ from the saved contact: nothing unchanged is written (updateContact logs a history entry for real changes). */
export function changedFields(saved: ContactFormFields, input: ContactFieldsInput): Partial<ContactFieldsInput> {
  const patch: Partial<ContactFieldsInput> = {};
  if (input.name !== saved.name) patch.name = input.name;
  if ((input.email ?? '') !== saved.email) patch.email = input.email;
  if ((input.phoneNumber ?? '') !== saved.phoneNumber) patch.phoneNumber = input.phoneNumber;
  if (input.isPrimary !== saved.isPrimary) patch.isPrimary = input.isPrimary;
  if (input.isAccountsContact !== saved.isAccountsContact) patch.isAccountsContact = input.isAccountsContact;
  return patch;
}

interface EditContactFormProps {
  clientId: string;
  clientName: string;
  contact: Contact;
  /** The client's contacts (duplicate-email check, primary note). */
  contacts: Pick<Contact, 'id' | 'name' | 'email' | 'isPrimary'>[];
  /** How many buildings share this client's contacts (the main-contact note says the change applies to all of them). */
  buildingCount: number;
  refreshKeys: QueryKey[];
  onCancel: () => void;
  onSaved: (contact: Contact, changed: boolean) => void;
}

/**
 * Edits one existing contact by its id (contactsRepository.updateContact): name, email, phone, main contact and accounts-only.
 * The same checks as every other contact form (lib/contactForm.ts); an email another contact of this client already has needs
 * the same explicit confirmation as when adding. Its Xero link is not changed here (that is the separate Link / Change action).
 */
export default function EditContactForm({ clientId, clientName, contact, contacts, buildingCount, refreshKeys, onCancel, onSaved }: EditContactFormProps) {
  const queryClient = useQueryClient();
  const saved = editFormFrom(contact);
  const [form, setForm] = useState<ContactFormFields>(saved);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ email: string; name: string } | null>(null);
  const duplicateShown = duplicate !== null && duplicate.email === normalEmail(form.email);

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<ContactFieldsInput>) => {
      await updateContact(contact.id, clientId, patch);
      await Promise.all(refreshKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onSuccess: () => onSaved(contact, true),
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save contact.'),
  });

  const submit = (allowDuplicateEmail = false) => {
    const checked = checkContactForm(form, contacts, contact.id, { allowDuplicateEmail });
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
    const patch = changedFields(saved, checked.input);
    if (Object.keys(patch).length === 0) {
      onSaved(contact, false);
      return;
    }
    setError(null);
    saveMutation.mutate(patch);
  };

  const otherMain = contacts.find((c) => c.isPrimary && c.id !== contact.id);
  const everywhere = buildingCount > 1 ? `all ${buildingCount} of ${clientName || 'this client'}'s buildings` : `${clientName || 'this client'}'s buildings`;

  return (
    <div data-testid="edit-contact-form" className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Name
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          aria-required="true"
          autoFocus
          className="border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
        />
      </label>
      <div className="flex gap-2">
        <label className="flex flex-[3] flex-col gap-1 text-[11px] text-neutral-600">
          Email
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>
        <label className="flex flex-[2] flex-col gap-1 text-[11px] text-neutral-600">
          Phone
          <input
            value={form.phoneNumber}
            onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
            className="border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>
      </div>
      <label className="flex items-start gap-1.5 text-[11.5px] text-neutral-700">
        <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} className="mt-0.5" />
        <span>
          Main contact
          <span className="block text-[11px] text-neutral-500">The default recipient of job reports and the contact shown in the jobs grid, for {everywhere}.</span>
        </span>
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
      {form.isPrimary && !saved.isPrimary && otherMain && (
        <div className="text-[11px] text-due-fg">This replaces {otherMain.name} as the main contact, for {everywhere}.</div>
      )}
      {!form.isPrimary && saved.isPrimary && (
        <div className="text-[11px] text-due-fg">With no main contact, job reports have no default recipient unless this client has only one other contact.</div>
      )}
      {form.isPrimary && form.isAccountsContact && (
        <div className="text-[11px] text-due-fg">An accounts-only contact is never used as the job-report default, even as the main contact.</div>
      )}
      {duplicateShown && duplicate && (
        <div role="alert" data-testid="duplicate-email-warning" className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
          {duplicateEmailWarning(duplicate.name)}
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={saveMutation.isPending}
              className="cursor-pointer border border-due-fg px-2 py-1 text-[11px] font-semibold text-due-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              Keep this email as well
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
          disabled={saveMutation.isPending}
          className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saveMutation.isPending}
          className="cursor-pointer border border-neutral-300 bg-white px-2.5 py-1.5 text-[11.5px] text-neutral-600 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
