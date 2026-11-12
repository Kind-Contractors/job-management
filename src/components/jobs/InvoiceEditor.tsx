import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BuildingDefaultRecipient,
  BuildingInvoiceRecipient,
  InvoiceLineItem,
  JobContactSummary,
} from "../../domain/types";
import {
  discardInvoiceDraft,
  getInvoice,
  getXeroInvoiceCapabilities,
  sendInvoice,
  updateInvoiceDraft,
  updateInvoiceLineItem,
} from "../../repository/invoicesRepository";
import {
  LOCKED_RECIPIENT_MESSAGE,
  resolveSendRequest,
  type OneOffXeroChoice,
} from "../../lib/invoiceRecipient";
import {
  defaultRecipientProblem,
  isUsableRecipient,
} from "../../lib/xeroLinkStatus";
import { getAutoInvoiceEmailSetting } from "../../repository/appSettingsRepository";
import { deliveryLine, sendResultMessage } from "../../lib/invoiceDelivery";
import { AUTO_INVOICE_EMAIL_QUERY_KEY } from "../settings/AutoInvoiceEmailSetting";
import XeroRecipientSearch from "./XeroRecipientSearch";
import { invoiceActionMode } from "../../lib/invoiceActionMode";

/** Query key of the read-only check of what this system's server-side switches allow (wording only; the server decides). */
export const XERO_INVOICE_CAPABILITIES_QUERY_KEY = [
  "xeroInvoiceCapabilities",
] as const;

function money(n: number): string {
  return `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  /** The building's invoice details (read-only here; edited with the building), shown with the recipient. */
  invoiceDetails?: string;
  /** All of the client's contacts (with or without an email) — the same list ContactPopover/JobsGrid use, passed down so this never needs its own fetch. */
  clientContacts: JobContactSummary[];
  /** The building's saved default invoice recipient, or null/omitted when none has been chosen. Never guessed from the contacts. */
  buildingDefault?: BuildingDefaultRecipient | null;
  /**
   * The building's OWN Xero invoice recipient (a Xero contact chosen for the building, no person attached), or null/omitted. When
   * present it is the recipient, and a person can't be chosen instead; a different Xero contact can be chosen for one invoice.
   */
  buildingRecipient?: BuildingInvoiceRecipient | null;
}

/**
 * Review-and-edit panel for a draft invoice, shown before Send — reuses the
 * same inline-panel style as ScheduleEditor/JobEditor rather than a new
 * modal/page. Covers both the "normal" (one visit) and "combined" (several
 * manager-selected visits) cases identically: both are just however many
 * line items the invoice was created with.
 */
export default function InvoiceEditor({
  invoiceId,
  onClose,
  clientContacts,
  buildingId,
  invoiceDetails = "",
  buildingDefault = null,
  buildingRecipient = null,
}: InvoiceEditorProps) {
  const queryClient = useQueryClient();
  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", invoiceId],
    queryFn: () => getInvoice(invoiceId),
  });
  // For the button's wording and the notes beside it only. Whether an invoice is emailed is decided by the server when it is
  // submitted: the app toggle AND the system's XERO_SENDING_ENABLED, re-checked there (the toggle never overrides the switch).
  const autoEmail = useQuery({
    queryKey: AUTO_INVOICE_EMAIL_QUERY_KEY,
    queryFn: getAutoInvoiceEmailSetting,
  });
  const capabilities = useQuery({
    queryKey: XERO_INVOICE_CAPABILITIES_QUERY_KEY,
    queryFn: getXeroInvoiceCapabilities,
    retry: false,
    staleTime: 60_000,
  });
  const mode = invoiceActionMode({
    autoEmailEnabled: autoEmail.isError
      ? null
      : (autoEmail.data?.enabled ?? null),
    systemSendingEnabled: capabilities.isError
      ? null
      : (capabilities.data?.sendingEnabled ?? null),
  });

  const [description, setDescription] = useState("");
  const [worksOrderNumber, setWorksOrderNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<InvoiceLineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  // A Xero contact chosen for THIS invoice only (on screen until Send; never saved on the building), and whether its search is open.
  const [oneOffXero, setOneOffXero] = useState<
    (OneOffXeroChoice & { email: string | null }) | null
  >(null);
  const [searchingXero, setSearchingXero] = useState(false);

  // Seed local editable state once the invoice loads (or reloads after a send).
  useEffect(() => {
    if (!invoice) return;
    setDescription(invoice.description ?? "");
    setWorksOrderNumber(invoice.worksOrderNumber ?? "");
    setDueDate(invoice.dueDate);
    setLines(invoice.lineItems);
  }, [invoice]);

  // Recipient selection is per-invoice — switching to a different invoice
  // (InvoiceEditor is reused across opens, not remounted) must not carry
  // over a previously selected/typed recipient.
  useEffect(() => {
    setOneOffXero(null);
    setSearchingXero(false);
  }, [invoiceId]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    queryClient.invalidateQueries({ queryKey: ["jobRows"] });
  };

  const editable = invoice?.status === "draft" || invoice?.status === "failed";

  // A 'failed' invoice may already have a real xero_invoice_id (Xero created
  // it, a later step like email failed) — discarding the local row in that
  // state would orphan the real Xero invoice and free the visit for a
  // second one. Discard is only ever safe when no Xero invoice exists yet.
  const canDiscard = editable && !invoice?.xeroInvoiceId;

  // No separate "Save Changes" step — Send invoice always persists the
  // entire current editor state itself, first, before doing anything else.
  // Luke edits freely and Send is the only action he ever needs to take.
  const persistCurrentDraft = async () => {
    await updateInvoiceDraft(invoiceId, {
      description: description || null,
      worksOrderNumber: worksOrderNumber || null,
      dueDate,
    });
    await Promise.all(
      lines.map((line) =>
        updateInvoiceLineItem(line.id, {
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unitAmount,
        }),
      ),
    );
  };

  const discardMutation = useMutation({
    mutationFn: () => discardInvoiceDraft(invoiceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobRows"] });
      onClose();
    },
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Failed to discard invoice.",
      ),
  });

  // Once Xero holds the invoice its recipient is locked: the server only ever retries it for the same Xero contact.
  const recipientLocked = !!invoice?.xeroInvoiceId;
  const lockedContact = recipientLocked
    ? (clientContacts.find(
        (c) => c.xeroContactId && c.xeroContactId === invoice?.xeroContactId,
      ) ?? null)
    : null;
  // The building's default is only offered when it still points at the contact it was chosen with.
  const defaultProblem = defaultRecipientProblem(
    buildingDefault,
    clientContacts,
  );
  const defaultContact =
    buildingDefault && !defaultProblem
      ? (clientContacts.find((c) => c.id === buildingDefault.contactId) ?? null)
      : null;
  const usableDefaultContactId =
    defaultContact && isUsableRecipient(defaultContact)
      ? defaultContact.id
      : null;
  // Who the invoice goes to (never guessed; with none of these the button stays disabled):
  //   - Xero already holds it: its locked recipient;
  //   - a Xero contact chosen for THIS invoice (never saved on the building);
  //   - the building's default recipient in Xero;
  //   - an older contact-based default that still works (the server still uses it until it is replaced in the Building File).
  // People are not chosen here: an invoice is addressed to a Xero contact, found by name. Labelled "Send invoice to" when it will
  // be emailed, otherwise as the Xero contact.
  const hasBuildingRecipient = !recipientLocked && !!buildingRecipient;
  const usingOneOffXero = !recipientLocked && !!oneOffXero;
  const usingContactDefault =
    !recipientLocked &&
    !hasBuildingRecipient &&
    !usingOneOffXero &&
    !!usableDefaultContactId;
  const hasAnyDefault = hasBuildingRecipient || !!usableDefaultContactId;
  const recipientHeading = mode.showSendTo
    ? "Send invoice to"
    : "Xero contact for this invoice";
  // The heading of the recipient card; when invoices are not emailed it says so on the same row.
  const recipientHeadingRow = (
    <div
      data-testid="recipient-heading"
      className="flex flex-wrap items-baseline gap-x-2"
    >
      <span className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
        {recipientHeading}
      </span>
      {!mode.showSendTo && (
        <span className="text-[11px] text-neutral-600">
          It will not be emailed.
        </span>
      )}
    </div>
  );
  const recipientChosen =
    recipientLocked ||
    usingOneOffXero ||
    hasBuildingRecipient ||
    usingContactDefault;

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Decided BEFORE anything is saved: with no recipient this refuses (the button is disabled then anyway).
      const recipient = resolveSendRequest({
        addingNewContact: false,
        selectedContactId: "",
        usableDefaultContactId,
        recipientLocked,
        hasBuildingRecipient,
        oneOffXero: usingOneOffXero ? oneOffXero : null,
      });

      // Persist current editor state — xero-create-invoice reads the
      // invoice straight from the database, so whatever's on screen must
      // already be saved before it runs, every time.
      await persistCurrentDraft();

      return sendInvoice(invoiceId, recipient);
    },
    onSuccess: (result) => {
      invalidate();
      setSendResult(sendResultMessage(result));
    },
    // A failed send may have changed the invoice (it is marked failed, with the reason stored), so reload it too.
    onError: (err) => {
      invalidate();
      setSendResult({
        ok: false,
        message: err instanceof Error ? err.message : "Failed to send.",
      });
    },
  });

  // Send/Discard are mutually exclusive — while one is running, the other
  // must not be startable (a Discard landing mid-Send could leave a real
  // Xero invoice with no local record at all).
  const anyMutationPending =
    sendMutation.isPending || discardMutation.isPending;

  if (isLoading || !invoice) {
    return (
      <div className="m-3.5 border border-neutral-300 p-3 text-[12.5px] text-neutral-500">
        Loading invoice…
      </div>
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
        <button
          onClick={onClose}
          className="ml-auto cursor-pointer text-[11.5px] text-neutral-500 hover:text-ink"
        >
          Close
        </button>
      </div>

      {(invoice.status === "sent" ||
        invoice.status === "in_xero_not_emailed") && (
        <div
          data-testid="invoice-delivery"
          className="mt-2 border border-teal-700/40 bg-teal-100 p-2 text-[12.5px] text-teal-700"
        >
          {deliveryLine(invoice, clientContacts)}
        </div>
      )}
      {invoice.status === "failed" && invoice.xeroInvoiceId && (
        <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">
          <div className="font-semibold">
            Xero invoice {invoice.xeroInvoiceNumber} was created, but sending it
            failed.
          </div>
          <div className="mt-1 text-neutral-600">
            Clicking "{mode.label}" again will update this same Xero invoice
            with any changes below
            {mode.kind === "send" ? " and retry emailing it" : ""} — it will not
            create another one.
          </div>
          {invoice.lastError && <div className="mt-1">{invoice.lastError}</div>}
        </div>
      )}
      {invoice.status === "failed" &&
        !invoice.xeroInvoiceId &&
        invoice.lastError && (
          <div className="mt-2 border border-missed bg-missed/10 p-2 text-[12.5px] text-missed-fg">
            {invoice.lastError}
          </div>
        )}
      {invoice.status === "sending" && (
        <div className="mt-2 border border-neutral-300 bg-neutral-100 p-2 text-[12.5px] text-neutral-600">
          In progress — this invoice is being created in Xero (and emailed, if
          this system and the app allow it)…
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
        <div className="text-[10px] text-neutral-400">
          Invoice reference is sent to Xero as this invoice's Reference field.
        </div>

        <div className="text-[11px] text-neutral-600">
          Line items ({lines.length})
        </div>
        {lines.map((line, i) => (
          <div
            key={line.id}
            className="flex flex-col gap-1 border border-neutral-300 bg-neutral-100 p-2"
          >
            <input
              value={line.description}
              onChange={(e) =>
                setLines((prev) =>
                  prev.map((l, idx) =>
                    idx === i ? { ...l, description: e.target.value } : l,
                  ),
                )
              }
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
                    setLines((prev) =>
                      prev.map((l, idx) =>
                        idx === i
                          ? { ...l, quantity: Number(e.target.value) }
                          : l,
                      ),
                    )
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
                    setLines((prev) =>
                      prev.map((l, idx) =>
                        idx === i
                          ? { ...l, unitAmount: Number(e.target.value) }
                          : l,
                      ),
                    )
                  }
                  disabled={!editable}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-200 disabled:text-neutral-500"
                />
              </label>
              <div className="flex flex-1 flex-col gap-0.5 text-[10.5px] text-neutral-600">
                Line total
                <div className="px-2 py-1 text-[12.5px] tabular-nums text-ink">
                  {money(line.quantity * line.unitAmount)}
                </div>
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
            VAT/account code are resolved against Xero when sent — this total is
            an estimate, not what Xero will charge.
          </div>
        </div>

        {editable && (
          <div className="flex flex-col gap-1.5 border-t border-divider pt-2">
            {/* Who this invoice is for: the locked contact, this building's default, or a contact chosen for THIS invoice only.
                Choosing here never changes the building's saved default (Building File → Contacts & Defaults). */}
            <div
              data-testid="invoice-recipient"
              className="border border-neutral-300 bg-neutral-100 p-2 text-[12px] text-neutral-700"
            >
              {recipientLocked ? (
                <>
                  {recipientHeadingRow}
                  <div className="mt-1">
                    <span className="font-semibold text-ink">
                      {lockedContact
                        ? (lockedContact.xeroContactName ?? lockedContact.name)
                        : (invoice?.xeroRecipientName ??
                          "the contact this invoice was created for")}
                    </span>{" "}
                    · locked: this invoice is already in Xero.
                  </div>
                </>
              ) : searchingXero ? (
                <>
                  {recipientHeadingRow}
                  <XeroRecipientSearch
                    purpose="For this invoice only: the building's saved recipient is not changed."
                    disabled={anyMutationPending}
                    onCancel={() => setSearchingXero(false)}
                    onChoose={(c) => {
                      setOneOffXero({
                        xeroContactId: c.contactId,
                        name: c.name,
                        email: c.email,
                      });
                      setSearchingXero(false);
                    }}
                  />
                </>
              ) : usingOneOffXero && oneOffXero ? (
                <>
                  {recipientHeadingRow}
                  <div
                    data-testid="one-off-xero-recipient"
                    className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <span className="font-semibold text-ink">
                      {oneOffXero.name}
                    </span>
                    {oneOffXero.email && (
                      <span className="text-neutral-600">
                        {oneOffXero.email}
                      </span>
                    )}
                    <span className="text-neutral-500">
                      · Xero contact for this invoice only: the
                      building&apos;s saved recipient is not changed
                    </span>
                    <button
                      type="button"
                      onClick={() => setOneOffXero(null)}
                      disabled={anyMutationPending}
                      className="ml-auto cursor-pointer text-[11px] text-teal-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {hasAnyDefault
                        ? "Use the building's default recipient"
                        : "Undo"}
                    </button>
                  </div>
                </>
              ) : hasBuildingRecipient && buildingRecipient ? (
                <>
                  {recipientHeadingRow}
                  <div
                    data-testid="building-xero-recipient"
                    className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <span className="font-semibold text-ink">
                      {buildingRecipient.name}
                    </span>
                    {buildingRecipient.email && (
                      <span className="text-neutral-600">
                        {buildingRecipient.email}
                      </span>
                    )}
                    <span className="text-neutral-500">
                      · this building&apos;s default recipient
                    </span>
                    <button
                      type="button"
                      onClick={() => setSearchingXero(true)}
                      disabled={anyMutationPending}
                      className="ml-auto cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Use a different Xero contact for this invoice
                    </button>
                  </div>
                </>
              ) : usingContactDefault && defaultContact ? (
                <>
                  {recipientHeadingRow}
                  <div
                    data-testid="contact-default-recipient"
                    className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <span className="font-semibold text-ink">
                      {defaultContact.xeroContactName ?? defaultContact.name}
                    </span>
                    <span className="text-neutral-500">
                      · this building&apos;s default (contact-based, the older
                      way)
                    </span>
                    <button
                      type="button"
                      onClick={() => setSearchingXero(true)}
                      disabled={anyMutationPending}
                      className="ml-auto cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Use a different Xero contact for this invoice
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {recipientHeadingRow}
                  <div
                    data-testid="no-recipient-yet"
                    className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    <span className="text-neutral-600">
                      No recipient chosen yet.
                    </span>
                    <button
                      type="button"
                      data-testid="choose-xero-contact"
                      onClick={() => setSearchingXero(true)}
                      disabled={anyMutationPending}
                      className="ml-auto cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Choose a Xero contact for this invoice
                    </button>
                  </div>
                </>
              )}
              {invoiceDetails.trim() && (
                // The building's invoice details, as entered on the building (read-only here).
                <div
                  data-testid="invoice-details"
                  className="mt-1.5 flex gap-2 border-t border-divider pt-1.5 text-[11.5px]"
                >
                  <span className="flex-none text-neutral-600">
                    Invoice details
                  </span>
                  <span className="whitespace-pre-line text-ink">
                    {invoiceDetails}
                  </span>
                </div>
              )}
            </div>

            {recipientLocked && (
              <div className="border border-neutral-300 bg-neutral-100 p-2 text-[11.5px] text-neutral-700">
                {LOCKED_RECIPIENT_MESSAGE}
              </div>
            )}
            {!recipientLocked &&
              !usableDefaultContactId &&
              !hasBuildingRecipient &&
              !usingOneOffXero && (
              // No usable default: say why, and where to set one. Opened in a NEW tab so nothing typed on this invoice is lost.
              <div
                data-testid="no-invoice-default"
                className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg"
              >
                {defaultProblem ??
                  "This building has no default recipient in Xero yet, so a Xero contact is chosen for each invoice."}{" "}
                {buildingId && (
                  <>
                    <a
                      href={`/buildings/${buildingId}?tab=contacts`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline"
                    >
                      Set the building&apos;s default recipient
                    </a>{" "}
                    (opens in a new tab; this invoice stays as it is), then{" "}
                  </>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void queryClient.invalidateQueries({
                      queryKey: ["jobRows"],
                    })
                  }
                  className="cursor-pointer underline"
                >
                  {buildingId ? "reload recipients" : "Reload recipients"}
                </button>
                .
              </div>
            )}
            <div
              data-testid="invoice-email-notice"
              className={
                mode.notice.warn
                  ? "border border-due bg-due/10 p-2 text-[11.5px] text-due-fg"
                  : mode.kind === "send"
                    ? "text-[10px] text-due-fg"
                    : "text-[10px] text-neutral-400"
              }
            >
              {mode.notice.text}
            </div>
          </div>
        )}

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}
        {sendResult && (
          <div
            className={`text-[11.5px] ${sendResult.ok ? "text-teal-700" : "text-missed-fg"}`}
          >
            {sendResult.message}
          </div>
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
                disabled={
                  anyMutationPending || lines.length === 0 || !recipientChosen
                }
                className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendMutation.isPending ? mode.pendingLabel : mode.label}
              </button>
              <button
                onClick={() => discardMutation.mutate()}
                disabled={anyMutationPending || !canDiscard}
                title={
                  canDiscard
                    ? undefined
                    : "A Xero invoice already exists for this record — discard is disabled to avoid orphaning it. Use Send to retry, or fix this in Xero directly."
                }
                className="cursor-pointer text-[11px] text-missed-fg hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>

    </div>
  );
}

function invoiceStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "in_xero_not_emailed":
      return "In Xero · not emailed";
    default:
      return status;
  }
}
