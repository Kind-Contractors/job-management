import { useMutation, useQuery } from '@tanstack/react-query';
import { checkContactDeletion, deleteContact } from '../../repository/contactsRepository';
import { contactDeletionPlan } from '../../lib/contactDeletion';
import { backdropDismiss } from '../../lib/dialogHooks';

interface DeleteContactDialogProps {
  contactId: string;
  /** The name shown while the check loads (the check then uses the name as saved). */
  contactName: string;
  clientId: string;
  clientName: string;
  onClose: () => void;
  /** After a successful delete (the caller refreshes the lists and shows a notice). */
  onDeleted: (name: string) => void;
}

/**
 * "Delete contact": first a fresh check of what depends on the contact (across all the client's buildings), then either why it
 * cannot be deleted yet - with how to resolve it - or a confirmation. The delete only goes ahead if the contact is still the
 * version checked; the database refuses anything that would break a building's invoice default or the job-report send history.
 * Escape, the close button or Cancel close it; a click on the backdrop closes it too (not while deleting).
 */
export default function DeleteContactDialog({ contactId, contactName, clientId, clientName, onClose, onDeleted }: DeleteContactDialogProps) {
  const check = useQuery({
    queryKey: ['contactDeletionCheck', contactId],
    queryFn: () => checkContactDeletion(contactId, clientId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    meta: { persist: false },
  });
  const remove = useMutation({
    mutationFn: () => {
      const c = check.data!;
      return deleteContact(c.contactId, clientId, c.updatedAt, c.name);
    },
    onSuccess: () => onDeleted(check.data!.name),
  });

  const plan = check.data ? contactDeletionPlan(check.data, clientName) : null;
  const blocked = !!plan && plan.blockers.length > 0;
  const close = () => {
    if (!remove.isPending) onClose();
  };
  const backdrop = backdropDismiss(remove.isPending ? undefined : onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" {...backdrop}>
      <div
        data-testid="delete-contact-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete contact: ${contactName}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        className="relative max-h-[90vh] w-[min(480px,95vw)] overflow-y-auto border border-neutral-300 bg-white p-4 outline-none"
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          // Focus starts here - inside the dialog, so Escape works at once, and on the safe choice (Enter closes, never deletes).
          // (React's autoFocus only works on form controls, not on the dialog's own <div>.)
          autoFocus
          className="absolute top-2 right-2 cursor-pointer px-2 py-1 text-[15px] leading-none text-neutral-600 hover:bg-neutral-100"
        >
          ×
        </button>
        <div className="mb-2.5 border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-missed-fg uppercase">Delete contact</div>
          <h2 className="font-heading text-lg leading-tight font-semibold">{check.data?.name ?? contactName}</h2>
        </div>

        {check.isPending ? (
          <p className="text-[12.5px] text-neutral-600">Checking what depends on this contact…</p>
        ) : check.isError ? (
          <p role="alert" className="text-[12.5px] text-missed-fg">
            {check.error instanceof Error ? check.error.message : 'The contact could not be checked.'} Nothing was deleted.
          </p>
        ) : !check.data ? (
          <p role="alert" className="text-[12.5px] text-missed-fg">This contact no longer exists for this client. Nothing was deleted.</p>
        ) : blocked ? (
          <div data-testid="delete-contact-blocked" className="flex flex-col gap-2 text-[12.5px] text-ink">
            <p className="font-semibold">It cannot be deleted yet:</p>
            <ul className="flex flex-col gap-1.5">
              {plan!.blockers.map((b) => (
                <li key={b.kind} data-blocker={b.kind} className="border border-due bg-due/10 p-2 text-[12px] text-due-fg">
                  {b.text}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div data-testid="delete-contact-confirm" className="flex flex-col gap-1.5 text-[12.5px] text-ink">
            {plan!.confirm.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}

        {remove.isError && (
          <p role="alert" className="mt-2 text-[12px] text-missed-fg">
            {remove.error instanceof Error ? remove.error.message : 'The contact could not be deleted.'}
          </p>
        )}

        <div className="mt-3 flex gap-1.5">
          {plan && !blocked && !remove.isError && (
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="cursor-pointer bg-missed px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {remove.isPending ? 'Deleting…' : 'Delete contact'}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            disabled={remove.isPending}
            className="cursor-pointer border border-neutral-300 px-2.5 py-1.5 text-[11.5px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
          >
            {plan && !blocked && !remove.isError ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
