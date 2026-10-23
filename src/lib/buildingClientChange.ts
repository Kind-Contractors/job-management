// What changing a building's client means, worked out before the manager confirms, and the readable management history. Kept
// free of React so the rules can be tested directly. The database function change_building_client is the authority: it refuses
// (and changes nothing) for anything this says is blocked.
//
// A building's client is the only stored link between a building and a client: its jobs, visits, reports and invoices reach
// their client THROUGH the building. So after a change, every job at the building - past ones included - shows the new client,
// and work not yet invoiced or reported goes to the new client. Nothing is copied or moved: contacts (and their Xero links) stay
// with the client they belong to.

import type { JobRow } from '../domain/types';
import type { BuildingClientChange } from '../repository/buildingClientRepository';
import { hasOpenAccountsWork } from './queueJobs';
import { isReportReadyForClient } from './statusPresentation';

const UNFINISHED_INVOICE = new Set(['draft', 'sending', 'failed']);

export interface ClientChangeImpact {
  /** Invoices being prepared or sent (draft / sending / failed): the change is refused until they are sent or discarded. */
  unfinishedInvoices: number;
  /** Approved visits not yet invoiced in Xero (and not already counted above): they would be invoiced to the NEW client. */
  notYetInvoiced: number;
  /** Approved reports not yet marked Completed: they would be sent to the NEW client's contacts. */
  reportsAwaitingClient: number;
  /** Jobs at this building (active and closed): all will show the new client, including their past visits and reports. */
  jobs: number;
}

/** The impact of changing the client of the building whose jobs are `buildingJobs` (active and historical, this building only). */
export function clientChangeImpact(buildingJobs: JobRow[]): ClientChangeImpact {
  let unfinishedInvoices = 0;
  let notYetInvoiced = 0;
  let reportsAwaitingClient = 0;
  const seen = new Set<string>();
  for (const job of buildingJobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    for (const visit of job.visits) {
      const unfinished = !!visit.invoiceId && UNFINISHED_INVOICE.has(visit.invoiceStatus ?? '');
      if (unfinished) unfinishedInvoices += 1;
      else if (hasOpenAccountsWork(visit)) notYetInvoiced += 1;
      if (isReportReadyForClient(visit)) reportsAwaitingClient += 1;
    }
  }
  return { unfinishedInvoices, notYetInvoiced, reportsAwaitingClient, jobs: seen.size };
}

/** Why a chosen client cannot be confirmed, or null when it can. */
export function clientChoiceProblem(currentClientId: string, chosenClientId: string | null, knownClientIds: string[]): string | null {
  if (!chosenClientId) return 'Choose the new client.';
  if (chosenClientId === currentClientId) return 'This building already belongs to that client. Choose a different client.';
  if (!knownClientIds.includes(chosenClientId)) return 'That client is not in the client list. Choose an existing client.';
  return null;
}

/** A company name as stored: trimmed, runs of spaces collapsed (the database tidies it the same way). */
export function tidyCompanyName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Why a NEW client's company name cannot be used, or null when it can. The same rules as the database: not blank, at most 200
 * characters, and not a name an existing client already has (ignoring case and spacing) - choose that client instead.
 */
export function newClientNameProblem(name: string, existing: { companyName: string }[]): string | null {
  const tidy = tidyCompanyName(name);
  if (!tidy) return "Enter the new client's company name.";
  if (tidy.length > 200) return 'The company name is too long (200 characters at most).';
  const clash = existing.find((c) => tidyCompanyName(c.companyName).toLowerCase() === tidy.toLowerCase());
  if (clash) return `A client named "${clash.companyName}" already exists. Choose it under "Existing client" instead of creating a duplicate.`;
  return null;
}

export interface ManagementPeriod {
  clientName: string;
  /** When this client took over, as recorded by the app; null when that predates the record (never guessed). */
  from: string | null;
  /** When this client was replaced; null for the current client. */
  until: string | null;
  /** Who recorded the change that ENDED this period (previous clients only). */
  changedBy: string | null;
}

/**
 * The current client and the previous ones, newest first, built only from recorded changes. A period whose start was never
 * recorded has `from: null` ("before records began"); no date is invented.
 */
export function managementHistory(currentClientName: string, changes: BuildingClientChange[]): { current: ManagementPeriod; previous: ManagementPeriod[] } {
  const ordered = [...changes].sort((a, b) => a.changedAt.localeCompare(b.changedAt) || a.id.localeCompare(b.id));
  const previous: ManagementPeriod[] = ordered.map((c, i) => ({
    clientName: c.previousClientName,
    from: i > 0 ? ordered[i - 1].changedAt : null,
    until: c.changedAt,
    changedBy: c.changedBy,
  }));
  const last = ordered[ordered.length - 1];
  return {
    current: { clientName: currentClientName, from: last ? last.changedAt : null, until: null, changedBy: null },
    previous: previous.reverse(),
  };
}
