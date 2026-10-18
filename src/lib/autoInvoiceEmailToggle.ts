// The confirm-before-change flow of the "Automatic Invoice Emails" toggle, kept free of React so it can be tested directly.
//
// Clicking the switch only REQUESTS a change and opens a confirmation. Nothing is saved until the manager confirms;
// Cancel discards the request. While a save is in flight every further request, cancel or confirm is ignored, so a
// change cannot be submitted twice. The switch itself always shows the value the server last confirmed.

export interface AutoEmailToggleState {
  /** The value the manager asked to change to, awaiting confirmation (null = no dialog open). */
  pending: boolean | null;
  /** True while the confirmed change is being saved. */
  saving: boolean;
  message: { ok: boolean; text: string } | null;
}

export type AutoEmailToggleAction =
  | { type: 'request'; next: boolean }
  | { type: 'cancel' }
  | { type: 'saveStart' }
  | { type: 'saveSuccess'; enabled: boolean }
  | { type: 'saveError'; error: string };

export const INITIAL_TOGGLE_STATE: AutoEmailToggleState = { pending: null, saving: false, message: null };

export function autoEmailToggleReducer(state: AutoEmailToggleState, action: AutoEmailToggleAction): AutoEmailToggleState {
  switch (action.type) {
    case 'request':
      return state.saving ? state : { pending: action.next, saving: false, message: null };
    case 'cancel':
      return state.saving ? state : { ...state, pending: null };
    case 'saveStart':
      return state.saving || state.pending === null ? state : { ...state, saving: true, message: null };
    case 'saveSuccess':
      return {
        pending: null,
        saving: false,
        message: {
          ok: true,
          text: action.enabled
            ? 'Automatic invoice emails are on. New invoices will be emailed when they are created in Xero.'
            : 'Automatic invoice emails are off. New invoices will be created in Xero but not emailed.',
        },
      };
    case 'saveError':
      return { pending: null, saving: false, message: { ok: false, text: action.error } };
    default:
      return state;
  }
}

export interface ConfirmationCopy {
  title: string;
  message: string;
  confirmLabel: string;
}

export const TURN_OFF_COPY: ConfirmationCopy = {
  title: 'Turn off automatic invoice emails?',
  message:
    'New invoices will continue to be created in Xero, but the app will not email them automatically. You can review and send them manually from Xero.',
  confirmLabel: 'Turn off',
};

export const TURN_ON_COPY: ConfirmationCopy = {
  title: 'Enable automatic invoice emails?',
  message:
    'The app may automatically email newly created invoices to clients. Please confirm that the invoice recipients and details are correct before enabling this feature.',
  confirmLabel: 'Enable automatic sending',
};

export const confirmationFor = (next: boolean): ConfirmationCopy => (next ? TURN_ON_COPY : TURN_OFF_COPY);
