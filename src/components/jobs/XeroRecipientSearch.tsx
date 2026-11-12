import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '../../lib/dialogHooks';
import { searchXeroRecipients, type XeroBlockedReason, type XeroRecipientCandidate } from '../../repository/xeroLinksRepository';

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

interface XeroRecipientSearchProps {
  /** Starting search text (for example the building's invoice details); the manager can change it. */
  initialTerm?: string;
  /** Says what choosing does, under the search box (for example "For this invoice only"). */
  purpose: string;
  disabled: boolean;
  onChoose: (candidate: XeroRecipientCandidate) => void;
  onCancel: () => void;
}

/**
 * Finds an EXISTING Xero contact to invoice, by its name (the invoice contact - "16-17 Marylebone Adrian Levy" - not a person).
 * Read-only: it searches the connected Xero organisation and lists the candidates with their full email and address so similar
 * ones can be told apart (look-alike names and emails are flagged). Nothing is ever chosen for the manager, not even a single
 * result; archived, merged and email-less contacts are shown but cannot be chosen. The caller decides what choosing means; the
 * server re-reads the chosen contact and refuses it if it changed.
 */
export default function XeroRecipientSearch({ initialTerm = '', purpose, disabled, onChoose, onCancel }: XeroRecipientSearchProps) {
  const [term, setTerm] = useState(initialTerm.replace(/\s+/g, ' ').trim().slice(0, SEARCH_TERM_MAX));
  const [submitted, setSubmitted] = useState<string | null>(null);
  const debounced = useDebouncedValue(term.trim(), XERO_AUTOSEARCH_DELAY_MS);
  const searchTerm = submitted ?? debounced;
  const search = useQuery({
    queryKey: ['xeroRecipientSearch', searchTerm],
    queryFn: () => searchXeroRecipients(searchTerm),
    enabled: searchTerm.length >= 2 && searchTerm.length <= SEARCH_TERM_MAX,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
    meta: { persist: false },
  });
  const tooLong = term.trim().length > SEARCH_TERM_MAX;
  const results = search.data?.results ?? [];

  return (
    <div data-testid="xero-recipient-search" className="mt-1 flex flex-col gap-1.5 border border-neutral-300 bg-white p-2">
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(term.trim());
        }}
      >
        <input
          aria-label="Search Xero contacts by name"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setSubmitted(null);
          }}
          disabled={disabled}
          placeholder="Invoice contact name in Xero"
          className="min-w-0 flex-1 border border-neutral-300 px-2 py-1 text-[12px]"
        />
        <button
          type="submit"
          disabled={disabled || term.trim().length < 2 || tooLong}
          className="cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Search
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="cursor-pointer px-1 text-[11px] text-neutral-600 underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
      </form>
      <div className="text-[11px] text-neutral-600">{purpose}</div>
      {tooLong && <div className="text-[11px] text-missed-fg">Xero searches at most {SEARCH_TERM_MAX} characters: shorten the name.</div>}
      {search.isError && (
        <div role="alert" className="text-[11px] text-missed-fg">
          {search.error instanceof Error ? search.error.message : 'The search failed.'}
        </div>
      )}
      {search.isFetching && <div className="text-[11px] text-neutral-500">Searching Xero…</div>}
      {search.isSuccess && results.length === 0 && !search.isFetching && (
        <div className="text-[11px] text-neutral-600">No Xero contact matches “{searchTerm}”. Try part of the name.</div>
      )}
      {results.length > 0 && (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" data-testid="xero-recipient-results">
          {results.map((c) => (
            <li key={c.contactId} className="flex items-start gap-2 border border-neutral-200 p-1.5 text-[11.5px]">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-ink">{c.name}</div>
                <div className="text-neutral-700">{c.email ?? 'No email address'}</div>
                {c.address && <div className="text-neutral-600">{c.address}</div>}
                <div className="flex flex-wrap gap-x-2 text-[10.5px] text-neutral-500">
                  {c.accountNumber && <span>Account {c.accountNumber}</span>}
                  {c.sameNameAsOthers > 0 && <span className="text-due-fg">Same name as another result</span>}
                  {c.sameEmailAsOthers > 0 && <span className="text-due-fg">Same email as another result</span>}
                  {c.blockedReason && <span className="text-missed-fg">{BLOCKED_TEXT[c.blockedReason]}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onChoose(c)}
                disabled={disabled || c.blockedReason !== null}
                className="flex-none cursor-pointer border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Use this contact
              </button>
            </li>
          ))}
        </ul>
      )}
      {search.data?.mayBeIncomplete && (
        <div className="text-[11px] text-neutral-600">There may be more matches: type more of the name to narrow the list.</div>
      )}
    </div>
  );
}
