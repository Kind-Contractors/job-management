// Fictional mock data only — no real Kind Contractors client information.
// Adapted from the approved Claude Design canvas's own demo dataset
// ("Kind Contractors Manager.dc.html") for continuity between the approved
// design and this implementation, restructured into separate
// Client/Building/Job records instead of flat rows — see CLAUDE.md section 5.
//
// This is an isolated mock layer standing in for the real data source. It
// can be swapped for real Supabase queries later (once visits/reports
// schema exists) without changing the components that consume JobRow[].

import type { Building, Client, Division, Frequency, Job, JobRow, JobStatus } from '../domain/types';

export const clients: Client[] = [
  { id: 'AE', companyName: 'Archery Estates', invoiceAddress: '3rd Floor, 40 Bermondsey St, London SE1 3UD' },
  { id: 'AT', companyName: 'Atlas Property', invoiceAddress: 'Unit 5 Coppergate, Watford WD18 8PH' },
  { id: 'WE', companyName: 'Warwick Estates', invoiceAddress: '12 Verulam Road, St Albans AL3 4DA' },
  { id: 'AL', companyName: 'Alba Management', invoiceAddress: '88 West Regent St, Glasgow G2 2QD' },
  { id: 'NB', companyName: 'Northbank Living', invoiceAddress: '2 Quayside House, Reading RG1 8DN' },
  { id: 'CV', companyName: 'Cavendish Block Mgmt', invoiceAddress: '19 Portland Crescent, London W1B 1PN' },
];

interface RawJobRow {
  jobId: string;
  clientId: string;
  building: string;
  street: string;
  postcode: string;
  jobSummary: string;
  division: Division;
  frequency: Frequency;
  pricePerVisit: number;
  yearlyValue: number;
  nextDueLabel: string;
  status: JobStatus;
  team: string;
}

const RAW: RawJobRow[] = [
  { jobId: 'GEN-041', clientId: 'AE', building: 'Marlowe Wharf', street: '42 Shad Thames', postcode: 'SE1 2YG', jobSummary: 'General clean', division: 'General', frequency: 'Monthly', pricePerVisit: 142, yearlyValue: 1704, nextDueLabel: 'Wed 27 Aug', status: 'booked', team: 'Team 2' },
  { jobId: 'SPC-118', clientId: 'AE', building: 'Marlowe Wharf', street: '42 Shad Thames', postcode: 'SE1 2YG', jobSummary: 'Window clean — externals', division: 'Specialist', frequency: 'Quarterly', pricePerVisit: 380, yearlyValue: 1520, nextDueLabel: 'Aug 2026 · no date', status: 'needs_booking', team: '—' },
  { jobId: 'SPC-119', clientId: 'AE', building: 'Marlowe Wharf', street: '42 Shad Thames', postcode: 'SE1 2YG', jobSummary: 'Gutter clear', division: 'Specialist', frequency: 'Annual', pricePerVisit: 460, yearlyValue: 460, nextDueLabel: 'Nov 2026', status: 'not_due', team: '—' },
  { jobId: 'GEN-018', clientId: 'AE', building: 'Kingsmere Court', street: '2 Sheen Lane', postcode: 'SW14 8LP', jobSummary: 'General clean', division: 'General', frequency: 'Fortnightly', pricePerVisit: 96, yearlyValue: 2496, nextDueLabel: 'Thu 28 Aug', status: 'booked', team: 'Team 2' },
  { jobId: 'SPC-042', clientId: 'AE', building: 'Kingsmere Court', street: '2 Sheen Lane', postcode: 'SW14 8LP', jobSummary: 'Window clean — communal', division: 'Specialist', frequency: 'Monthly', pricePerVisit: 120, yearlyValue: 1440, nextDueLabel: 'Today', status: 'review', team: 'Team 2' },
  { jobId: 'GEN-019', clientId: 'AE', building: 'Kingsmere Court', street: '2 Sheen Lane', postcode: 'SW14 8LP', jobSummary: 'Bin store rota', division: 'General', frequency: 'Weekly', pricePerVisit: 52, yearlyValue: 2704, nextDueLabel: 'Wed 26 Aug', status: 'booked', team: 'Team 2' },
  { jobId: 'GEN-007', clientId: 'AT', building: 'Ashdown House', street: '9 Fitzroy Road', postcode: 'NW1 8TX', jobSummary: 'General clean', division: 'General', frequency: 'Weekly', pricePerVisit: 88, yearlyValue: 4576, nextDueLabel: 'Today', status: 'review', team: 'Team 2' },
  { jobId: 'GEN-008', clientId: 'AT', building: 'Ashdown House', street: '9 Fitzroy Road', postcode: 'NW1 8TX', jobSummary: 'Bin store deep clean', division: 'General', frequency: 'Quarterly', pricePerVisit: 310, yearlyValue: 1240, nextDueLabel: 'Oct 2026', status: 'not_due', team: '—' },
  { jobId: 'GEN-031', clientId: 'AT', building: 'Pemberton Gate', street: '7 Coppergate Row', postcode: 'WD18 7QN', jobSummary: 'General clean + litter pick', division: 'General', frequency: 'Weekly', pricePerVisit: 124, yearlyValue: 6448, nextDueLabel: 'Wed 26 Aug', status: 'booked', team: 'Team 1' },
  { jobId: 'SPC-077', clientId: 'AT', building: 'Pemberton Gate', street: '7 Coppergate Row', postcode: 'WD18 7QN', jobSummary: 'Jet wash — forecourt', division: 'Specialist', frequency: 'Biannual', pricePerVisit: 540, yearlyValue: 1080, nextDueLabel: 'Sep 2026 · no date', status: 'needs_booking', team: '—' },
  { jobId: 'GEN-044', clientId: 'AT', building: 'Halden Rise', street: '31 Sandpit Lane', postcode: 'AL4 9BP', jobSummary: 'General clean', division: 'General', frequency: 'Fortnightly', pricePerVisit: 102, yearlyValue: 2652, nextDueLabel: 'Fri 21 Aug', status: 'missed', team: 'Team 1' },
  { jobId: 'SPC-081', clientId: 'AT', building: 'Halden Rise', street: '31 Sandpit Lane', postcode: 'AL4 9BP', jobSummary: 'Gutter clear', division: 'Specialist', frequency: 'Annual', pricePerVisit: 395, yearlyValue: 395, nextDueLabel: 'Feb 2027', status: 'not_due', team: '—' },
  { jobId: 'GEN-052', clientId: 'WE', building: 'Beaumont Place', street: '18 Cranmer Road', postcode: 'AL1 3RQ', jobSummary: 'General clean', division: 'General', frequency: 'Monthly', pricePerVisit: 136, yearlyValue: 1632, nextDueLabel: 'Today', status: 'onsite', team: 'Team 1' },
  { jobId: 'SPC-090', clientId: 'WE', building: 'Beaumont Place', street: '18 Cranmer Road', postcode: 'AL1 3RQ', jobSummary: 'Gutter clear', division: 'Specialist', frequency: 'Annual', pricePerVisit: 395, yearlyValue: 395, nextDueLabel: 'Today', status: 'review', team: 'J. Brody' },
  { jobId: 'SPC-091', clientId: 'WE', building: 'Sable Court', street: '4 Folly Lane', postcode: 'AL3 5NB', jobSummary: 'Window clean — externals', division: 'Specialist', frequency: 'Ask / ad-hoc', pricePerVisit: 425, yearlyValue: 0, nextDueLabel: 'On request', status: 'ask', team: '—' },
  { jobId: 'GEN-060', clientId: 'WE', building: 'Sable Court', street: '4 Folly Lane', postcode: 'AL3 5NB', jobSummary: 'General clean', division: 'General', frequency: 'Monthly', pricePerVisit: 118, yearlyValue: 1416, nextDueLabel: 'Mon 31 Aug', status: 'booked', team: 'Team 3' },
  { jobId: 'GEN-066', clientId: 'AL', building: 'Wren House', street: '64 Alma Road', postcode: 'SL4 3HB', jobSummary: 'General clean', division: 'General', frequency: 'Fortnightly', pricePerVisit: 108, yearlyValue: 2808, nextDueLabel: 'Today', status: 'review', team: 'Rob Deakin' },
  { jobId: 'SPC-101', clientId: 'AL', building: 'Wren House', street: '64 Alma Road', postcode: 'SL4 3HB', jobSummary: 'Window clean — communal', division: 'Specialist', frequency: 'Quarterly', pricePerVisit: 240, yearlyValue: 960, nextDueLabel: 'Sep 2026 · no date', status: 'needs_booking', team: '—' },
  { jobId: 'GEN-071', clientId: 'AL', building: 'Fenwick Mews', street: '12 Peascod Yard', postcode: 'SL4 1QT', jobSummary: 'Litter pick', division: 'General', frequency: 'Weekly', pricePerVisit: 64, yearlyValue: 3328, nextDueLabel: 'Wed 26 Aug', status: 'booked', team: 'Team 3' },
  { jobId: 'GEN-080', clientId: 'NB', building: 'Tolliver Yard', street: '5 Kennet Side', postcode: 'RG1 4XP', jobSummary: 'General clean', division: 'General', frequency: 'Weekly', pricePerVisit: 96, yearlyValue: 4992, nextDueLabel: 'Today', status: 'review', team: 'Team 3' },
  { jobId: 'SPC-112', clientId: 'NB', building: 'Tolliver Yard', street: '5 Kennet Side', postcode: 'RG1 4XP', jobSummary: 'Jet wash — bin store', division: 'Specialist', frequency: 'Quarterly', pricePerVisit: 285, yearlyValue: 1140, nextDueLabel: 'Oct 2026', status: 'not_due', team: '—' },
  { jobId: 'GEN-084', clientId: 'NB', building: 'Quay House', street: '2 Kennet Side', postcode: 'RG1 8AA', jobSummary: 'General clean', division: 'General', frequency: 'Monthly', pricePerVisit: 152, yearlyValue: 1824, nextDueLabel: 'Tue 1 Sep', status: 'booked', team: 'Team 3' },
  { jobId: 'GEN-092', clientId: 'CV', building: 'Cavendish Row', street: '19 Portland Crescent', postcode: 'W1B 2AB', jobSummary: 'General clean', division: 'General', frequency: 'Weekly', pricePerVisit: 168, yearlyValue: 8736, nextDueLabel: 'Wed 26 Aug', status: 'booked', team: 'Team 1' },
  { jobId: 'SPC-124', clientId: 'CV', building: 'Cavendish Row', street: '19 Portland Crescent', postcode: 'W1B 2AB', jobSummary: 'Window clean — externals', division: 'Specialist', frequency: 'Quarterly', pricePerVisit: 620, yearlyValue: 2480, nextDueLabel: 'Aug 2026 · no date', status: 'needs_booking', team: '—' },
  { jobId: 'GEN-095', clientId: 'CV', building: 'Halkin Mews', street: '8 Halkin Place', postcode: 'W1J 7RS', jobSummary: 'General clean', division: 'General', frequency: 'Fortnightly', pricePerVisit: 88, yearlyValue: 2288, nextDueLabel: 'Fri 28 Aug', status: 'booked', team: 'Team 1' },
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Human-readable recurrence per job — see CLAUDE.md section 6 (scheduling rules). */
const SCHEDULE_PATTERNS: Record<string, string> = {
  'GEN-041': 'Monthly · last Thu',
  'SPC-118': 'Quarterly · 3rd Wed',
  'SPC-119': 'Annual · Nov',
  'GEN-018': 'Fortnightly · Thu',
  'SPC-042': 'Monthly · 4th Tue',
  'GEN-019': 'Weekly · Wed',
  'GEN-007': 'Weekly · Tue',
  'GEN-008': 'Quarterly · month only',
  'GEN-031': 'Weekly · Wed',
  'SPC-077': 'Biannual · Apr & Sep',
  'GEN-044': 'Fortnightly · Fri',
  'SPC-081': 'Annual · Feb',
  'GEN-052': 'Monthly · 15th',
  'SPC-090': 'Annual · Feb',
  'SPC-091': 'On request',
  'GEN-060': 'Monthly · last Mon',
  'GEN-066': 'Fortnightly · Thu',
  'SPC-101': 'Quarterly · month only',
  'GEN-071': 'Weekly · Wed',
  'GEN-080': 'Weekly · Tue',
  'SPC-112': 'Quarterly · 2nd Fri',
  'GEN-084': 'Monthly · 1st Tue',
  'GEN-092': 'Weekly · Wed',
  'SPC-124': 'Quarterly · 3rd Wed',
  'GEN-095': 'Fortnightly · Fri',
};

/** Key safe / keyholder / parking, redacted by default in the UI — see CLAUDE.md section 8. */
const BUILDING_ACCESS_NOTES: Record<string, string> = {
  'Marlowe Wharf':
    'Key safe inside the bin store, right-hand wall — 4 9 2 7. Fob opens the side gate, not the main door. Keyholder: D. Whitcombe (concierge) 07700 900412. Two visitor bays behind the gate, permit from the glovebox must be displayed.',
  'Kingsmere Court':
    'Key safe on the wall left of the bin store — 1 0 8 3. Do not use the residents’ front entrance before 09:00. Keyholder: M. Sowande (managing agent) 07700 900188. No loading bay — use the residents’ car park, bay 14, marked CONTRACTOR.',
  'Ashdown House':
    'Trade entrance to the rear, code on the keypad — 7 7 1 4. No key safe. Keyholder: caretaker on site weekdays until 14:00. Single bay at the rear, first come.',
};
const DEFAULT_ACCESS_NOTE = 'Access details not yet recorded for this building.';

export const buildings: Building[] = Array.from(
  new Map(RAW.map((r) => [r.building, r])).values(),
).map((r) => ({
  id: slugify(r.building),
  clientId: r.clientId,
  name: r.building,
  street: r.street,
  postcode: r.postcode,
  internalAccessNote: BUILDING_ACCESS_NOTES[r.building] ?? DEFAULT_ACCESS_NOTE,
}));

export const jobs: Job[] = RAW.map((r) => ({
  id: r.jobId,
  buildingId: slugify(r.building),
  jobSummary: r.jobSummary,
  division: r.division,
  frequency: r.frequency,
  pricePerVisit: r.pricePerVisit,
  yearlyValue: r.yearlyValue,
  nextDueLabel: r.nextDueLabel,
  status: r.status,
  team: r.team,
  schedulePattern: SCHEDULE_PATTERNS[r.jobId] ?? r.frequency,
}));

export function denormalizeJobRows(): JobRow[] {
  const buildingById = new Map(buildings.map((b) => [b.id, b]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  return jobs.map((job) => {
    const building = buildingById.get(job.buildingId)!;
    const client = clientById.get(building.clientId)!;
    return {
      ...job,
      buildingName: building.name,
      street: building.street,
      postcode: building.postcode,
      buildingInternalAccessNote: building.internalAccessNote,
      clientId: client.id,
      clientName: client.companyName,
      clientInvoiceAddress: client.invoiceAddress,
    };
  });
}
