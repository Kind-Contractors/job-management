import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuildingRow, Contact } from '../../domain/types';
import {
  canSaveChosenRecipient,
  currentBuildingRecipient,
  expectedRecipientOf,
  RECIPIENT_CHECK_TEXT,
  recipientSearchStartTerm,
  replacesAnotherRecipient,
} from '../../lib/buildingInvoiceRecipient';
import {
  clearBuildingRecipient,
  setBuildingRecipient,
  verifyBuildingDefault,
  type XeroRecipientCandidate,
} from '../../repository/xeroLinksRepository';
import XeroRecipientSearch from '../jobs/XeroRecipientSearch';

/** Query key of the live check of a building's own Xero recipient (read-only; never kept in the browser's saved cache). */
export const buildingRecipientCheckKey = (buildingId: string, xeroContactId: string) => ['buildingRecipientCheck', buildingId, xeroContactId] as const;

/**
 * The building's OWN invoice recipient: the Xero contact named on its invoices (for example "16-17 Marylebone Adrian Levy"), chosen
 * for THIS building only - not a person. Found by name with the shared Xero search (started from the building's invoice details),
 * shown with its full name, email and billing address, and saved only after the manager confirms it (and, when it replaces another
 * recipient, ticks that they mean to). Every save or clear carries the recipient the manager saw, so a change made meanwhile is
 * refused instead of overwritten. Nothing is chosen automatically, and no other building, person, Xero link or invoice is changed.
 */
interface BuildingInvoiceRecipientPanelProps {
  building: BuildingRow;
  contacts: Contact[];
  /** Initial states, so each step of the workflow can be rendered on its own (tests); the screen always starts closed. */
  initialSearching?: boolean;
  initialChosen?: XeroRecipientCandidate | null;
  initialReplaceConfirmed?: boolean;
  initialConfirmingClear?: boolean;
  initialError?: string | null;
}

export default function BuildingInvoiceRecipientPanel({
  building,
  contacts,
  initialSearching = false,
  initialChosen = null,
  initialReplaceConfirmed = false,
  initialConfirmingClear = false,
  initialError = null,
}: BuildingInvoiceRecipientPanelProps) {
  const queryClient = useQueryClient();
  const current = currentBuildingRecipient(building, contacts);
  const [searching, setSearching] = useState(initialSearching);
  const [chosen, setChosen] = useState<XeroRecipientCandidate | null>(initialChosen);
  const [replaceConfirmed, setReplaceConfirmed] = useState(initialReplaceConfirmed);
  const [confirmingClear, setConfirmingClear] = useState(initialConfirmingClear);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  // The building's recipient, read live from Xero: whether it can still be invoiced (and, for its own recipient, its billing address).
  // The same read-only check for an older contact-based default, so a broken one is visible before an invoice is refused.
  const check = useQuery({
    queryKey: buildingRecipientCheckKey(building.id, current.kind === 'none' ? '' : current.xeroContactId),
    queryFn: () => verifyBuildingDefault(building.id),
    enabled: current.kind !== 'none',
    retry: false,
    staleTime: 60_000,
    meta: { persist: false },
  });

  const refresh = () => {
    for (const queryKey of [['buildingRows'], ['jobRows'], ['buildingRecipientCheck', building.id]]) void queryClient.invalidateQueries({ queryKey });
  };
  const reset = () => {
    setSearching(false);
    setChosen(null);
    setReplaceConfirmed(false);
    setConfirmingClear(false);
  };

  const saveMutation = useMutation({
    mutationFn: (c: XeroRecipientCandidate) =>
      setBuildingRecipient({ buildingId: building.id, xeroContactId: c.contactId, expectedName: c.name, ...expectedRecipientOf(current) }),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (result) => {
      reset();
      refresh();
      setNotice(
        result.unchanged
          ? `${result.recipient.name} is still this building's invoice recipient; its details were refreshed.`
          : `Invoices for this building now go to ${result.recipient.name}. Other buildings and invoices already created are not changed.`,
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The invoice recipient could not be saved.'),
  });
  const clearMutation = useMutation({
    mutationFn: () => clearBuildingRecipient({ buildingId: building.id, ...expectedRecipientOf(current) }),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: () => {
      reset();
      refresh();
      setNotice('The invoice recipient was cleared for this building only. Invoices for it need a recipient chosen each time.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The invoice recipient could not be cleared.'),
  });
  const busy = saveMutation.isPending || clearMutation.isPending;
  const replaces = chosen ? replacesAnotherRecipient(current, chosen) : false;
  const canSave = canSaveChosenRecipient({ current, chosen, replaceConfirmed });
  const live = check.data?.current ?? null;
  const checkText = check.data ? RECIPIENT_CHECK_TEXT[check.data.state] : undefined;

  const button = 'cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div data-testid="building-invoice-recipient" className="border border-neutral-300 bg-white">
      <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
        Invoices · default recipient in Xero
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 text-[12.5px]">
        <div className="text-[11px] text-neutral-600">
          The Xero contact this building&apos;s invoices are addressed to (the name on the invoice, not a person). For this building
          only: other buildings that use the same Xero contact, and invoices already created, are not changed.
        </div>

        {/* What is selected now. */}
        {current.kind === 'own' ? (
          <div data-testid="current-recipient" className="border border-teal-700/40 bg-teal-100/40 p-2.5">
            <div className="text-[10.5px] font-semibold tracking-[0.08em] text-teal-700 uppercase">Current recipient</div>
            <div className="font-semibold text-ink">{live?.name ?? current.name}</div>
            <div className="text-neutral-700">{live ? (live.email ?? 'No email address in Xero') : (current.email ?? 'No email address recorded')}</div>
            {check.isLoading && <div className="text-[11px] text-neutral-500">Checking in Xero…</div>}
            {live?.address && <div data-testid="current-recipient-address" className="text-neutral-600">{live.address}</div>}
            {live && !live.address && <div className="text-neutral-500">No billing address in Xero</div>}
            {live?.accountNumber && <div className="text-[11px] text-neutral-500">Account {live.accountNumber}</div>}
            {checkText && <div className={`text-[11.5px] ${checkText.ok ? 'text-teal-700' : 'text-missed-fg'}`}>{checkText.text}</div>}
            {check.data?.nameChanged && (
              <div className="text-[11.5px] text-due-fg">Its name in Xero has changed since it was chosen (it was “{current.name}”). Choose it again to record the new name.</div>
            )}
            {check.isError && (
              <div className="text-[11.5px] text-due-fg">
                Couldn&apos;t check it in Xero just now: {check.error instanceof Error ? check.error.message : 'unknown error'}
              </div>
            )}
          </div>
        ) : current.kind === 'contact' ? (
          <div data-testid="current-recipient" className="border border-neutral-300 bg-neutral-100 p-2.5">
            <div className="text-[10.5px] font-semibold tracking-[0.08em] text-neutral-600 uppercase">Current: contact-based default</div>
            <div className="font-semibold text-ink">{current.name}</div>
            <div className="text-neutral-600">
              The older way, through {current.contactName ?? 'a contact'}&apos;s Xero link. Choose the building&apos;s Xero contact to replace it,
              or clear it; the contact and their Xero link are kept either way.
            </div>
            {check.isLoading && <div className="text-[11px] text-neutral-500">Checking in Xero…</div>}
            {checkText && (
              <div data-testid="contact-default-check" className={`text-[11.5px] ${checkText.ok ? 'text-teal-700' : 'text-missed-fg'}`}>
                {checkText.text}
              </div>
            )}
            {check.data?.currentName && check.data.currentName !== current.name && (
              <div className="text-[11.5px] text-due-fg">Its name in Xero is now “{check.data.currentName}”.</div>
            )}
            {check.isError && (
              <div className="text-[11.5px] text-due-fg">
                Couldn&apos;t check it in Xero just now: {check.error instanceof Error ? check.error.message : 'unknown error'}
              </div>
            )}
          </div>
        ) : (
          <div data-testid="current-recipient" className="text-neutral-600">
            No invoice recipient yet: each invoice for this building needs a Xero contact chosen for it, until one is set here. Nothing is
            assumed from names or emails.
          </div>
        )}

        {/* Actions on the current recipient. */}
        {!searching && !chosen && !confirmingClear && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={button} disabled={busy} onClick={() => { setSearching(true); setNotice(null); setError(null); }}>
              {current.kind === 'own' ? 'Replace recipient' : current.kind === 'contact' ? "Choose the building's Xero contact" : 'Find the invoice contact in Xero'}
            </button>
            {current.kind !== 'none' && (
              <button type="button" className="cursor-pointer px-2.5 py-1 text-[11.5px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-60" disabled={busy} onClick={() => { setConfirmingClear(true); setNotice(null); setError(null); }}>
                {current.kind === 'contact' ? 'Clear contact-based default' : 'Clear recipient'}
              </button>
            )}
          </div>
        )}

        {searching && !chosen && (
          <XeroRecipientSearch
            initialTerm={recipientSearchStartTerm(building.invoiceDetails)}
            purpose="For this building only: other buildings and invoices already created are not changed."
            disabled={busy}
            onCancel={() => setSearching(false)}
            onChoose={(c) => {
              setChosen(c);
              setReplaceConfirmed(false);
            }}
          />
        )}

        {/* Confirmation: exactly which contact will be saved, and what it replaces. */}
        {chosen && (
          <div data-testid="confirm-recipient" className="flex flex-col gap-1.5 border border-neutral-400 bg-neutral-100 p-2.5">
            <div className="text-[10.5px] font-semibold tracking-[0.08em] text-neutral-700 uppercase">Save as this building&apos;s recipient?</div>
            <div className="font-semibold text-ink">{chosen.name}</div>
            <div className="text-neutral-700">{chosen.email ?? 'No email address'}</div>
            <div className="text-neutral-600">{chosen.address ?? 'No billing address in Xero'}</div>
            {chosen.accountNumber && <div className="text-[11px] text-neutral-500">Account {chosen.accountNumber}</div>}
            {replaces && current.kind !== 'none' && (
              <label className="flex items-start gap-1.5 text-[11.5px] text-due-fg">
                <input type="checkbox" checked={replaceConfirmed} onChange={(e) => setReplaceConfirmed(e.target.checked)} disabled={busy} />
                <span>
                  Replace <span className="font-semibold">{current.name}</span> as this building&apos;s invoice recipient.
                </span>
              </label>
            )}
            {!replaces && current.kind !== 'none' && (
              <div className="text-[11.5px] text-neutral-600">This is already the building&apos;s recipient: saving refreshes its details.</div>
            )}
            <div className="flex gap-1.5">
              <button
                type="button"
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canSave || busy}
                onClick={() => saveMutation.mutate(chosen)}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save recipient'}
              </button>
              <button type="button" className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60" disabled={busy} onClick={() => setChosen(null)}>
                Choose another
              </button>
              <button type="button" className="cursor-pointer px-2 py-1.5 text-xs text-neutral-600 underline disabled:opacity-60" disabled={busy} onClick={reset}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {confirmingClear && current.kind !== 'none' && (
          <div data-testid="confirm-clear-recipient" className="flex flex-col gap-1.5 border border-missed/60 bg-missed/10 p-2.5 text-[11.5px] text-missed-fg">
            <div>
              Clear <span className="font-semibold">{current.name}</span> as this building&apos;s invoice recipient? Invoices for it will need a
              recipient chosen each time. Other buildings that use the same Xero contact keep it.
              {current.kind === 'contact' && ` ${current.contactName ?? 'The contact'} and their Xero link are kept.`}
            </div>
            <div className="flex gap-1.5">
              <button type="button" className="cursor-pointer bg-missed px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60" disabled={busy} onClick={() => clearMutation.mutate()}>
                {clearMutation.isPending ? 'Clearing…' : 'Clear recipient'}
              </button>
              <button type="button" className="cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 disabled:opacity-60" disabled={busy} onClick={() => setConfirmingClear(false)}>
                Keep it
              </button>
            </div>
          </div>
        )}

        {notice && <div role="status" className="text-[11.5px] text-teal-700">{notice}</div>}
        {error && (
          <div role="alert" data-testid="recipient-error" className="text-[11.5px] text-missed-fg">
            {error}{' '}
            <button
              type="button"
              className="cursor-pointer underline"
              onClick={() => {
                setError(null);
                reset();
                refresh();
              }}
            >
              Reload this building&apos;s recipient
            </button>
          </div>
        )}

        <div data-testid="invoice-recipient-details" className="mt-1 flex gap-3 border-t border-divider pt-2">
          <span className="flex-none text-[11px] text-neutral-600">Invoice details</span>
          <span className={`ml-auto text-right whitespace-pre-line ${building.invoiceDetails ? 'text-ink' : 'text-neutral-500'}`}>
            {building.invoiceDetails || 'Not recorded'}
          </span>
        </div>
      </div>
    </div>
  );
}
