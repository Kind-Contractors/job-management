import { useReducer } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAutoInvoiceEmailSetting,
  setAutoInvoiceEmailSetting,
  type AutoInvoiceEmailSetting as Setting,
} from '../../repository/appSettingsRepository';
import {
  autoEmailToggleReducer,
  confirmationFor,
  INITIAL_TOGGLE_STATE,
  type AutoEmailToggleState,
} from '../../lib/autoInvoiceEmailToggle';

export const AUTO_INVOICE_EMAIL_QUERY_KEY = ['appSettings', 'autoInvoiceEmails'] as const;

export interface AutoInvoiceEmailSettingViewProps {
  /** The value the server last confirmed; undefined while loading or when it could not be loaded. */
  enabled: boolean | undefined;
  loading: boolean;
  loadError: string | null;
  state: AutoEmailToggleState;
  onRequest: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry?: () => void;
}

/** Presentational: the switch, its status, the explanation, and the confirmation dialog. All decisions are the caller's. */
export function AutoInvoiceEmailSettingView({ enabled, loading, loadError, state, onRequest, onCancel, onConfirm, onRetry }: AutoInvoiceEmailSettingViewProps) {
  const known = enabled !== undefined && !loading && !loadError;
  const copy = state.pending === null ? null : confirmationFor(state.pending);

  return (
    <div className="border border-neutral-300 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Automatic Invoice Emails</div>
          <p className="mt-0.5 text-[11.5px] text-neutral-600">
            Controls whether the app emails an invoice to the client after creating it in Xero. It does not stop invoices being created.
            This is the app setting. An invoice is emailed only when it is on AND invoice email sending is enabled for this system (an
            administrator setting on the server); otherwise invoices are created in Xero without being emailed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            data-testid="auto-email-status"
            className={`text-[12px] font-semibold ${known ? (enabled ? 'text-teal-700' : 'text-neutral-600') : 'text-neutral-400'}`}
          >
            {loading ? 'Loading…' : loadError ? 'Unavailable' : enabled ? 'Enabled' : 'Disabled'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={known ? enabled : false}
            aria-label="Automatic invoice emails"
            disabled={!known || state.saving || state.pending !== null}
            onClick={() => known && onRequest(!enabled)}
            className={`relative h-5 w-9 shrink-0 cursor-pointer border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              known && enabled ? 'border-teal bg-teal' : 'border-neutral-400 bg-neutral-200'
            }`}
          >
            <span className={`absolute top-0.5 h-3.5 w-3.5 bg-white shadow transition-all ${known && enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mt-2 text-[11.5px] text-missed-fg">
          {loadError} Invoices are not emailed while the setting cannot be read.
          {onRetry && (
            <button type="button" onClick={onRetry} className="ml-2 cursor-pointer text-teal-700 underline">
              Try again
            </button>
          )}
        </div>
      )}
      {state.saving && <div className="mt-2 text-[11.5px] text-neutral-600">Saving…</div>}
      {state.message && (
        <div role="status" className={`mt-2 text-[11.5px] ${state.message.ok ? 'text-teal-700' : 'text-missed-fg'}`}>
          {state.message.text}
        </div>
      )}

      {copy && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30 px-4" onClick={state.saving ? undefined : onCancel}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-email-confirm-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[420px] border border-neutral-300 bg-white p-4"
          >
            <h2 id="auto-email-confirm-title" className="font-heading text-lg leading-tight font-semibold">
              {copy.title}
            </h2>
            <p className="mt-2 text-[12.5px] text-neutral-700">{copy.message}</p>
            <div className="mt-3 flex flex-wrap justify-end gap-1.5">
              <button
                type="button"
                onClick={onCancel}
                disabled={state.saving}
                className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={state.saving}
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {state.saving ? 'Saving…' : copy.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The "Automatic Invoice Emails" setting. The switch never changes the setting by itself: it asks for confirmation first,
 * saves only on confirm, and shows the new value only once the database has confirmed it. Who may change it is decided on
 * the server (RLS: active managers only); whether an invoice is actually emailed is decided again by xero-create-invoice,
 * which reads the setting immediately before every email.
 */
export default function AutoInvoiceEmailSetting() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: AUTO_INVOICE_EMAIL_QUERY_KEY, queryFn: getAutoInvoiceEmailSetting });
  const [state, dispatch] = useReducer(autoEmailToggleReducer, INITIAL_TOGGLE_STATE);

  const save = useMutation({
    mutationFn: (enabled: boolean) => setAutoInvoiceEmailSetting(enabled),
    onSuccess: (saved: Setting) => {
      queryClient.setQueryData(AUTO_INVOICE_EMAIL_QUERY_KEY, saved);
      dispatch({ type: 'saveSuccess', enabled: saved.enabled });
    },
    onError: (err) => {
      dispatch({ type: 'saveError', error: err instanceof Error ? err.message : 'The setting could not be saved.' });
      queryClient.invalidateQueries({ queryKey: AUTO_INVOICE_EMAIL_QUERY_KEY });
    },
  });

  const confirm = () => {
    // Guards against a double click: one save per confirmation, never while one is in flight.
    if (state.saving || state.pending === null || save.isPending) return;
    const next = state.pending;
    dispatch({ type: 'saveStart' });
    save.mutate(next);
  };

  return (
    <AutoInvoiceEmailSettingView
      enabled={query.data?.enabled}
      loading={query.isLoading}
      loadError={query.isError ? (query.error instanceof Error ? query.error.message : 'The setting could not be loaded.') : null}
      state={state}
      onRequest={(next) => dispatch({ type: 'request', next })}
      onCancel={() => dispatch({ type: 'cancel' })}
      onConfirm={confirm}
      onRetry={() => query.refetch()}
    />
  );
}
