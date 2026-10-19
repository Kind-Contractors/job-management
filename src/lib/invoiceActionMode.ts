// What the invoice editor's main button says and whether it shows "Send invoice to", from the two settings that decide whether
// an invoice is emailed. Kept free of React so every combination can be tested directly.
//
//   - the app's "Automatic Invoice Emails" toggle (app_settings), and
//   - the server's XERO_SENDING_ENABLED switch (read through xero-create-invoice's read-only `capabilities` request).
//
// An invoice is emailed only when BOTH allow it; the toggle never overrides the server switch. This module only chooses
// wording: the server re-checks both at the moment it creates the invoice, and decides. When either setting is unknown
// (still loading, or it could not be read), nothing is promised either way.

export type InvoiceActionKind = 'send' | 'create' | 'submit';

export interface InvoiceActionMode {
  kind: InvoiceActionKind;
  /** The main button's label. */
  label: string;
  /** The label while the request runs. */
  pendingLabel: string;
  /**
   * Show the "Send invoice to" selector? Hidden only when the app toggle is definitely OFF: the invoice is then not emailed,
   * so there is no one to send it to (the Xero contact it is created for is shown instead).
   */
  showSendTo: boolean;
  /** A notice about emailing beside the action; `warn` when emailing is on in the app but this system will not email. */
  notice: { text: string; warn: boolean };
}

export interface EmailSettings {
  /** The app toggle: true / false, or null while unknown (loading, or it could not be read). */
  autoEmailEnabled: boolean | null;
  /** XERO_SENDING_ENABLED on this system: true / false, or null while unknown. */
  systemSendingEnabled: boolean | null;
}

export function invoiceActionMode({ autoEmailEnabled, systemSendingEnabled }: EmailSettings): InvoiceActionMode {
  if (autoEmailEnabled === false) {
    return {
      kind: 'create',
      label: 'Create in Xero',
      pendingLabel: 'Creating…',
      showSendTo: false,
      notice: { text: 'Automatic invoice emails are off: this invoice will be created in Xero but not emailed. Send it from Xero if needed.', warn: false },
    };
  }
  if (autoEmailEnabled === true && systemSendingEnabled === true) {
    return {
      kind: 'send',
      label: 'Send invoice',
      pendingLabel: 'Sending…',
      showSendTo: true,
      notice: { text: 'Automatic invoice emails are on: once this invoice is created in Xero, it is emailed to the recipient.', warn: false },
    };
  }
  if (autoEmailEnabled === true && systemSendingEnabled === false) {
    return {
      kind: 'create',
      label: 'Create in Xero',
      pendingLabel: 'Creating…',
      showSendTo: true,
      notice: {
        text:
          'This system does not email invoices (invoice email sending is not enabled here, an administrator setting), so this invoice will be created in Xero but not emailed, even though Automatic Invoice Emails is on. The recipient above is who it will be addressed to in Xero.',
        warn: true,
      },
    };
  }
  // Something is unknown: promise neither an email nor its absence. If the app toggle is unknown the server would not email.
  return {
    kind: systemSendingEnabled === false ? 'create' : 'submit',
    label: systemSendingEnabled === false ? 'Create in Xero' : 'Submit to Xero',
    pendingLabel: systemSendingEnabled === false ? 'Creating…' : 'Submitting…',
    showSendTo: true,
    notice: {
      text:
        autoEmailEnabled === null
          ? 'The automatic invoice email setting could not be read: the invoice will be created in Xero, and only emailed if the server confirms both settings allow it.'
          : 'Could not check whether this system emails invoices: the invoice will be created in Xero, and emailed only if the server allows it.',
      warn: true,
    },
  };
}

/**
 * Should the editor show a contact picker when "Send invoice to" is hidden (toggle off)? Xero needs a contact on every invoice,
 * so a picker is still needed - labelled as the Xero contact, not a recipient - unless the contact is already decided: the
 * invoice's locked contact (Xero holds it), or the building's usable default (unless the manager asked to choose another).
 */
export function needsXeroContactChoice(opts: { recipientLocked: boolean; usableDefault: boolean; chooseOther: boolean }): boolean {
  if (opts.recipientLocked) return false;
  return !opts.usableDefault || opts.chooseOther;
}
