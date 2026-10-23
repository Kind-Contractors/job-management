import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuildingRow, JobRow } from '../../domain/types';
import { listClients } from '../../repository/clientsRepository';
import { changeBuildingClient, changeBuildingClientToNewClient } from '../../repository/buildingClientRepository';
import { createContactForClient } from '../../repository/contactsRepository';
import { clientChangeImpact, clientChoiceProblem, newClientNameProblem, tidyCompanyName } from '../../lib/buildingClientChange';

type Mode = 'existing' | 'new';

interface ChangeBuildingClientPanelProps {
  building: BuildingRow;
  /** This building's jobs, active and closed: used only to explain what the change affects. */
  buildingJobs: JobRow[];
  onDone: (message: string) => void;
  onCancel: () => void;
  /** Starting state. Only tests pass these; the app always opens on "Existing client" with nothing chosen. */
  initialChosenClientId?: string | null;
  initialConfirming?: boolean;
  initialMode?: Mode;
  initialCompanyName?: string;
}

/**
 * Changes which client (management company) a building belongs to: an EXISTING client (the building creator's search), or a NEW
 * one created in the same step (the building creator's "New client": a company name, and optionally a first contact). Check what
 * changes, confirm. The database does the change in one call (change_building_client / change_building_client_to_new_client):
 * it refuses while invoices for this building are unfinished, refuses a new client whose name already exists, clears a default
 * invoice recipient that belongs to the old client, and records the change; if it refuses, no client is created. Contacts and
 * their Xero links are never moved or copied.
 */
export default function ChangeBuildingClientPanel({
  building,
  buildingJobs,
  onDone,
  onCancel,
  initialChosenClientId = null,
  initialConfirming = false,
  initialMode = 'existing',
  initialCompanyName = '',
}: ChangeBuildingClientPanelProps) {
  const queryClient = useQueryClient();
  const { data: clients = [], isLoading, isError } = useQuery({ queryKey: ['clients'], queryFn: listClients });
  const [query, setQuery] = useState('');
  const [chosenId, setChosenId] = useState<string | null>(initialChosenClientId);
  const [confirming, setConfirming] = useState(initialConfirming);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [companyName, setCompanyName] = useState(initialCompanyName);
  // The optional first contact of a NEW client, as in the building creator: added after the change, and never undoes it.
  const [addContact, setAddContact] = useState(false);
  const [contactForm, setContactForm] = useState({ name: '', email: '', phoneNumber: '' });

  const chosen = clients.find((c) => c.id === chosenId) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return clients.filter((c) => c.id !== building.clientId && c.companyName.toLowerCase().includes(q)).slice(0, 20);
  }, [clients, query, building.clientId]);
  const impact = clientChangeImpact(buildingJobs);
  const targetName = mode === 'existing' ? (chosen?.companyName ?? null) : tidyCompanyName(companyName) || null;
  // A new name is checked against the client list (so a duplicate is caught before confirming); the database checks again.
  const problem =
    mode === 'existing'
      ? clientChoiceProblem(building.clientId, chosenId, clients.map((c) => c.id))
      : isLoading || isError
        ? 'The client list must load first, so the name can be checked for duplicates.'
        : newClientNameProblem(companyName, clients);
  const contactName = addContact ? contactForm.name.trim() : '';

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  const changeMutation = useMutation({
    mutationFn: async (): Promise<{ name: string; defaultRecipientCleared: boolean; contactError: string | null }> => {
      if (mode === 'existing') {
        const r = await changeBuildingClient({ buildingId: building.id, newClientId: chosenId!, expectedClientId: building.clientId });
        return { name: chosen?.companyName ?? 'the new client', defaultRecipientCleared: r.defaultRecipientCleared, contactError: null };
      }
      const r = await changeBuildingClientToNewClient({ buildingId: building.id, companyName: tidyCompanyName(companyName), expectedClientId: building.clientId });
      let contactError: string | null = null;
      if (contactName) {
        try {
          // The new client's first contact, primary as in the building creator. The client change already stands.
          await createContactForClient(r.newClientId, {
            name: contactName,
            email: contactForm.email.trim() || null,
            phoneNumber: contactForm.phoneNumber.trim() || null,
            isPrimary: true,
          });
        } catch (err) {
          contactError = err instanceof Error ? err.message : 'Failed to save the contact.';
        }
      }
      return { name: r.newClientName, defaultRecipientCleared: r.defaultRecipientCleared, contactError };
    },
    onSuccess: ({ name, defaultRecipientCleared, contactError }) => {
      // The client is read through the building everywhere: buildings, every job at it (active and closed), its contacts list,
      // its History timeline and its management history all change - and a new client joins the client list.
      for (const key of [['buildingRows'], ['jobRows'], ['historicalJobRows'], ['contacts'], ['clients'], ['buildingHistory', building.id], ['buildingClientHistory', building.id]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      onDone(
        `Client changed to ${name}.` +
          (defaultRecipientCleared ? " The default invoice recipient was cleared: choose one of the new client's contacts." : '') +
          (contactError ? ` The contact could not be saved (${contactError}); add it from the job's Contact column.` : ''),
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The client could not be changed.'),
  });

  return (
    <div data-testid="change-client" className="max-w-[640px] border border-neutral-300 bg-white p-3">
      <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Change client</div>
      <div className="mt-1 text-[12.5px] text-ink">
        Current client: <span className="font-semibold">{building.clientName || '—'}</span>
      </div>

      {!confirming && (
        <div className="segmented mt-2 flex border border-neutral-300">
          <button
            type="button"
            onClick={() => switchMode('existing')}
            className={`flex-1 cursor-pointer py-1.5 text-xs ${mode === 'existing' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
          >
            Existing client
          </button>
          <button
            type="button"
            onClick={() => switchMode('new')}
            className={`flex-1 cursor-pointer border-l border-neutral-300 py-1.5 text-xs ${mode === 'new' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
          >
            Create new client
          </button>
        </div>
      )}

      {!confirming && mode === 'new' && (
        <div className="mt-2 flex flex-col gap-1.5 text-[11px] text-neutral-600">
          <label className="flex flex-col gap-1">
            New client&apos;s company name
            <input
              aria-label="New client's company name"
              value={companyName}
              onChange={(e) => {
                setCompanyName(e.target.value);
                setError(null);
              }}
              maxLength={200}
              autoComplete="off"
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          {companyName.trim() !== '' && problem && <div className="text-[11.5px] text-missed-fg">{problem}</div>}
          {!addContact ? (
            <button
              type="button"
              onClick={() => setAddContact(true)}
              className="cursor-pointer self-start border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100"
            >
              + Add a contact
            </button>
          ) : (
            <div className="flex flex-col gap-1.5">
              <input
                value={contactForm.name}
                onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                placeholder="Name"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              <input
                type="email"
                value={contactForm.email}
                onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                placeholder="Email"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              <input
                value={contactForm.phoneNumber}
                onChange={(e) => setContactForm({ ...contactForm, phoneNumber: e.target.value })}
                placeholder="Phone"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              <button
                type="button"
                onClick={() => {
                  setAddContact(false);
                  setContactForm({ name: '', email: '', phoneNumber: '' });
                }}
                className="cursor-pointer self-start text-[11px] text-neutral-500 hover:underline"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      )}

      {!confirming && mode === 'existing' && (
        <div className="mt-2 flex flex-col gap-1 text-[11px] text-neutral-600">
          New client
          {chosen ? (
            <div className="flex items-center gap-2 border border-teal-700 bg-teal-100 px-2 py-1 text-[12.5px] text-ink">
              <span className="font-semibold">{targetName}</span>
              <button type="button" onClick={() => setChosenId(null)} className="ml-auto cursor-pointer text-[11px] text-teal-700 hover:underline">
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                aria-label="Search for the new client"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={isLoading ? 'Loading clients…' : 'Search clients…'}
                autoComplete="off"
                disabled={isLoading || isError}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100"
              />
              {isError && <div className="text-[11.5px] text-missed-fg">Couldn&apos;t load the client list.</div>}
              {matches.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-t-0 border-neutral-300">
                  {matches.map((c) => (
                    <div
                      key={c.id}
                      onMouseDown={(e) => {
                        // onMouseDown, as in the building creator's identical list: a click would lose the input's focus first.
                        e.preventDefault();
                        setChosenId(c.id);
                        setQuery('');
                        setError(null);
                      }}
                      className="cursor-pointer border-b border-divider px-2 py-1.5 text-[12px] last:border-b-0 hover:bg-neutral-100"
                    >
                      {c.companyName}
                    </div>
                  ))}
                </div>
              )}
              {query.trim() !== '' && matches.length === 0 && !isLoading && (
                <div className="text-[11.5px] text-neutral-500">No other client matches “{query.trim()}”. Add the client first, then change it here.</div>
              )}
            </>
          )}
        </div>
      )}

      {confirming && targetName && (
        <div data-testid="change-client-confirm" className="mt-2 border-t border-divider pt-2">
          <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Confirm</div>
          <p className="mt-1 text-[12.5px] text-ink">
            Change this building&apos;s client from <span className="font-semibold">{building.clientName || '—'}</span> to{' '}
            <span className="font-semibold">{targetName}</span>?
          </p>
          <ul className="mt-1.5 list-disc pl-4 text-[11.5px] text-neutral-700">
            {mode === 'new' && (
              <li>
                A new client, <span className="font-semibold">{targetName}</span>, will be created
                {contactName ? `, with ${contactName} as its first contact` : ' with no contacts yet: add one before invoicing or sending reports'}.
              </li>
            )}
            <li>
              All {impact.jobs} {impact.jobs === 1 ? 'job' : 'jobs'} at this building, including past visits and reports, will show{' '}
              {targetName} as the client. Invoices already in Xero are not changed.
            </li>
            <li>
              {building.clientName || 'The current client'}&apos;s contacts (and their Xero links) stay with {building.clientName || 'that client'}. Only{' '}
              {targetName}&apos;s contacts can receive this building&apos;s invoices and reports from now on.
            </li>
            {building.defaultRecipient && (
              <li className="text-due-fg">The building&apos;s default invoice recipient belongs to the current client, so it will be cleared.</li>
            )}
            {impact.notYetInvoiced > 0 && (
              <li className="text-due-fg">
                {impact.notYetInvoiced} completed {impact.notYetInvoiced === 1 ? 'visit is' : 'visits are'} not invoiced yet and would be invoiced to{' '}
                {targetName}. Invoice {impact.notYetInvoiced === 1 ? 'it' : 'them'} first if {building.clientName || 'the current client'} should
                pay.
              </li>
            )}
            {impact.reportsAwaitingClient > 0 && (
              <li className="text-due-fg">
                {impact.reportsAwaitingClient} {impact.reportsAwaitingClient === 1 ? 'report is' : 'reports are'} not yet completed and would go to{' '}
                {targetName}&apos;s contacts.
              </li>
            )}
            <li>The building&apos;s address, site instructions, access details and invoice details are kept as they are: update the invoice details if they name the old company.</li>
          </ul>
          {impact.unfinishedInvoices > 0 && (
            <div role="alert" className="mt-1.5 border border-missed bg-missed/10 p-2 text-[11.5px] text-missed-fg">
              {impact.unfinishedInvoices} {impact.unfinishedInvoices === 1 ? 'invoice is' : 'invoices are'} not finished yet (draft, sending or failed).
              Send or discard {impact.unfinishedInvoices === 1 ? 'it' : 'them'} first, so nothing is billed to the wrong client.
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="mt-2 text-[11.5px] text-missed-fg">
          {error}
        </div>
      )}

      <div className="mt-2.5 flex gap-1.5">
        {!confirming ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            disabled={problem !== null}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Review change
          </button>
        ) : (
          <button
            type="button"
            onClick={() => changeMutation.mutate()}
            disabled={changeMutation.isPending || problem !== null || impact.unfinishedInvoices > 0}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {changeMutation.isPending ? 'Changing…' : 'Confirm change'}
          </button>
        )}
        {confirming && (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={changeMutation.isPending}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:opacity-60"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={changeMutation.isPending}
          className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
