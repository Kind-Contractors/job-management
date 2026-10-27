import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuildingDefaultRecipient, InvoiceLineItem, JobContactSummary } from '../../domain/types';
import {
  discardInvoiceDraft,
  getInvoice,
  getXeroInvoiceCapabilities,
  sendInvoice,
  updateInvoiceDraft,
  updateInvoiceLineItem,
} from '../../repository/invoicesRepository';
import { LOCKED_RECIPIENT_MESSAGE, RECIPIENT_UNAVAILABLE_MESSAGE, recipientSelectionState, resolveSendRecipientId, sendAttemptOutcome } from '../../lib/invoiceRecipient';
import { canSendInvoiceTo, defaultRecipientProblem, isUsableRecipient, isValidEmail, linkStatusLabel } from '../../lib/xeroLinkStatus';
import LinkXeroContactDialog from './LinkXeroContactDialog';
import { getAutoInvoiceEmailSetting } from '../../repository/appSettingsRepository';
import { deliveryLine, sendResultMessage } from '../../lib/invoiceDelivery';
import { AUTO_INVOICE_EMAIL_QUERY_KEY } from '../settings/AutoInvoiceEmailSetting';
import UnlinkedRecipientsList, { refreshAfterXeroLink } from './UnlinkedRecipientsList';
import NewContactForm from '../contacts/NewContactForm';
import { invoiceActionMode, needsXeroContactChoice } from '../../lib/invoiceActionMode';

/** Query key of the read-only check of what this system's server-side switches allow (wording only; the server decides). */
export const XERO_INVOICE_CAPABILITIES_QUERY_KEY = ['xeroInvoiceCapabilities'] as const;

function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ADD_NEW_CONTACT_VALUE = '__add_new__';

interface InvoiceEditorProps {
  invoiceId: string;
  onClose: () => void;
  /** The job's client: a contact added here ("+ Add another email address") is created for it. */
  clientId: string;
  /** The client's name, shown on the new-contact form. */
  clientName?: string;
  /** All of the client's contacts (with or without an email) — the same list ContactPopover/JobsGrid use, passed down so this never needs its own fetch. */
  clientContacts: JobContactSummary[];
  /** The building's saved default invoice recipient, or null/omitted when none has been chosen. Never guessed from the contacts. */
  buildingDefault?: BuildingDefaultRecipient | null;
}

/**
 * Review-and-edit panel for a draft invoice, shown before Send — reuses the
 * same inline-panel style as ScheduleEditor/JobEditor rather than a new
 * modal/page. Covers both the "normal" (one visit) and "combined" (several
 * manager-selected visits) cases identically: both are just however many
 * line items the invoice was created with.
 */
export default function InvoiceEditor({ invoiceId, onClose, clientId, clientName = '', clientContacts, buildingDefault = null }: InvoiceEditorProps) {
  const queryClient = useQueryClient();
  const { data: invoice, isLoading } = useQuery({ queryKey: ['invoice', invoiceId], queryFn: () => getInvoice(invoiceId) });
  // For the button's wording and the notes beside it only. Whether an invoice is emailed is decided by the server when it is
  // submitted: the app toggle AND the system's XERO_SENDING_ENABLED, re-checked there (the toggle never overrides the switch).
  const autoEmail = useQuery({ queryKey: AUTO_INVOICE_EMAIL_QUERY_KEY, queryFn: getAutoInvoiceEmailSetting });
  const capabilities = useQuery({ queryKey: XERO_INVOICE_CAPABILITIES_QUERY_KEY, queryFn: getXeroInvoiceCapabilities, retry: false, staleTime: 60_000 });
  const mode = invoiceActionMode({
    autoEmailEnabled: autoEmail.isError ? null : (autoEmail.data?.enabled ?? null),
    systemSendingEnabled: capabilities.isError ? null : (capabilities.data?.sendingEnabled ?? null),
  });

  const [description, setDescription] = useState('');
  const [worksOrderNumber, setWorksOrderNumber] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<InvoiceLineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Set after a contact is added from the recipient list: says it was chosen, and that nothing else happened.
  const [contactNotice, setContactNotice] = useState<string | null>(null);
  // The contact just added here: the notice offers to link it to its Xero contact straight away (it cannot be invoiced until it is).
  const [justAdded, setJustAdded] = useState<JobContactSummary | null>(null);
  // The contact the main button was pressed for while it was not linked to Xero: nothing was saved or sent, and the "not linked"
  // explanation is shown as an alert until the choice changes or the contact is linked.
  const [xeroLinkNeededFor, setXeroLinkNeededFor] = useState<string | null>(null);

  // '' = the building's default recipient (or nothing, when there is no usable default); ADD_NEW_CONTACT_VALUE = the
  // "+ Add another email address" option, which opens the new-contact form (nothing can be sent while it is open);
  // anything else is an existing contact's id. A recipient is never preselected by guessing (primary / only contact).
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  // The unlinked contact whose Link button was clicked: opens the shared LinkXeroContactDialog for exactly that contact.
  const [linkingContact, setLinkingContact] = useState<JobContactSummary | null>(null);
  // With automatic emails off the building's default Xero contact is used without a picker; this opens one to choose another.
  const [chooseOtherContact, setChooseOtherContact] = useState(false);

  // Seed local editable state once the invoice loads (or reloads after a send).
  useEffect(() => {
    if (!invoice) return;
    setDescription(invoice.description ?? '');
    setWorksOrderNumber(invoice.worksOrderNumber ?? '');
    setDueDate(invoice.dueDate);
    setLines(invoice.lineItems);
  }, [invoice]);

  // Recipient selection is per-invoice — switching to a different invoice
  // (InvoiceEditor is reused across opens, not remounted) must not carry
  // over a previously selected/typed recipient.
  useEffect(() => {
    setSelectedContactId('');
    setChooseOtherContact(false);
    setContactNotice(null);
    setJustAdded(null);
    setXeroLinkNeededFor(null);
  }, [invoiceId]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };

  const editable = invoice?.status === 'draft' || invoice?.status === 'failed';

  // A 'failed' invoice may already have a real xero_invoice_id (Xero created
  // it, a later step like email failed) — discarding the local row in that
  // state would orphan the real Xero invoice and free the visit for a
  // second one. Discard is only ever safe when no Xero invoice exists yet.
  const canDiscard = editable && !invoice?.xeroInvoiceId;

  // No separate "Save Changes" step — Send invoice always persists the
  // entire current editor state itself, first, before doing anything else.
  // Luke edits freely and Send is the only action he ever needs to take.
  const persistCurrentDraft = async () => {
    await updateInvoiceDraft(invoiceId, { description: description || null, worksOrderNumber: worksOrderNumber || null, dueDate });
    await Promise.all(
      lines.map((line) =>
        updateInvoiceLineItem(line.id, { description: line.description, quantity: line.quantity, unitAmount: line.unitAmount }),
      ),
    );
  };

  const discardMutation = useMutation({
    mutationFn: () => discardInvoiceDraft(invoiceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to discard invoice.'),
  });

  // Once Xero holds the invoice its recipient is locked: the server only ever retries it for the same Xero contact.
  const recipientLocked = !!invoice?.xeroInvoiceId;
  const lockedContact = recipientLocked ? (clientContacts.find((c) => c.xeroContactId && c.xeroContactId === invoice?.xeroContactId) ?? null) : null;
  // The building's default is only offered when it still points at the contact it was chosen with.
  const defaultProblem = defaultRecipientProblem(buildingDefault, clientContacts);
  const defaultContact = buildingDefault && !defaultProblem ? (clientContacts.find((c) => c.id === buildingDefault.contactId) ?? null) : null;
  const usableDefaultContactId = defaultContact && isUsableRecipient(defaultContact) ? defaultContact.id : null;
  // "Send invoice to" is hidden when automatic emails are off. Xero still needs a contact on the invoice: the locked one, the
  // building's default, or - when neither decides it - one the manager chooses (shown as the Xero contact, not a recipient).
  // Nothing is guessed: with no default and no choice, the button stays disabled and the server would refuse as before.
  const showContactPicker = mode.showSendTo || needsXeroContactChoice({ recipientLocked, usableDefault: !!usableDefaultContactId, chooseOther: chooseOtherContact });
  // A choice made while the picker was showing never applies once it is hidden: the default (or locked contact) is used.
  const effectiveContactId = showContactPicker ? selectedContactId : '';
  const addingNewContact = effectiveContactId === ADD_NEW_CONTACT_VALUE;
  const selectedContact = effectiveContactId && !addingNewContact ? (clientContacts.find((c) => c.id === effectiveContactId) ?? null) : null;
  const choosePhrase = mode.showSendTo ? 'who to send this invoice to' : 'the Xero contact this invoice is for';
  // A chosen contact must be in the list shown: one just added may not be there yet if the list failed to reload. Then nothing
  // can be submitted - never the building default or anyone else in its place - until the list is reloaded.
  const recipientUnavailable = !recipientLocked && recipientSelectionState(effectiveContactId, addingNewContact, clientContacts) === 'missing';
  // A recipient is CHOSEN (the button can be pressed) when it is locked, a listed contact - linked to Xero or not - or the usable
  // building default. While the new-contact form is open nothing can be submitted: the contact is saved on its own first. An
  // unlinked choice is stopped on press (sendAttemptOutcome), before anything is saved or sent.
  const recipientChosen = recipientLocked || (!addingNewContact && !recipientUnavailable && (selectedContact ? true : !!usableDefaultContactId));

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Refuse an unlinkable recipient BEFORE anything is saved or created: no local contact is ever created from
      // here, so a failed send can never leave an orphan, unlinked contact behind.
      const contactId = resolveSendRecipientId({
        addingNewContact,
        selectedContactId: effectiveContactId,
        usableDefaultContactId,
        selectedIsLinked: selectedContact ? canSendInvoiceTo(selectedContact) : undefined,
        selectedIsAvailable: !recipientUnavailable,
        recipientLocked,
      });

      // Persist current editor state — xero-create-invoice reads the
      // invoice straight from the database, so whatever's on screen must
      // already be saved before it runs, every time.
      await persistCurrentDraft();

      return sendInvoice(invoiceId, contactId);
    },
    onSuccess: (result) => {
      invalidate();
      setSendResult(sendResultMessage(result));
    },
    // A failed send may have changed the invoice (it is marked failed, with the reason stored), so reload it too.
    onError: (err) => {
      invalidate();
      setSendResult({ ok: false, message: err instanceof Error ? err.message : 'Failed to send.' });
    },
  });

  // Send/Discard are mutually exclusive — while one is running, the other
  // must not be startable (a Discard landing mid-Send could leave a real
  // Xero invoice with no local record at all).
  const anyMutationPending = sendMutation.isPending || discardMutation.isPending;

  if (isLoading || !invoice) {
    return (
      <div className="m-3.5 border border-neutral-300 p-3 text-[12.5px] text-neutral-500">Loading invoice…</div>
    );
  }

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitAmount, 0);
  const estimatedVat = subtotal * 0.2;

  return (
    <div className="mt-3 border border-neutral-300 bg-white p-3">
      <div className="flex items-center gap-2">
        <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
          Invoice · {invoiceStatusLabel(invoice.status)}
        </div>
        <button onClick={onClose} className="ml-auto cursor-pointer text-[11.5px] text-neutral-500 hover:text-ink">
          Close
        </button>
      </div>

      {(invoice.status === 'sent' || invoice.status === 'in_xero_not_emailed') && (
        <div data-testid="invoice-delivery" className="mt-2 border border-teal-700/40 bg-teal-100 p-2 text-[12.5px] text-teal-700">
          {deliveryLine(invoice, clientContacts)}
        </div>
      )}
      {invoice.status === 'failed' && invoice.xeroInvoiceId && (
        <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">
          <div className="font-semibold">
            Xero invoice {invoice.xeroInvoiceNumber} was created, but sending it failed.
          </div>
          <div className="mt-1 text-neutral-600">
            Clicking "{mode.label}" again will update this same Xero invoice with any changes below
            {mode.kind === 'send' ? ' and retry emailing it' : ''} — it will not create another one.
          </div>
          {invoice.lastError && <div className="mt-1">{invoice.lastError}</div>}
        </div>
      )}
      {invoice.status === 'failed' && !invoice.xeroInvoiceId && invoice.lastError && (
        <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">{invoice.lastError}</div>
      )}
      {invoice.status === 'sending' && (
        <div className="mt-2 border border-neutral-300 bg-neutral-100 p-2 text-[12.5px] text-neutral-600">
          In progress — this invoice is being created in Xero (and emailed, if this system and the app allow it)…
        </div>
      )}

      <div className="mt-2.5 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!editable}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
          />
        </label>

        {/* Side by side — both are short fields; stacked full-width (like Description) left a lot of empty space to the right of each one. */}
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
            Invoice reference
            <input
              value={worksOrderNumber}
              onChange={(e) => setWorksOrderNumber(e.target.value)}
              disabled={!editable}
              placeholder="Not provided yet — can be added later, before sending"
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Due date
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={!editable}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
            />
          </label>
        </div>
        <div className="text-[10px] text-neutral-400">Invoice reference is sent to Xero as this invoice's Reference field.</div>

        <div className="text-[11px] text-neutral-600">Line items ({lines.length})</div>
        {lines.map((line, i) => (
          <div key={line.id} className="flex flex-col gap-1 border border-neutral-300 bg-neutral-100 p-2">
            <input
              value={line.description}
              onChange={(e) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, description: e.target.value } : l)))}
              disabled={!editable}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
            />
            <div className="flex gap-1.5">
              <label className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Quantity
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={line.quantity}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, quantity: Number(e.target.value) } : l)))
                  }
                  disabled={!editable}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
                />
              </label>
              <label className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Unit price
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={line.unitAmount}
                  onChange={(e) =>
                    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, unitAmount: Number(e.target.value) } : l)))
                  }
                  disabled={!editable}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
                />
              </label>
              <div className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Line total
                <div className="px-2 py-1 text-[12.5px] tabular-nums text-ink">{money(line.quantity * line.unitAmount)}</div>
              </div>
            </div>
          </div>
        ))}

        <div className="flex flex-col gap-0.5 border-t border-divider pt-1.5 text-[12.5px] tabular-nums">
          <div className="flex justify-between text-neutral-600">
            <span>Subtotal</span>
            <span>{money(subtotal)}</span>
          </div>
          <div className="flex justify-between text-neutral-600">
            <span>VAT (estimated, 20%)</span>
            <span>{money(estimatedVat)}</span>
          </div>
          <div className="flex justify-between font-semibold text-ink">
            <span>Estimated total</span>
            <span>{money(subtotal + estimatedVat)}</span>
          </div>
          <div className="text-[10.5px] text-neutral-500">
            VAT/account code are resolved against Xero when sent — this total is an estimate, not what Xero will charge.
          </div>
        </div>

        {editable && (
          <div className="flex flex-col gap-1.5 border-t border-divider pt-2">
            {!showContactPicker && (
              <div data-testid="invoice-xero-contact" className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">
                {recipientLocked ? (
                  <>
                    Xero contact:{' '}
                    <span className="font-semibold">{lockedContact ? (lockedContact.xeroContactName ?? lockedContact.name) : 'the contact this invoice was created for'}</span>.
                  </>
                ) : (
                  <>
                    Created in Xero for <span className="font-semibold">{defaultContact?.xeroContactName ?? defaultContact?.name}</span>, this building&apos;s
                    default invoice contact. It will not be emailed.{' '}
                    <button
                      type="button"
                      onClick={() => setChooseOtherContact(true)}
                      disabled={anyMutationPending}
                      className="cursor-pointer text-teal-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Use a different contact
                    </button>
                  </>
                )}
              </div>
            )}
            {showContactPicker && !mode.showSendTo && (
              <div data-testid="invoice-xero-contact" className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">
                {usableDefaultContactId ? (
                  <>
                    Choose the Xero contact this invoice is for. It will not be emailed.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setChooseOtherContact(false);
                        setSelectedContactId('');
                      }}
                      disabled={anyMutationPending}
                      className="cursor-pointer text-teal-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Use the building default
                    </button>
                  </>
                ) : (
                  'Xero needs a contact on every invoice, and this building has no usable default invoice contact, so choose which contact this invoice is for. It will not be emailed.'
                )}
              </div>
            )}
            {showContactPicker && (
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              {mode.showSendTo ? 'Send invoice to' : 'Xero contact for this invoice'}
              <select
                value={recipientLocked ? '' : selectedContactId}
                onChange={(e) => {
                  setSelectedContactId(e.target.value);
                  setContactNotice(null);
                  setJustAdded(null);
                  setXeroLinkNeededFor(null);
                }}
                disabled={anyMutationPending || recipientLocked}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
              >
                <option value="" disabled={!usableDefaultContactId}>
                  {recipientLocked
                    ? `Locked: ${lockedContact ? lockedContact.xeroContactName ?? lockedContact.name : 'the contact this invoice was created for'}`
                    : usableDefaultContactId
                      ? `Building default: ${defaultContact?.xeroContactName ?? defaultContact?.name}`
                      : 'Choose a recipient…'}
                </option>
                {/* Shown (not the default) while the chosen contact is missing from the list, so the screen never displays a
                    different recipient from the one chosen. */}
                {recipientUnavailable && (
                  <option value={effectiveContactId} disabled>
                    Chosen contact not loaded yet
                  </option>
                )}
                {clientContacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.email ? ` — ${c.email}` : ''}
                    {isUsableRecipient(c)
                      ? c.xeroContactName
                        ? ` · Xero: ${c.xeroContactName}`
                        : ' · linked to Xero'
                      : ' · not linked to Xero yet'}
                  </option>
                ))}
                <option value={ADD_NEW_CONTACT_VALUE}>+ Add another email address</option>
              </select>
            </label>
            )}

            {!recipientLocked && showContactPicker && <UnlinkedRecipientsList contacts={clientContacts} onLink={setLinkingContact} disabled={anyMutationPending} />}

            {recipientLocked && <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">{LOCKED_RECIPIENT_MESSAGE}</div>}
            {recipientUnavailable && (
              <div data-testid="recipient-unavailable" role="alert" className="border border-missed bg-missed/10 p-2 text-[11.5px] text-missed-fg">
                {RECIPIENT_UNAVAILABLE_MESSAGE}{' '}
                <button
                  type="button"
                  onClick={() => void queryClient.invalidateQueries({ queryKey: ['jobRows'] })}
                  className="cursor-pointer underline"
                >
                  Reload recipients
                </button>
              </div>
            )}
            {!recipientLocked && !effectiveContactId && !usableDefaultContactId && defaultProblem && (
              <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">{defaultProblem}</div>
            )}
            {!recipientLocked && !effectiveContactId && !usableDefaultContactId && !defaultProblem && (
              clientContacts.some(canSendInvoiceTo) ? (
                <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">
                  Choose {choosePhrase}. A contact that is not linked to Xero yet can be chosen; it must be linked to its existing Xero
                  contact before the invoice can be sent.
                </div>
              ) : (
                <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
                  None of this client&apos;s contacts is linked to a Xero contact yet. You can choose any of them, but it must be linked to
                  its existing Xero contact (Link, below) before the invoice can be sent. The app never matches or creates a Xero contact
                  by itself.
                </div>
              )
            )}
            {!recipientLocked && selectedContact && !canSendInvoiceTo(selectedContact) && (
              // Shown as soon as an unlinked contact is chosen; after a press of the main button it becomes an alert that says
              // nothing was saved or sent. Linking stays the explicit, confirmed choice in the shared dialog.
              <div
                data-testid="recipient-not-linked"
                role={xeroLinkNeededFor === selectedContact.id ? 'alert' : undefined}
                className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg"
              >
                {xeroLinkNeededFor === selectedContact.id && <div className="font-semibold">Not sent: a Xero contact is needed.</div>}
                {linkStatusLabel(selectedContact)}. {selectedContact.name} must be linked to their existing Xero contact before this invoice
                can be sent: link them, then press &ldquo;{mode.label}&rdquo; again.
                {xeroLinkNeededFor === selectedContact.id && ' Nothing has been saved or sent.'}
                {!isValidEmail(selectedContact.email) && (
                  <div data-testid="recipient-no-email" className="mt-1">
                    {selectedContact.name} has no email address in the app. The invoice uses the email address held on the Xero contact
                    you link, so choose the Xero contact that has the right invoicing email.
                  </div>
                )}
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => setLinkingContact(selectedContact)}
                    disabled={anyMutationPending}
                    className="cursor-pointer font-semibold underline disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Link to Xero contact
                  </button>
                </div>
              </div>
            )}
            {!addingNewContact && contactNotice && (
              <div role="status" className="border border-teal-700/40 bg-teal-100 p-2 text-[11.5px] text-teal-700">
                {contactNotice}
                {justAdded &&
                  (() => {
                    // The contact as the reloaded list now holds it: once linked, the notice says so instead of offering the link.
                    const current = clientContacts.find((c) => c.id === justAdded.id) ?? justAdded;
                    return isUsableRecipient(current) ? (
                      <> {linkStatusLabel(current)}.</>
                    ) : (
                      <>
                        {' '}
                        It must be linked to its existing Xero contact before the invoice can be submitted.{' '}
                        <button
                          type="button"
                          onClick={() => setLinkingContact(current)}
                          disabled={anyMutationPending}
                          className="cursor-pointer font-semibold underline disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Link to Xero contact now
                        </button>
                      </>
                    );
                  })()}
              </div>
            )}
            <div
              data-testid="invoice-email-notice"
              className={
                mode.notice.warn
                  ? 'border border-due bg-due/10 p-2 text-[11.5px] text-due-fg'
                  : mode.kind === 'send'
                    ? 'text-[10px] text-due-fg'
                    : 'text-[10px] text-neutral-400'
              }
            >
              {mode.notice.text}
            </div>
          </div>
        )}

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}
        {sendResult && (
          <div className={`text-[11.5px] ${sendResult.ok ? 'text-teal-700' : 'text-missed-fg'}`}>{sendResult.message}</div>
        )}

        <div
          data-testid="invoice-actions"
          className="sticky bottom-0 z-10 -mx-3 -mb-3 flex flex-wrap gap-1.5 border-t border-divider bg-white px-3 py-2"
        >
          {editable && (
            <>
              <button
                onClick={() => {
                  setSendResult(null);
                  // An unlinked recipient: nothing is saved or sent; the explanation and the Link action are shown instead.
                  if (sendAttemptOutcome({ recipientLocked, selectedContact }) === 'needs_xero_link') {
                    setXeroLinkNeededFor(selectedContact?.id ?? null);
                    return;
                  }
                  sendMutation.mutate();
                }}
                disabled={anyMutationPending || lines.length === 0 || !recipientChosen}
                className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendMutation.isPending ? mode.pendingLabel : mode.label}
              </button>
              <button
                onClick={() => discardMutation.mutate()}
                disabled={anyMutationPending || !canDiscard}
                title={canDiscard ? undefined : 'A Xero invoice already exists for this record — discard is disabled to avoid orphaning it. Use Send to retry, or fix this in Xero directly.'}
                className="cursor-pointer text-[11px] text-missed-fg hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>

      {editable && !recipientLocked && addingNewContact && (
        // "+ Add another email address": the shared new-contact form in a dialog over the invoice. A new recipient is saved on its
        // own, as an app contact only, then becomes the chosen recipient. It cannot be invoiced until it is linked to its existing
        // Xero contact: the notice offers that next (the shared link dialog). Nothing is created in Xero, and the invoice is not
        // saved or submitted, by adding or linking a contact. Closing the form goes back to the recipient list.
        <NewRecipientDialog clientName={clientName} onClose={() => setSelectedContactId('')}>
          <NewContactForm
            clientId={clientId}
            title="Contact details"
            contacts={clientContacts}
            requireEmail
            refreshKeys={[['jobRows'], ['historicalJobRows'], ['contacts', clientId]]}
            note={
              <div className="text-[11px] text-neutral-600">
                Saves the contact in the app only: nothing is created or linked in Xero. Before this invoice can be submitted, link the
                contact to its existing Xero contact (offered next). This invoice is not saved, created in Xero or emailed until you press
                “{mode.label}”.
              </div>
            }
            onCancel={() => setSelectedContactId('')}
            onCreated={(contact) => {
              setSelectedContactId(contact.id);
              setJustAdded(contact);
              setContactNotice(
                `${contact.name} was added and chosen as the recipient. The invoice has not been saved, created in Xero or emailed.`,
              );
            }}
          />
        </NewRecipientDialog>
      )}

      {linkingContact && (
        <LinkXeroContactDialog
          localContactId={linkingContact.id}
          localContactName={linkingContact.name}
          localContactEmail={linkingContact.email}
          suggestedTerm={linkingContact.name}
          currentXeroContactId={linkingContact.xeroContactId}
          onClose={() => setLinkingContact(null)}
          onLinked={() => refreshAfterXeroLink(queryClient)}
        />
      )}
    </div>
  );
}

function invoiceStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'sending':
      return 'Sending';
    case 'sent':
      return 'Sent';
    case 'failed':
      return 'Failed';
    case 'in_xero_not_emailed':
      return 'In Xero · not emailed';
    default:
      return status;
  }
}

/** The dialog around the new-recipient form: same overlay as the other dialogs here. Close, a click outside or Escape cancels. */
function NewRecipientDialog({ clientName, onClose, children }: { clientName: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Add a new recipient for ${clientName || 'this client'}`}
        data-testid="invoice-new-contact"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-[440px] overflow-y-auto border border-neutral-300 bg-white p-4"
      >
        <div className="mb-2.5 flex items-center gap-2 border-b border-divider pb-2.5">
          <div>
            <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">New recipient</div>
            <h2 className="font-heading text-lg leading-tight font-semibold">{clientName || 'This client'}</h2>
          </div>
          <button type="button" onClick={onClose} className="ml-auto cursor-pointer text-[11.5px] text-neutral-500 hover:text-ink">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
