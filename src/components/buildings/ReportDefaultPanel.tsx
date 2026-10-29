import { useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Contact } from '../../domain/types';
import { updateContact } from '../../repository/contactsRepository';
import { REPORT_DEFAULT_PROBLEM, reportDefaultSummary } from '../../lib/contactDisplay';

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
    <div data-testid="report-default" className="border border-neutral-300 bg-white">
      <div className="border-b border-neutral-300 px-4 py-2.5 font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
        Job reports · default recipient
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 text-[12.5px]">
        <div className="text-[11px] text-neutral-600">
          The client&apos;s main contact. It is also the contact shown in the jobs grid, and it applies to {everywhere}. Accounts-only
          contacts are never the default; any contact can still be chosen for a single report in Ready for client.
        </div>
        {summary.kind === 'contact' ? (
          <div className="border border-neutral-300 bg-neutral-100 p-2.5">
            <div className="font-semibold text-ink">{summary.contact.name}</div>
            <div className="text-[11.5px] text-neutral-600">
              {summary.contact.email ?? 'No email address: add one before sending reports to this contact.'}
              {summary.via === 'only_contact' ? ' · the only operational contact' : ' · main contact'}
            </div>
          </div>
        ) : (
          <div role="status" className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg">
            {REPORT_DEFAULT_PROBLEM[summary.why]}
          </div>
        )}

        {summary.kind === 'contact' && !changing && (
          <div>
            <button
              type="button"
              onClick={() => setChanging(true)}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11.5px] font-semibold text-teal-700 hover:bg-neutral-100"
            >
              Change main contact
            </button>
          </div>
        )}

        {showPicker && eligible.length > 0 && (
          <>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              {summary.kind === 'contact' ? 'New main contact' : 'Set the main contact'}
              <select
                value={pickedId}
                onChange={(e) => setPickedId(e.target.value)}
                disabled={saveMutation.isPending}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
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
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => pickedId && saveMutation.mutate(pickedId)}
                disabled={!pickedId || saveMutation.isPending}
                className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
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
                  className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
        {showPicker && eligible.length === 0 && contacts.length > 0 && (
          <div className="text-[11px] text-neutral-500">Add an operational (not accounts-only) contact, above, to set a default.</div>
        )}
        {error && (
          <div role="alert" className="text-[11.5px] text-missed-fg">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
