import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { backdropDismiss, useDebouncedValue } from '../../lib/dialogHooks';
import { XERO_AUTOSEARCH_DELAY_MS } from './FindXeroContactPanel';
import {
  findXeroContactsByEmail,
  linkContact,
  searchXeroContacts,
  type XeroBlockedReason,
  type XeroContactCandidate,
  type XeroEmailMatchResult,
} from '../../repository/xeroLinksRepository';

interface LinkXeroContactDialogProps {
  localContactId: string;
  localContactName: string;
  /** The contact's email in the app, shown in the email-first lookup (the server reads the email from the database itself). */
  localContactEmail: string | null;
  /** The Xero contact this person is already linked to, if any: choosing a different one asks for an explicit replace. */
  currentXeroContactId: string | null;
  onClose: () => void;
  onLinked: () => void;
}

/** Xero's limit for a contact search term. */
const SEARCH_TERM_MAX = 50;

const BLOCKED_TEXT: Record<XeroBlockedReason, string> = {
  ARCHIVED: 'Archived in Xero',
  NOT_ACTIVE: 'Not active in Xero',
  MERGED: 'Merged into another contact',
  NO_EMAIL: 'No email address in Xero',
};

/** What the email-first lookup found, in words. It never decides anything: the manager still chooses and confirms. */
export function emailLookupMessage(result: Pick<XeroEmailMatchResult, 'outcome' | 'results' | 'mayBeIncomplete'>, email: string): string {
  switch (result.outcome) {
    case 'one':
      return `Found by email: one Xero contact has exactly the email ${email}. Check it is the right one, then choose it.`;
    case 'several':
      return `${result.results.filter((r) => r.blockedReason === null).length} Xero contacts have exactly the email ${email}. Choose the right one: the app does not pick for you.`;
    case 'only_blocked':
      return `A Xero contact has exactly the email ${email}, but it cannot be linked (see why below). Restore it in Xero, or search by name below.`;
    case 'none':
      return result.mayBeIncomplete
        ? `Xero returned too many contacts containing ${email} to be sure none has exactly this email. Search by name below.`
        : `No Xero contact has the email ${email}. If the contact uses a different email in Xero, search by name below.`;
    case 'no_local_email':
      return 'This contact has no email address in the app, so Xero cannot be searched by email. Search by name below.';
    case 'invalid_local_email':
      return "This contact's email address in the app is not valid, so Xero cannot be searched by email. Correct it, or search by name below.";
  }
}

/**
 * Finds an EXISTING Xero contact and links it to one local contact. It looks by EMAIL first (Xero contacts whose own email is
 * exactly this contact's), and offers a name search for a contact that uses a different email in Xero. Nothing is selected for
 * the manager: each lookup lists candidates, the manager picks one, sees what will be linked, and confirms. Contacts that cannot
 * be invoiced (archived, merged, no email) are shown but cannot be chosen. Look-alikes (same name or email) are flagged. The app
 * never creates a Xero contact.
 */
export default function LinkXeroContactDialog({
  localContactId,
  localContactName,
  localContactEmail,
  currentXeroContactId,
  onClose,
  onLinked,
}: LinkXeroContactDialogProps) {
  // Closes on a backdrop click only when the press also started on the backdrop (never mid-typing: see backdropDismiss).
  const backdrop = backdropDismiss(onClose);
  // Xero accepts a search term of at most 50 characters (the server refuses longer ones too).
  // The name search starts EMPTY: the manager types what to look for (nothing is pre-filled or searched for them).
  const [term, setTerm] = useState('');
  const [chosen, setChosen] = useState<XeroContactCandidate | null>(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = localContactEmail?.trim() ?? '';
  // Email-first: a read-only lookup, run when the dialog opens for a contact that has an email. It lists; it never links.
  const emailQuery = useQuery({
    queryKey: ['xeroEmailMatch', localContactId, email],
    queryFn: () => findXeroContactsByEmail(localContactId),
    enabled: email !== '',
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  // The name search runs as the manager types (once typing pauses, at least 2 characters), or at once with Enter / Search. Same
  // read-only search and cache as "Find a contact in Xero"; results are never written to the browser's saved cache.
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

  const linkMutation = useMutation({
    mutationFn: (c: XeroContactCandidate) =>
      linkContact({ localContactId, xeroContactId: c.contactId, expectedName: c.name, replace: replace || undefined }),
    onSuccess: () => {
      onLinked();
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The link could not be saved.'),
  });

  const results = searchTerm.length >= 2 ? (search.data?.results ?? null) : null;
  const searchedTerm = searchTerm;
  const searchError = search.isError ? (search.error instanceof Error ? search.error.message : 'The search failed.') : null;
  const replacing = chosen !== null && currentXeroContactId !== null && currentXeroContactId.toLowerCase() !== chosen.contactId.toLowerCase();

  const renderCandidate = (c: XeroContactCandidate) => {
    const blocked = c.blockedReason !== null;
    const isChosen = chosen?.contactId === c.contactId;
    return (
      <div key={c.contactId} className={`border px-2 py-1.5 text-[12.5px] ${isChosen ? 'border-teal bg-teal-100' : 'border-neutral-300'}`}>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-ink">{c.name}</span>
          {blocked && (
            <span className="border border-missed-fg px-1 text-[9.5px] font-semibold tracking-[0.08em] text-missed-fg uppercase">
              {BLOCKED_TEXT[c.blockedReason!]}
            </span>
          )}
          <button
            disabled={blocked}
            onClick={() => {
              setChosen(c);
              setReplace(false);
              setError(null);
            }}
            className="ml-auto cursor-pointer border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isChosen ? 'Chosen' : 'Choose'}
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
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30" {...backdrop}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-[480px] overflow-y-auto border border-neutral-300 bg-white p-4">
        <div className="flex items-center gap-2 border-b border-divider pb-2.5">
          <div>
            <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Link to Xero contact</div>
            <h2 className="font-heading text-lg leading-tight font-semibold">{localContactName}</h2>
          </div>
          <button onClick={onClose} className="ml-auto cursor-pointer text-[11.5px] text-neutral-500 hover:text-ink">
            Close
          </button>
        </div>

        <p className="mt-2 text-[11.5px] text-neutral-600">
          Find the contact that already exists in Xero, then choose it. Contacts are never created or changed in Xero from here, and nothing
          is linked until you confirm.
        </p>

        <div data-testid="email-lookup" className="mt-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">By email</div>
          {email === '' ? (
            <p className="mt-1 text-[12px] text-neutral-700">{emailLookupMessage({ outcome: 'no_local_email', results: [], mayBeIncomplete: false }, email)}</p>
          ) : emailQuery.isPending ? (
            <p className="mt-1 text-[12px] text-neutral-600">Looking for a Xero contact with the email {email}…</p>
          ) : emailQuery.isError ? (
            <p className="mt-1 text-[12px] text-missed-fg">
              The email search failed: {emailQuery.error instanceof Error ? emailQuery.error.message : 'unknown error.'} You can still search by
              name below.
            </p>
          ) : (
            <>
              <p className="mt-1 text-[12px] text-neutral-700">{emailLookupMessage(emailQuery.data, email)}</p>
              {emailQuery.data.results.length > 0 && <div className="mt-1.5 flex flex-col gap-1">{emailQuery.data.results.map(renderCandidate)}</div>}
            </>
          )}
        </div>

        <div className="mt-3 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">By name</div>
        <form
          className="mt-1 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (term.trim().length >= 2) {
              setSubmitted(term.trim());
              setChosen(null);
              setError(null);
            }
          }}
        >
          <input
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setSubmitted(null);
              setChosen(null);
              setError(null);
            }}
            maxLength={SEARCH_TERM_MAX}
            placeholder="Search Xero contacts by name or email"
            aria-label="Search Xero contacts"
            className="min-w-0 flex-1 border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
          <button
            type="submit"
            disabled={search.isFetching || term.trim().length < 2}
            className="cursor-pointer bg-teal px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {search.isFetching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {(error ?? searchError) && <div className="mt-2 text-[11.5px] text-missed-fg">{error ?? searchError}</div>}

        {results !== null && results.length === 0 && (
          <div className="mt-2.5 border border-neutral-300 bg-neutral-100 px-2.5 py-2 text-[12px] text-neutral-700">
            No Xero contact&apos;s name or email contains “{searchedTerm}”. Try part of the name (a surname, or the company), or create the contact
            in Xero. Nothing is created here.
          </div>
        )}

        {results !== null && results.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1">
            <div className="text-[11px] text-neutral-600">
              Found by name: the email in Xero may differ from this contact&apos;s. Nothing is linked unless you choose one and confirm.
            </div>
            {search.data?.mayBeIncomplete && (
              <div className="text-[11px] text-due-fg">There may be more matches than shown. Refine the search to narrow them down.</div>
            )}
            {results.map(renderCandidate)}
          </div>
        )}

        {chosen && (
          <div className="mt-2.5 border-t border-divider pt-2.5">
            <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Confirm</div>
            <p className="mt-1 text-[12.5px] text-ink">
              Link <span className="font-semibold">{localContactName}</span> to the Xero contact <span className="font-semibold">{chosen.name}</span>
              {chosen.location ? ` (${chosen.location})` : ''}? Invoices addressed to this contact will be sent to that Xero contact.
            </p>
            {replacing && (
              <label className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-due-fg">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                This contact is already linked to a different Xero contact. Replace that link.
              </label>
            )}
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => linkMutation.mutate(chosen)}
                disabled={linkMutation.isPending || (replacing && !replace)}
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {linkMutation.isPending ? 'Linking…' : 'Link this contact'}
              </button>
              <button onClick={() => setChosen(null)} className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-[11.5px] text-neutral-600">
                Choose a different one
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
