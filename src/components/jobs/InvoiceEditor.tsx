import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuildingDefaultRecipient, InvoiceLineItem, JobContactSummary } from '../../domain/types';
import {
  discardInvoiceDraft,
  getInvoice,
  sendInvoice,
  updateInvoiceDraft,
  updateInvoiceLineItem,
} from '../../repository/invoicesRepository';
import { LOCKED_RECIPIENT_MESSAGE, resolveSendRecipientId, UNLINKED_NEW_CONTACT_MESSAGE } from '../../lib/invoiceRecipient';
import { canLinkAutomatically, canSendInvoiceTo, defaultRecipientProblem, isUsableRecipient, linkStatusLabel } from '../../lib/xeroLinkStatus';
import LinkXeroContactDialog from './LinkXeroContactDialog';
import { getAutoInvoiceEmailSetting } from '../../repository/appSettingsRepository';
import { deliveryLine, sendResultMessage } from '../../lib/invoiceDelivery';
import { AUTO_INVOICE_EMAIL_QUERY_KEY } from '../settings/AutoInvoiceEmailSetting';
import UnlinkedRecipientsList, { refreshAfterXeroLink } from './UnlinkedRecipientsList';

function money(n: number): string {
  return `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const ADD_NEW_CONTACT_VALUE = '__add_new__';

interface InvoiceEditorProps {
  invoiceId: string;
  onClose: () => void;
  /** Not used while a new contact cannot be created from here (it would have no Xero link); kept so callers and the later linking UI need no change. */
  clientId: string;
  /** The client's contacts with a stored email — same list ContactPopover/JobsGrid already use, passed down so this never needs its own fetch. */
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
export default function InvoiceEditor({ invoiceId, onClose, clientContacts, buildingDefault = null }: InvoiceEditorProps) {
  const queryClient = useQueryClient();
  const { data: invoice, isLoading } = useQuery({ queryKey: ['invoice', invoiceId], queryFn: () => getInvoice(invoiceId) });
  // For the note beside Send only. Whether an invoice is emailed is decided by the server at the moment of sending.
  const autoEmail = useQuery({ queryKey: AUTO_INVOICE_EMAIL_QUERY_KEY, queryFn: getAutoInvoiceEmailSetting });

  const [description, setDescription] = useState('');
  const [worksOrderNumber, setWorksOrderNumber] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<InvoiceLineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  // '' = the building's default recipient (or nothing, when there is no usable default); ADD_NEW_CONTACT_VALUE = the
  // "+ Add another email address" option, which cannot be sent to (it has no Xero link) and shows a message instead;
  // anything else is an existing contact's id. A recipient is never preselected by guessing (primary / only contact).
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  // The unlinked contact whose Link button was clicked: opens the shared LinkXeroContactDialog for exactly that contact.
  const [linkingContact, setLinkingContact] = useState<JobContactSummary | null>(null);

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

  const addingNewContact = selectedContactId === ADD_NEW_CONTACT_VALUE;
  // Once Xero holds the invoice its recipient is locked: the server only ever retries it for the same Xero contact.
  const recipientLocked = !!invoice?.xeroInvoiceId;
  const lockedContact = recipientLocked ? (clientContacts.find((c) => c.xeroContactId && c.xeroContactId === invoice?.xeroContactId) ?? null) : null;
  // The building's default is only offered when it still points at the contact it was chosen with.
  const defaultProblem = defaultRecipientProblem(buildingDefault, clientContacts);
  const defaultContact = buildingDefault && !defaultProblem ? (clientContacts.find((c) => c.id === buildingDefault.contactId) ?? null) : null;
  const usableDefaultContactId = defaultContact && isUsableRecipient(defaultContact) ? defaultContact.id : null;
  const selectedContact = selectedContactId && !addingNewContact ? (clientContacts.find((c) => c.id === selectedContactId) ?? null) : null;
  // "+ Add another email address" can never be a valid recipient yet: a brand-new contact has no Xero link, and the
  // server refuses to send to an unlinked recipient (it never creates or guesses a Xero contact).
  const recipientValid = recipientLocked || (!addingNewContact && (selectedContact ? canSendInvoiceTo(selectedContact) : !!usableDefaultContactId));

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Refuse an unlinkable recipient BEFORE anything is saved or created: no local contact is ever created from
      // here, so a failed send can never leave an orphan, unlinked contact behind.
      const contactId = resolveSendRecipientId({
        addingNewContact,
        selectedContactId,
        usableDefaultContactId,
        selectedIsLinked: selectedContact ? canSendInvoiceTo(selectedContact) : undefined,
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
            Clicking "Send invoice" again will update this same Xero invoice with any changes below and retry emailing it — it will not create
            another one.
          </div>
          {invoice.lastError && <div className="mt-1">{invoice.lastError}</div>}
        </div>
      )}
      {invoice.status === 'failed' && !invoice.xeroInvoiceId && invoice.lastError && (
        <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">{invoice.lastError}</div>
      )}
      {invoice.status === 'sending' && (
        <div className="mt-2 border border-neutral-300 bg-neutral-100 p-2 text-[12.5px] text-neutral-600">
          Sending — creating and emailing this invoice in Xero…
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
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Send invoice to
              <select
                value={recipientLocked ? '' : selectedContactId}
                onChange={(e) => setSelectedContactId(e.target.value)}
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
                {clientContacts.map((c) => (
                  <option key={c.id} value={c.id} disabled={!canSendInvoiceTo(c)}>
                    {c.name}
                    {c.email ? ` — ${c.email}` : ''}
                    {isUsableRecipient(c)
                      ? c.xeroContactName
                        ? ` · Xero: ${c.xeroContactName}`
                        : ' · linked to Xero'
                      : canLinkAutomatically(c)
                        ? ' · not linked: matched or created in Xero on send'
                        : ' · not linked to Xero'}
                  </option>
                ))}
                <option value={ADD_NEW_CONTACT_VALUE}>+ Add another email address</option>
              </select>
            </label>

            {!recipientLocked && <UnlinkedRecipientsList contacts={clientContacts} onLink={setLinkingContact} disabled={anyMutationPending} />}

            {recipientLocked && <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">{LOCKED_RECIPIENT_MESSAGE}</div>}
            {!recipientLocked && !selectedContactId && !usableDefaultContactId && defaultProblem && (
              <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">{defaultProblem}</div>
            )}
            {!recipientLocked && !selectedContactId && !usableDefaultContactId && !defaultProblem && (
              clientContacts.some(canSendInvoiceTo) ? (
                <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">
                  Choose who to send this invoice to. A contact that is not in Xero yet can be chosen: it is matched to its Xero contact
                  by email, or created in Xero, when you submit the invoice.
                </div>
              ) : (
                <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
                  None of this client's contacts can receive an invoice yet: add an email address to a contact, or link one to its Xero
                  contact.
                </div>
              )
            )}
            {!recipientLocked && selectedContact && !isUsableRecipient(selectedContact) && canLinkAutomatically(selectedContact) && (
              <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">
                Not linked to Xero yet. On send, the app uses the one Xero contact with this email address, or creates one if there is
                none. If several match, it stops and asks you to link the right one.
              </div>
            )}
            {!recipientLocked && selectedContact && !canSendInvoiceTo(selectedContact) && (
              <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">{linkStatusLabel(selectedContact)}.</div>
            )}
            {addingNewContact ? (
              <div className="border border-missed bg-missed/10 p-2 text-[11.5px] text-missed-fg">{UNLINKED_NEW_CONTACT_MESSAGE}</div>
            ) : (
              <div className="text-[10px] text-neutral-400">
                {autoEmail.data?.enabled === true
                  ? 'Automatic invoice emails are on: once this invoice is created in Xero, it is emailed to the contact, provided invoice emailing is enabled on this system.'
                  : autoEmail.data?.enabled === false
                    ? 'Automatic invoice emails are off: this invoice will be created in Xero but not emailed. Send it from Xero.'
                    : 'The automatic invoice email setting could not be read: the invoice will not be emailed.'}
              </div>
            )}
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
                  sendMutation.mutate();
                }}
                disabled={anyMutationPending || lines.length === 0 || !recipientValid}
                className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendMutation.isPending ? 'Sending…' : 'Send invoice'}
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
