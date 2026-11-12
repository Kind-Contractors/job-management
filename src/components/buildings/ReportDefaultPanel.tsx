import { useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Contact } from '../../domain/types';
import { updateContact } from '../../repository/contactsRepository';
import { contactInitials, REPORT_DEFAULT_PROBLEM, reportDefaultSummary } from '../../lib/contactDisplay';

interface ReportDefaultPanelProps {
  clientId: string;
  clientName: string;
  contacts: Contact[];
  buildingCount: number;
  refreshKeys: QueryKey[];
}

/**
 * The job-report default: the client's MAIN (primary) contact - the existing, client-wide contacts.is_primary (one per client),
 * which Ready for client already preselects (resolveReportRecipientDefault) and the jobs grid already shows. No new field.
 * Accounts-only contacts are not offered here, so the default can never be one; a report can still be sent to anyone of the
 * client deliberately on Ready for client. Saving goes through updateContact (which clears the previous main contact and logs
 * the change in each building's history).
 */
export default function ReportDefaultPanel({ clientId, clientName, contacts, buildingCount, refreshKeys }: ReportDefaultPanelProps) {
  const queryClient = useQueryClient();
  const [pickedId, setPickedId] = useState('');
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = reportDefaultSummary(contacts);
  const eligible = contacts.filter((c) => c.isAccountsContact !== true);
  const everywhere = buildingCount > 1 ? `all ${buildingCount} of ${clientName || 'this client'}'s buildings` : `every building of ${clientName || 'this client'}`;

  const saveMutation = useMutation({
    mutationFn: async (contactId: string) => {
      await updateContact(contactId, clientId, { isPrimary: true });
      await Promise.all(refreshKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
    onSuccess: () => {
      setPickedId('');
      setChanging(false);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The main contact could not be saved.'),
  });

  const showPicker = summary.kind === 'none' || changing;

  return (
    <section data-testid="report-default" className="rounded-md border border-neutral-300 bg-white px-[18px] py-4 text-[14px] text-ink">
      <div className="flex items-center justify-between gap-2.5">
        <h3 className="flex items-center gap-2 text-[15px] font-bold">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-teal">
            <path d="M7 3h7l5 5v13H7z" />
            <path d="M14 3v5h5M10 13h6M10 17h6" />
          </svg>
          Job reports
        </h3>
        <span className="rounded bg-neutral-200 px-2 py-0.5 text-[11px] font-semibold text-neutral-800">
          {buildingCount > 1 ? `All ${buildingCount} buildings` : 'All buildings'}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        {summary.kind === 'contact' ? (
          <div className="flex items-center gap-3 rounded-md border border-neutral-300 bg-neutral-100 p-3">
            <span aria-hidden="true" className="grid h-9 w-9 flex-none place-items-center rounded-full bg-teal text-[12px] font-bold text-white">
              {contactInitials(summary.contact.name)}
            </span>
            <div className="min-w-0">
              <div className="font-semibold text-ink">{summary.contact.name}</div>
              <div className="text-[13px] text-neutral-600">
                {summary.contact.email ?? 'No email address: add one before sending reports to this contact.'}
                {summary.via === 'only_contact' ? ' · the only operational contact' : ' · main contact'}
              </div>
            </div>
          </div>
        ) : (
          <div role="status" className="rounded-md border border-due bg-due/10 p-3 text-[13px] text-due-fg">
            {REPORT_DEFAULT_PROBLEM[summary.why]}
          </div>
        )}
        <p className="text-[12px] text-neutral-600">
          Always the client&apos;s main contact (also shown in the jobs grid); it applies to {everywhere}. Accounts-only contacts are never
          the default. You can still choose someone else for a single report in Ready for client.
        </p>

        {summary.kind === 'contact' && !changing && (
          <div>
            <button
              type="button"
              onClick={() => setChanging(true)}
              className="h-[34px] cursor-pointer rounded-md border border-neutral-300 bg-white px-3 text-[13px] font-semibold text-teal-700 hover:bg-neutral-100"
            >
              Change main contact
            </button>
          </div>
        )}

        {showPicker && eligible.length > 0 && (
          <>
            <label className="flex flex-col gap-1 text-[13px] font-semibold text-ink">
              {summary.kind === 'contact' ? 'New main contact' : 'Set the main contact'}
              <select
                value={pickedId}
                onChange={(e) => setPickedId(e.target.value)}
                disabled={saveMutation.isPending}
                className="h-10 rounded-md border border-neutral-300 bg-white px-2.5 text-[14px] font-normal text-ink outline-none focus:border-teal"
              >
                <option value="">Choose a contact…</option>
                {eligible.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.isPrimary}>
                    {c.name}
                    {c.email ? ` — ${c.email}` : ' — no email'}
                    {c.isPrimary ? ' · main contact now' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => pickedId && saveMutation.mutate(pickedId)}
                disabled={!pickedId || saveMutation.isPending}
                className="h-[34px] cursor-pointer rounded-md bg-teal px-3.5 text-[13px] font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save main contact'}
              </button>
              {changing && (
                <button
                  type="button"
                  onClick={() => {
                    setChanging(false);
                    setPickedId('');
                    setError(null);
                  }}
                  disabled={saveMutation.isPending}
                  className="h-[34px] cursor-pointer rounded-md border border-neutral-300 bg-white px-3 text-[13px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
        {showPicker && eligible.length === 0 && contacts.length > 0 && (
          <div className="text-[12px] text-neutral-500">Add an operational (not accounts-only) contact, above, to set a default.</div>
        )}
        {error && (
          <div role="alert" className="text-[13px] text-missed-fg">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
