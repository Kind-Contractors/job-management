import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BuildingRow, Contact } from '../../domain/types';
import { defaultRecipientProblem, isUsableRecipient, VERIFY_STATE_TEXT } from '../../lib/xeroLinkStatus';
import { contactInitials } from '../../lib/contactDisplay';
import {
  clearBuildingDefaultRecipient,
  setBuildingDefaultRecipient,
  verifyBuildingDefault,
  type XeroLinkVerification,
} from '../../repository/xeroLinksRepository';

/**
 * The building's default invoice recipient: which Xero-linked contact of this client an invoice for this building goes to
 * unless another valid linked contact is chosen for that one invoice. It is chosen here by a manager, never guessed (not the
 * primary contact, not the only contact). Only contacts explicitly linked to a Xero contact can be chosen, and the server
 * (xero-link-contact, manager-only) re-checks that the contact belongs to this building's client and is still valid in the
 * connected Xero organisation before saving it.
 */
export default function BuildingDefaultRecipientPanel({ building, contacts }: { building: BuildingRow; contacts: Contact[] }) {
  const queryClient = useQueryClient();
  const [pickedId, setPickedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<XeroLinkVerification | null>(null);
  const [changing, setChanging] = useState(false);

  const def = building.defaultRecipient;
  const defaultContact = def ? (contacts.find((c) => c.id === def.contactId) ?? null) : null;
  const problem = defaultRecipientProblem(def, contacts);
  const linkable = contacts.filter(isUsableRecipient);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };
  const onError = (fallback: string) => (err: unknown) => setError(err instanceof Error ? err.message : fallback);

  const setMutation = useMutation({
    mutationFn: (contactId: string) => setBuildingDefaultRecipient(building.id, contactId),
    onSuccess: () => {
      setPickedId('');
      setChanging(false);
      setError(null);
      setVerification(null);
      refresh();
    },
    onError: onError('The default recipient could not be saved.'),
  });
  const clearMutation = useMutation({
    mutationFn: () => clearBuildingDefaultRecipient(building.id),
    onSuccess: () => {
      setError(null);
      setVerification(null);
      refresh();
    },
    onError: onError('The default recipient could not be cleared.'),
  });
  const verifyMutation = useMutation({
    mutationFn: () => verifyBuildingDefault(building.id),
    onSuccess: (v) => {
      setVerification(v);
      setError(null);
    },
    onError: onError('The default recipient could not be verified.'),
  });

  const busy = setMutation.isPending || clearMutation.isPending;

  // The select is shown straight away when no default is set; with a default it opens from "Change".
  const showPicker = !def || changing;

  return (
    <div data-testid="invoice-default" className="border border-neutral-300 bg-white">
      <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
        Invoices · default recipient
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 text-[12.5px]">
        <div className="text-[11px] text-neutral-600">
          For this building only. Invoices for it go to this Xero-linked contact unless another is chosen for a single invoice (which
          never changes this default).
        </div>
        {def ? (
          <div className="flex items-center gap-3 border border-neutral-300 bg-neutral-100 p-2.5">
            <span aria-hidden="true" className="grid h-8 w-8 flex-none place-items-center bg-teal font-heading text-[11px] font-semibold text-white">
              {defaultContact ? contactInitials(defaultContact.name) : '?'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-neutral-600">Default invoice recipient</div>
              <div className="truncate font-semibold text-ink">{defaultContact?.name ?? 'A contact that is no longer on this client'}</div>
              {defaultContact?.xeroContactName && <div className="truncate text-[11.5px] text-teal-700">✓ Xero: {defaultContact.xeroContactName}</div>}
            </div>
          </div>
        ) : (
          <div>
            <div className="text-[11px] text-neutral-600">Default invoice recipient</div>
            <div className="text-neutral-600">
              None set. An invoice for this building needs a recipient chosen each time. Nothing is assumed from the client's contacts.
            </div>
          </div>
        )}
        {def && problem && <div className="text-[11.5px] text-missed-fg">{problem} Invoices for this building cannot be sent until it is fixed.</div>}
        {def && verification && (
          <div className={`text-[11.5px] ${VERIFY_STATE_TEXT[verification.state].ok ? 'text-teal-700' : 'text-missed-fg'}`}>
            {VERIFY_STATE_TEXT[verification.state].text}
          </div>
        )}

        {def && !changing && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                setChanging(true);
                setPickedId('');
              }}
              disabled={busy}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:opacity-60"
            >
              Change
            </button>
            <button
              onClick={() => verifyMutation.mutate()}
              disabled={verifyMutation.isPending}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
            >
              {verifyMutation.isPending ? 'Checking…' : 'Verify with Xero'}
            </button>
            <button
              onClick={() => clearMutation.mutate()}
              disabled={busy}
              className="cursor-pointer px-2.5 py-1 text-[11.5px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-60"
            >
              {clearMutation.isPending ? 'Clearing…' : 'Clear default'}
            </button>
          </div>
        )}

        {showPicker && (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              {def ? 'Change default to' : 'Set default to'}
              <select
                value={pickedId}
                onChange={(e) => setPickedId(e.target.value)}
                disabled={busy || linkable.length === 0}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100"
              >
                <option value="">{linkable.length === 0 ? 'No contact is linked to Xero yet' : 'Choose a linked contact…'}</option>
                {linkable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.xeroContactName ? ` — Xero: ${c.xeroContactName}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {linkable.length === 0 && (
              <div className="text-[11px] text-neutral-500">Link a contact to its Xero contact first (&ldquo;Link to Xero&rdquo; under Manage contacts).</div>
            )}
            <div className="flex gap-1.5">
              <button
                onClick={() => pickedId && setMutation.mutate(pickedId)}
                disabled={!pickedId || busy}
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {setMutation.isPending ? 'Saving…' : 'Save default'}
              </button>
              {def && (
                <button
                  onClick={() => {
                    setChanging(false);
                    setPickedId('');
                  }}
                  disabled={busy}
                  className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}
      </div>
    </div>
  );
}
