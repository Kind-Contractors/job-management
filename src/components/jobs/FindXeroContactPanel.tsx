import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '../../lib/dialogHooks';
import type { JobContactSummary } from '../../domain/types';
import { isUsableRecipient } from '../../lib/xeroLinkStatus';
import { xeroPanelLinkState } from '../../lib/xeroPanelLink';
import { linkContact, searchXeroContacts, type XeroBlockedReason, type XeroContactCandidate } from '../../repository/xeroLinksRepository';

/** Xero's limit for a contact search term (the server refuses longer ones too). */
const SEARCH_TERM_MAX = 50;
/** Search-as-you-type: how long typing must pause before Xero is searched (Enter / Search searches at once). */
export const XERO_AUTOSEARCH_DELAY_MS = 450;

const BLOCKED_TEXT: Record<XeroBlockedReason, string> = {
  ARCHIVED: 'Archived in Xero',
  NOT_ACTIVE: 'Not active in Xero',
  MERGED: 'Merged into another contact',
  NO_EMAIL: 'No email address in Xero',
};

export interface XeroPanelLinked {
  localContactId: string;
  localContactName: string;
  xeroContactName: string;
  /** Other app contacts (any client) linked to the same Xero contact, as the server counted them after linking. */
  alsoLinkedToOtherContacts: number;
}

interface FindXeroContactPanelProps {
  /** The client's contacts: one of them is chosen, deliberately, as the app contact the Xero contact belongs to. */
  contacts: JobContactSummary[];
  /** The building's default invoice contact, if any: its Xero link cannot be changed while it is the default (the server refuses). */
  buildingDefaultContactId: string | null;
  /** A contact just added through "+ Add a new contact" from this panel: offered as the app contact once it appears in the list. */
  newContactId: string | null;
  disabled: boolean;
  /** Opens the existing new-contact form; the manager comes back here to confirm the link. */
  onAddContact: () => void;
  onLinked: (linked: XeroPanelLinked) => void;
}

/**
 * Search-first linking (Building File → Contacts & Defaults): find an EXISTING Xero contact by name or email, choose it, say which app contact it belongs
 * to, and confirm. Uses the same read-only search and the same link call as the shared link dialog (xero-link-contact), so the
 * server keeps every check: blocked contacts refused, the contact re-read and its name compared, a replaced link confirmed, a
 * building default's link protected. Nothing is chosen for the manager (no match is preselected, no app contact is guessed), no
 * contact is created or copied from Xero, emails stay masked as the server returns them, and linking never creates, sends or
 * emails an invoice.
 */
export default function FindXeroContactPanel({
  contacts,
  buildingDefaultContactId,
  newContactId,
  disabled,
  onAddContact,
  onLinked,
}: FindXeroContactPanelProps) {
  const [term, setTerm] = useState('');
  const [chosen, setChosen] = useState<XeroContactCandidate | null>(null);
  const [localId, setLocalId] = useState('');
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Searched as the manager types (once typing pauses, at least 2 characters), or at once with Enter / Search. A query keyed by the
  // term: an older, slower answer can never replace a newer one, and a term already searched is answered from memory. Read-only;
  // results are never written to the browser's saved cache (persist: false).
  const [submitted, setSubmitted] = useState<string | null>(null);
  const debounced = useDebouncedValue(term.trim(), XERO_AUTOSEARCH_DELAY_MS);
  const searchTerm = submitted ?? debounced;
  const search = useQuery({
    queryKey: ['xeroContactSearch', searchTerm],
    queryFn: () => searchXeroContacts(searchTerm),
    enabled: searchTerm.length >= 2 && searchTerm.length <= SEARCH_TERM_MAX,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
    meta: { persist: false },
  });
  const changeTerm = (value: string) => {
    setTerm(value);
    setSubmitted(null);
    // A different search: nothing stays chosen from the previous results.
    setChosen(null);
    setLocalId('');
    setReplace(false);
    setError(null);
  };

  const linkMutation = useMutation({
    mutationFn: ({ local, xero }: { local: JobContactSummary; xero: XeroContactCandidate }) =>
      linkContact({ localContactId: local.id, xeroContactId: xero.contactId, expectedName: xero.name, replace: replace || undefined }),
    onSuccess: (result, { local, xero }) => {
      onLinked({ localContactId: local.id, localContactName: local.name, xeroContactName: xero.name, alsoLinkedToOtherContacts: result.alsoLinkedToOtherContacts });
      setChosen(null);
      setLocalId('');
      setReplace(false);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The link could not be saved.'),
  });

  const results = searchTerm.length >= 2 ? (search.data?.results ?? null) : null;
  const searchedTerm = searchTerm;
  const searchError = search.isError ? (search.error instanceof Error ? search.error.message : 'The search failed.') : null;
  const busy = disabled || linkMutation.isPending;

  // The app contact (what the manager picked, or - only when they added one from here - that contact) and the confirm rules.
  const {
    ordered,
    localId: effectiveLocalId,
    local,
    waitingForNewContact,
    replacing,
    blockedAsDefault,
    alreadyLinkedHere,
    canConfirm,
  } = xeroPanelLinkState({
    contacts,
    chosenXeroContactId: chosen?.contactId ?? null,
    pickedLocalId: localId,
    newContactId,
    buildingDefaultContactId,
    replaceConfirmed: replace,
  });

  return (
    <div data-testid="find-xero-contact" className="flex flex-col gap-1.5 border border-neutral-300 bg-neutral-100 p-2">
      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Find a contact in Xero</div>
      <div className="text-[11px] text-neutral-600">
        Search the contacts that already exist in Xero (results appear as you type), choose one, then say which contact in the app it
        belongs to. Nothing is created in Xero, and nothing is linked until you confirm.
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim().length >= 2) setSubmitted(term.trim());
        }}
      >
        <input
          value={term}
          onChange={(e) => changeTerm(e.target.value)}
          maxLength={SEARCH_TERM_MAX}
          disabled={busy}
          placeholder="Name or email, e.g. Dome Assets"
          aria-label="Search Xero contacts by name or email"
          className="min-w-0 flex-1 border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100"
        />
        <button
          type="submit"
          disabled={busy || search.isFetching || term.trim().length < 2}
          className="cursor-pointer bg-teal px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {search.isFetching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {results !== null && results.length === 0 && (
        <div className="border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-700">
          No Xero contact&apos;s name or email contains &ldquo;{searchedTerm}&rdquo;. Try part of the name, or create the contact in Xero.
          Nothing is created here.
        </div>
      )}
      {results !== null && results.length > 0 && (
        <div data-testid="xero-search-results" className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
          {search.data?.mayBeIncomplete && (
            <div className="text-[11px] text-due-fg">There may be more matches than shown. Refine the search to narrow them down.</div>
          )}
          {results.map((c) => (
            <XeroCandidateCard
              key={c.contactId}
              candidate={c}
              chosen={chosen?.contactId === c.contactId}
              disabled={busy}
              onChoose={() => {
                setChosen(c);
                setLocalId('');
                setReplace(false);
                setError(null);
              }}
            />
          ))}
        </div>
      )}

      {chosen && (
        <div data-testid="xero-link-confirm" className="flex flex-col gap-1.5 border-t border-divider pt-2">
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Link {chosen.name} to which contact in the app?
            <select
              value={effectiveLocalId}
              onChange={(e) => {
                setLocalId(e.target.value);
                setReplace(false);
                setError(null);
              }}
              disabled={busy}
              className="border border-neutral-300 bg-white px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            >
              <option value="">Choose a contact…</option>
              {ordered.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.email ? ` — ${c.email}` : ''}
                  {isUsableRecipient(c) ? ` · already linked to Xero${c.xeroContactName ? `: ${c.xeroContactName}` : ''}` : ' · not linked to Xero yet'}
                </option>
              ))}
            </select>
          </label>
          {waitingForNewContact && <div className="text-[11px] text-neutral-600">Loading the contact you just added…</div>}
          <div className="text-[11px] text-neutral-600">
            Not in the list?{' '}
            <button type="button" onClick={onAddContact} disabled={busy} className="cursor-pointer font-semibold text-teal-700 underline disabled:opacity-60">
              + Add a new contact
            </button>{' '}
            (you type its details: nothing is copied from Xero), then come back here to confirm.
          </div>

          {alreadyLinkedHere.length > 0 && (
            <div className="text-[11px] text-due-fg">
              {chosen.name} is already linked to {alreadyLinkedHere.map((c) => c.name).join(', ')} in the app. Linking another contact to it is
              allowed, but check this is intended.
            </div>
          )}
          {blockedAsDefault && (
            <div className="text-[11px] text-due-fg">
              {local!.name} is this building&apos;s default invoice contact, so its Xero link cannot be changed. Clear that default (Default
              recipients) first, or choose another contact.
            </div>
          )}

          {local && (
            <>
              <p className="text-[12px] text-ink">
                Link <span className="font-semibold">{local.name}</span> to the Xero contact <span className="font-semibold">{chosen.name}</span>
                {chosen.location ? ` (${chosen.location})` : ''}? Invoices addressed to {local.name} will go to that Xero contact. Nothing is
                created or changed in Xero, and no invoice is created or emailed.
              </p>
              {replacing && (
                <label className="flex items-center gap-1.5 text-[11.5px] text-due-fg">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} disabled={busy} />
                  {local.name} is already linked to a different Xero contact{local.xeroContactName ? ` (${local.xeroContactName})` : ''}. Replace that
                  link.
                </label>
              )}
            </>
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => local && canConfirm && linkMutation.mutate({ local, xero: chosen })}
              disabled={!canConfirm || busy}
              className="cursor-pointer bg-teal px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {linkMutation.isPending ? 'Linking…' : 'Link contact'}
            </button>
            <button
              type="button"
              onClick={() => {
                setChosen(null);
                setLocalId('');
                setReplace(false);
                setError(null);
              }}
              disabled={linkMutation.isPending}
              className="cursor-pointer border border-neutral-300 bg-white px-2.5 py-1 text-[11.5px] text-neutral-600"
            >
              Choose a different one
            </button>
          </div>
        </div>
      )}
      {(error ?? searchError) && (
        <div role="alert" className="text-[11.5px] text-missed-fg">
          {error ?? searchError}
        </div>
      )}
    </div>
  );
}

/**
 * One Xero search result: name, a label when it cannot be used (archived, not active, merged, no email: shown, never choosable),
 * postcode and city, the email as the server masks it, the account number, and a warning when another result looks alike.
 */
export function XeroCandidateCard({
  candidate: c,
  chosen,
  disabled,
  onChoose,
}: {
  candidate: XeroContactCandidate;
  chosen: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const blocked = c.blockedReason !== null;
  return (
    <div className={`border px-2 py-1.5 text-[12px] ${chosen ? 'border-teal bg-teal-100' : 'border-neutral-300 bg-white'}`}>
      <div className="flex items-center gap-1.5">
        <span className="font-semibold text-ink">{c.name}</span>
        {blocked && (
          <span className="border border-missed-fg px-1 text-[9.5px] font-semibold tracking-[0.08em] text-missed-fg uppercase">
            {BLOCKED_TEXT[c.blockedReason!]}
          </span>
        )}
        <button
          type="button"
          disabled={blocked || disabled}
          onClick={onChoose}
          aria-label={`Choose the Xero contact ${c.name}`}
          className="ml-auto cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {chosen ? 'Chosen' : 'Choose'}
        </button>
      </div>
      <div className="text-neutral-600">
        {[c.location, c.emailHint, c.accountNumber ? `Account ${c.accountNumber}` : null].filter(Boolean).join(' · ') || 'No address or email shown'}
      </div>
      {(c.sameNameAsOthers > 0 || c.sameEmailAsOthers > 0) && (
        <div className="text-[11px] text-due-fg">
          Possible duplicate in Xero: {c.sameNameAsOthers > 0 && 'another contact has the same name'}
          {c.sameNameAsOthers > 0 && c.sameEmailAsOthers > 0 && ', '}
          {c.sameEmailAsOthers > 0 && 'another shares this email'}. Check which is the right one.
        </div>
      )}
    </div>
  );
}
