import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  linkContact,
  searchXeroContacts,
  type XeroBlockedReason,
  type XeroContactCandidate,
} from '../../repository/xeroLinksRepository';

interface LinkXeroContactDialogProps {
  localContactId: string;
  localContactName: string;
  /** Only a SUGGESTED search term (for example the client's name); nothing is searched or linked until the manager acts. */
  suggestedTerm: string;
  /** The Xero contact this person is already linked to, if any: choosing a different one asks for an explicit replace. */
  currentXeroContactId: string | null;
  onClose: () => void;
  onLinked: () => void;
}

const BLOCKED_TEXT: Record<XeroBlockedReason, string> = {
  ARCHIVED: 'Archived in Xero',
  NOT_ACTIVE: 'Not active in Xero',
  MERGED: 'Merged into another contact',
  NO_EMAIL: 'No email address in Xero',
};

/**
 * Finds an EXISTING Xero contact and links it to one local contact. Nothing is selected for the manager: a search lists
 * candidates, the manager picks one, sees what will be linked, and confirms. Contacts that cannot be invoiced (archived, merged,
 * no email) are shown but cannot be chosen. Look-alikes (same name or email) are flagged. The app never creates a Xero contact.
 */
export default function LinkXeroContactDialog({
  localContactId,
  localContactName,
  suggestedTerm,
  currentXeroContactId,
  onClose,
  onLinked,
}: LinkXeroContactDialogProps) {
  const [term, setTerm] = useState(suggestedTerm);
  const [chosen, setChosen] = useState<XeroContactCandidate | null>(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: (t: string) => searchXeroContacts(t),
    onMutate: () => {
      setChosen(null);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The search failed.'),
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

  const results = searchMutation.data?.results ?? null;
  const replacing = chosen !== null && currentXeroContactId !== null && currentXeroContactId.toLowerCase() !== chosen.contactId.toLowerCase();

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30" onClick={onClose}>
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
          Search for the contact that already exists in Xero, then choose it. Contacts are never created or changed in Xero from here, and nothing
          is linked until you confirm.
        </p>

        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (term.trim().length >= 2) searchMutation.mutate(term.trim());
          }}
        >
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search Xero contacts by name"
            aria-label="Search Xero contacts"
            className="min-w-0 flex-1 border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
          <button
            type="submit"
            disabled={searchMutation.isPending || term.trim().length < 2}
            className="cursor-pointer bg-teal px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {searchMutation.isPending ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && <div className="mt-2 text-[11.5px] text-missed-fg">{error}</div>}

        {results !== null && results.length === 0 && (
          <div className="mt-2.5 border border-neutral-300 bg-neutral-100 px-2.5 py-2 text-[12px] text-neutral-700">
            No contact in Xero matches “{term.trim()}”. Create it in Xero, or search for another name. Nothing is created here.
          </div>
        )}

        {results !== null && results.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1">
            {searchMutation.data?.mayBeIncomplete && (
              <div className="text-[11px] text-due-fg">There may be more matches than shown. Refine the search to narrow them down.</div>
            )}
            {results.map((c) => {
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
            })}
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
