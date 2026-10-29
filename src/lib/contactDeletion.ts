import type { ContactDeletionCheck } from '../repository/contactsRepository';

/**
 * What the delete dialog says, worked out from a fresh ContactDeletionCheck. Pure, so every rule is tested directly.
 *   - Blocked (each with how to resolve it): the client's main contact; the default invoice recipient of any of the client's
 *     buildings; a contact that has been sent job reports (kept for the record - this one cannot be resolved).
 *   - Otherwise a confirmation: the contact is shared by all the client's buildings and is removed from all of them; past invoices
 *     and reports are not changed; a Xero-linked contact loses only the app's link (the Xero contact is not touched).
 */
export type ContactDeletionBlocker = 'main_contact' | 'invoice_default' | 'report_history';

export interface ContactDeletionPlan {
  blockers: { kind: ContactDeletionBlocker; text: string }[];
  /** The confirmation lines, when nothing blocks the delete. */
  confirm: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function contactDeletionPlan(check: ContactDeletionCheck, clientName: string): ContactDeletionPlan {
  const name = check.name;
  const blockers: ContactDeletionPlan['blockers'] = [];
  if (check.isPrimary) {
    blockers.push({
      kind: 'main_contact',
      text: `${name} is the main contact (the default recipient of job reports, and the contact shown in the jobs grid). Choose another main contact first under "Job reports · default recipient", or untick "Main contact" in Edit.`,
    });
  }
  if (check.defaultForBuildings.length > 0) {
    const names = check.defaultForBuildings.map((b) => b.name).join(', ');
    blockers.push({
      kind: 'invoice_default',
      text: `${name} is the default invoice recipient for ${plural(check.defaultForBuildings.length, 'building', 'buildings')}: ${names}. Change or clear that default first, under "Invoices · default recipient" on each of those buildings' Contacts & Defaults tab.`,
    });
  }
  if (check.reportSends > 0) {
    blockers.push({
      kind: 'report_history',
      text: `${name} has been sent ${plural(check.reportSends, 'job report', 'job reports')}. The contact is kept so the record of who those reports went to stays complete, so it cannot be deleted.`,
    });
  }

  const client = clientName || 'this client';
  const buildings = check.buildingCount > 1 ? `all ${check.buildingCount} of its buildings` : check.buildingCount === 1 ? 'its building' : 'its buildings';
  const confirm = [
    `Contacts belong to ${client} and are shared by ${buildings}: ${name} will be removed from ${check.buildingCount > 1 ? `all ${check.buildingCount}` : 'it'}.`,
    'Past invoices and job reports are not changed.',
    ...(check.linkedToXero
      ? [`${name} is linked to the Xero contact${check.xeroContactName ? ` "${check.xeroContactName}"` : ''}. Only the link in this app is removed; the Xero contact itself is not changed.`]
      : []),
  ];
  return { blockers, confirm };
}
