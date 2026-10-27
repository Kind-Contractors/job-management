import type { QueryClient } from '@tanstack/react-query';
import type { JobContactSummary } from '../../domain/types';
import { isUsableRecipient, linkStatusLabel } from '../../lib/xeroLinkStatus';

/**
 * Everything that shows a contact's Xero link reads it from these queries (the invoice editor's contacts come from
 * ['jobRows'], the building page's from ['contacts', clientId]), so a new link is visible everywhere once they refetch.
 */
export function refreshAfterXeroLink(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  queryClient.invalidateQueries({ queryKey: ['contacts'] });
}

/**
 * The client's contacts that cannot be invoiced yet because they are not (or no longer validly) linked to a Xero contact,
 * each with a Link action. A native <select> option cannot hold a button, so this sits directly under the recipient selector.
 * Link only reports which contact was clicked; the caller opens the existing LinkXeroContactDialog. Nothing here sends anything.
 */
export default function UnlinkedRecipientsList({
  contacts,
  onLink,
  disabled = false,
}: {
  contacts: JobContactSummary[];
  onLink: (contact: JobContactSummary) => void;
  disabled?: boolean;
}) {
  const unlinked = contacts.filter((c) => !isUsableRecipient(c));
  if (unlinked.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Not linked to Xero</div>
      <div data-testid="unlinked-list" className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
      {unlinked.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-neutral-300 px-2 py-1.5 text-[12px]">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-ink">{c.name}</div>
            {c.email && <div className="truncate text-[11px] text-neutral-600">{c.email}</div>}
            <div className="text-[11px] text-due-fg">{linkStatusLabel(c)}</div>
            <div className="text-[11px] text-neutral-600">Link it to its existing Xero contact to invoice it.</div>
          </div>
          <button
            type="button"
            onClick={() => onLink(c)}
            disabled={disabled}
            aria-label={`Link ${c.name} to a Xero contact`}
            className="shrink-0 cursor-pointer bg-teal px-3 py-1 text-[11.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Link
          </button>
        </div>
      ))}
      </div>
    </div>
  );
}
