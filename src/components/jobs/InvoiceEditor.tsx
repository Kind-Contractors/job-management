import { useEffect, useState } from 'react';
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
import { refreshAfterXeroLink } from './UnlinkedRecipientsList';
import { invoiceActionMode, needsXeroContactChoice } from '../../lib/invoiceActionMode';

/** Query key of the read-only check of what this system's server-side switches allow (wording only; the server decides). */
export const XERO_INVOICE_CAPABILITIES_QUERY_KEY = ['xeroInvoiceCapabilities'] as const;

function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface InvoiceEditorProps {
  invoiceId: string;
  onClose: () => void;
  /** The job's client. */
  clientId: string;
  /** The client's name. */
  clientName?: string;
  /** The job's building: "Set up contacts & defaults" opens its Contacts & Defaults tab (in a new tab). */
  buildingId?: string;
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
export default function InvoiceEditor({ invoiceId, onClose, clientContacts, buildingId, buildingDefault = null }: InvoiceEditorProps) {
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
  // The contact the main button was pressed for while it was not linked to Xero: nothing was saved or sent, and the "not linked"
  // explanation is shown as an alert until the choice changes or the contact is linked.
  const [xeroLinkNeededFor, setXeroLinkNeededFor] = useState<string | null>(null);

  // '' = the building's default recipient (or nothing, when there is no usable default); anything else is an existing contact's
  // id, chosen for this invoice only. A recipient is never preselected by guessing (primary / only contact). Contacts are added
  // and edited in the Building File (Contacts & Defaults), not here.
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  // The unlinked contact whose Link button was clicked: opens the shared LinkXeroContactDialog for exactly that contact.
  const [linkingContact, setLinkingContact] = useState<JobContactSummary | null>(null);
  // The building's usable default is shown without a picker; "Change for this invoice" opens one to choose another contact.
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
  // The recipient is decided by the locked contact or the building's usable default unless the manager chooses another for this
  // invoice ("Change for this invoice"); with neither, a contact must be chosen. Labelled "Send invoice to" when it will be
  // emailed, otherwise as the Xero contact. Nothing is guessed: with no default and no choice, the button stays disabled.
  const showContactPicker = needsXeroContactChoice({ recipientLocked, usableDefault: !!usableDefaultContactId, chooseOther: chooseOtherContact });
  const recipientHeading = mode.showSendTo ? 'Send invoice to' : 'Xero contact for this invoice';
  // A choice made while the picker was showing never applies once it is hidden: the default (or locked contact) is used.
  const effectiveContactId = showContactPicker ? selectedContactId : '';
  const selectedContact = effectiveContactId ? (clientContacts.find((c) => c.id === effectiveContactId) ?? null) : null;
  const choosePhrase = mode.showSendTo ? 'who to send this invoice to' : 'the Xero contact this invoice is for';
  // A chosen contact must be in the list shown (it may have been removed, or the list failed to reload). Then nothing can be
  // submitted - never the building default or anyone else in its place - until the list is reloaded.
  const recipientUnavailable = !recipientLocked && recipientSelectionState(effectiveContactId, false, clientContacts) === 'missing';
  // A recipient is CHOSEN (the button can be pressed) when it is locked, a listed contact - linked to Xero or not - or the usable
  // building default. An unlinked choice is stopped on press (sendAttemptOutcome), before anything is saved or sent.
  const recipientChosen = recipientLocked || (!recipientUnavailable && (selectedContact ? true : !!usableDefaultContactId));

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Refuse an unlinkable recipient BEFORE anything is saved or created: no local contact is ever created from
      // here, so a failed send can never leave an orphan, unlinked contact behind.
      const contactId = resolveSendRecipientId({
        addingNewContact: false,
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
            {/* Who this invoice is for: the locked contact, this building's default, or a contact chosen for THIS invoice only.
                Choosing here never changes the building's saved default (Building File → Contacts & Defaults). */}
            <div data-testid="invoice-recipient" className="border border-neutral-300 bg-neutral-100 p-2 text-[12px] text-neutral-700">
              {recipientLocked ? (
                <>
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">{recipientHeading}</div>
                  <div className="mt-1">
                    <span className="font-semibold text-ink">
                      {lockedContact ? (lockedContact.xeroContactName ?? lockedContact.name) : 'the contact this invoice was created for'}
                    </span>{' '}
                    · locked: this invoice is already in Xero.
                  </div>
                </>
              ) : !showContactPicker ? (
                <>
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">{recipientHeading}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-ink">{defaultContact?.name}</span>
                    {defaultContact?.xeroContactName && <span className="text-teal-700">✓ Xero: {defaultContact.xeroContactName}</span>}
                    <span className="text-neutral-500">
                      · this building&apos;s default{mode.showSendTo ? '' : '. It will not be emailed.'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setChooseOtherContact(true)}
                      disabled={anyMutationPending}
                      className="ml-auto cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Change for this invoice
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                    {recipientHeading}
                    <select
                      value={selectedContactId}
                      onChange={(e) => {
                        setSelectedContactId(e.target.value);
                        setXeroLinkNeededFor(null);
                      }}
                      disabled={anyMutationPending}
                      className="border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-500"
                    >
                      <option value="" disabled={!usableDefaultContactId}>
                        {usableDefaultContactId ? `Building default: ${defaultContact?.xeroContactName ?? defaultContact?.name}` : 'Choose a recipient…'}
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
                    </select>
                  </label>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-neutral-600">
                    {selectedContact && canSendInvoiceTo(selectedContact) && (
                      <span className="text-teal-700">✓ Xero: {selectedContact.xeroContactName ?? 'linked'}</span>
                    )}
                    {usableDefaultContactId && (
                      <>
                        <span>For this invoice only: the building&apos;s default is not changed.</span>
                        <button
                          type="button"
                          onClick={() => {
                            setChooseOtherContact(false);
                            setSelectedContactId('');
                            setXeroLinkNeededFor(null);
                          }}
                          disabled={anyMutationPending}
                          className="cursor-pointer text-teal-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Use the building default
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

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
            {!recipientLocked && !usableDefaultContactId && (
              // No usable default: say why, and where to set one. Opened in a NEW tab so nothing typed on this invoice is lost.
              <div data-testid="no-invoice-default" className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
                {defaultProblem ?? 'This building has no default invoice recipient, so one is chosen for each invoice.'}{' '}
                {buildingId && (
                  <>
                    <a
                      href={`/buildings/${buildingId}?tab=contacts`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline"
                    >
                      Set up contacts &amp; defaults
                    </a>{' '}
                    (opens in a new tab; this invoice stays as it is), then{' '}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => void queryClient.invalidateQueries({ queryKey: ['jobRows'] })}
                  className="cursor-pointer underline"
                >
                  {buildingId ? 'reload recipients' : 'Reload recipients'}
                </button>
                .
              </div>
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
                  its existing Xero contact (&ldquo;Link to Xero contact&rdquo;, offered once you choose it) before the invoice can be sent.
                  The app never matches or creates a Xero contact by itself.
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
