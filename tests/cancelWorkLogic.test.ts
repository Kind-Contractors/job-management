// Logic tests for cancelling work: what a cancellation plans (exact visit selection and counts), the end-of-service
// rule for derived demand (Needs booking / Month Matrix), and which jobs and visits the three report queues read.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOpenVisit, planCancelWork } from '../src/lib/cancelWork';
import { deriveVisitState } from '../src/repository/mapJobRow';
import { deriveMonthCellStates } from '../src/lib/monthMatrix';
import { isDemandEndedForMonth } from '../src/lib/scheduleFormat';
import {
  hasOpenAccountsWork,
  isActiveJob,
  isVisitCountedForAccounts,
  isVisitInAccountsQueue,
  isVisitInClientQueue,
  isVisitInReviewQueue,
  mergeQueueJobs,
  queueCounts,
} from '../src/lib/queueJobs';

// ---- fixtures -----------------------------------------------------------------------------------------------------
function visit(id: string, over: Record<string, unknown> = {}): any {
  return {
    id, scheduledDate: '2026-10-20', status: 'booked', technicianId: null, technicianName: null, additionalTechnicians: [], reportHasContributions: false, primaryContribution: 'pending',
    priceCharged: null, completedAt: null, reportId: null, reportReviewStatus: null, sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null,
    invoiceId: null, invoiceStatus: null, ...over,
  };
}
function job(id: string, visits: any[], over: Record<string, unknown> = {}): any {
  return { id, buildingName: `B-${id}`, jobSummary: 'cleaning', lifecycleStatus: 'active', serviceEndsOn: null, schedule: null, visits, ...over };
}

// A recurring job: past work, an overdue booking, today, three future bookings, one undated, one with a report, one with an invoice line, one already cancelled.
const vDone = visit('done', { status: 'completed', scheduledDate: '2026-09-01', priceCharged: 10, completedAt: 'x' });
const vMissed = visit('missed', { status: 'missed', scheduledDate: '2026-09-10' });
const vOverdue = visit('overdue', { scheduledDate: '2026-10-01' });
const v1 = visit('v1', { scheduledDate: '2026-10-20' });
const v2 = visit('v2', { scheduledDate: '2026-11-20', status: 'due' });
const v3 = visit('v3', { scheduledDate: '2026-12-20' });
const vUndated = visit('undated', { scheduledDate: null, status: 'due' });
const vRep = visit('rep', { scheduledDate: '2026-10-25', reportId: 'r1', reportReviewStatus: 'awaiting_review' });
const vInv = visit('inv', { scheduledDate: '2026-11-05', invoiceId: 'i1', invoiceStatus: 'draft' });
const vCancelled = visit('cancelled', { scheduledDate: '2026-10-22', status: 'cancelled' });
const J = job('j', [vDone, vMissed, vOverdue, v1, v2, v3, vUndated, vRep, vInv, vCancelled]);
const ids = (vs: any[]) => vs.map((v) => v.id).sort();

// ---- exact visit selection and counts -------------------------------------------------------------------------------
test('CANCEL THIS VISIT ONLY plans exactly the selected open visit', () => {
  const plan = planCancelWork(J, 'visit', v1);
  assert.deepEqual(ids(plan.willCancel), ['v1']);
  assert.equal(plan.kept.length, 0);
});

test('CANCEL THIS AND FUTURE plans the selected visit, every later open visit and undated ones - never earlier, completed, missed or cancelled', () => {
  const plan = planCancelWork(J, 'this_and_future', v1);
  assert.deepEqual(ids(plan.willCancel), ['undated', 'v1', 'v2', 'v3']);
  assert.deepEqual(plan.kept.map((k) => [k.visit.id, k.reason]).sort(), [['inv', 'has_invoice'], ['rep', 'has_report']], 'later visits with a report / invoice are kept, with the reason');
  for (const never of ['done', 'missed', 'overdue', 'cancelled']) assert.ok(!ids(plan.willCancel).includes(never), `${never} must not be cancelled`);
});

test('CANCEL THIS AND FUTURE from a later visit leaves the earlier future visits alone', () => {
  const plan = planCancelWork(J, 'this_and_future', v2);
  assert.deepEqual(ids(plan.willCancel), ['undated', 'v2', 'v3']);
  assert.ok(!ids(plan.willCancel).includes('v1'));
});

test('CANCEL THE ENTIRE JOB plans every open visit (including an overdue one and an undated one) without needing a starting visit', () => {
  const plan = planCancelWork(J, 'job', null);
  assert.deepEqual(ids(plan.willCancel), ['overdue', 'undated', 'v1', 'v2', 'v3']);
  assert.deepEqual(ids(plan.kept.map((k) => k.visit)), ['inv', 'rep']);
});

test('a visit with a report is KEPT before a visit with an invoice (report wins), and completed / missed / cancelled are never planned', () => {
  const both = visit('both', { reportId: 'r', reportReviewStatus: 'approved', invoiceId: 'i', invoiceStatus: 'sent' });
  const plan = planCancelWork(job('x', [both, vDone, vMissed, vCancelled]), 'job', null);
  assert.deepEqual(plan.kept.map((k) => k.reason), ['has_report']);
  assert.equal(plan.willCancel.length, 0);
});

test('a job with no future visits, or with only past visits, plans nothing for the visit scopes and the job scope still applies', () => {
  const past = job('p', [vDone, vMissed]);
  assert.equal(planCancelWork(past, 'job', null).willCancel.length, 0);
  assert.equal(planCancelWork(past, 'visit', vDone).willCancel.length, 0, 'a completed visit cannot be the starting point');
});

test('a job with both past and future visits only ever plans the future ones', () => {
  const plan = planCancelWork(J, 'job', null);
  assert.ok(!ids(plan.willCancel).includes('done') && !ids(plan.willCancel).includes('missed'));
});

test('isOpenVisit: only due and booked', () => {
  assert.deepEqual(['due', 'booked', 'completed', 'missed', 'cancelled'].map((status) => isOpenVisit(visit('x', { status }))), [true, true, false, false, false]);
});

// ---- service_ends_on: derived demand ------------------------------------------------------------------------------
test('isDemandEndedForMonth: from the month of the end date onward; never for no end date', () => {
  assert.equal(isDemandEndedForMonth('2026-09', '2026-10-15'), false);
  assert.equal(isDemandEndedForMonth('2026-10', '2026-10-15'), true);
  assert.equal(isDemandEndedForMonth('2027-01', '2026-10-15'), true);
  assert.equal(isDemandEndedForMonth('2030-01', null), false);
  assert.equal(isDemandEndedForMonth('2030-01', undefined), false, 'rows cached before the field existed');
});

const monthly: any = { jobId: 'j', scheduleType: 'fixed_weekday', intervalUnit: 'month', intervalCount: 1, weekday: 'mon', weekOrdinal: '1st', dayOfMonth: null, rollForwardOnWeekend: true, dueMonth: null, notes: null };

test('NEEDS BOOKING: a monthly job with no visit this month is "needs booking" - until its service has ended', () => {
  assert.equal(deriveVisitState([], '2026-10-08', monthly).status, 'needs_booking');
  assert.equal(deriveVisitState([], '2026-10-08', monthly, '2026-11-01').status, 'needs_booking', 'ends next month: this month is still due');
  assert.equal(deriveVisitState([], '2026-10-08', monthly, '2026-10-15').status, 'unscheduled', 'ends this month: nothing more is asked for');
  assert.equal(deriveVisitState([], '2026-10-08', monthly, '2026-09-01').status, 'unscheduled', 'ended earlier');
});

test('MONTH MATRIX: months before the end date stay due, the end month and later are not due', () => {
  const cells = deriveMonthCellStates(job('m', [], { schedule: monthly, serviceEndsOn: '2026-10-15' }), 2026, '2026-06-01');
  assert.equal(cells.slice(0, 9).every((c) => c.kind === 'due_no_date'), true, 'Jan-Sep still due');
  assert.equal(cells.slice(9).every((c) => c.kind === 'not_due'), true, 'Oct-Dec no longer due');
  const next = deriveMonthCellStates(job('m', [], { schedule: monthly, serviceEndsOn: '2026-10-15' }), 2027, '2026-06-01');
  assert.equal(next.every((c) => c.kind === 'not_due'), true, 'the following year is not due either');
});

test('MONTH MATRIX: a visit that really happened before the end date still shows; a job with no end date is unchanged', () => {
  const done = visit('d', { status: 'completed', scheduledDate: '2026-10-03', priceCharged: 1, completedAt: 'x', reportReviewStatus: 'approved' });
  const cells = deriveMonthCellStates(job('m', [done], { schedule: monthly, serviceEndsOn: '2026-10-15' }), 2026, '2026-10-20');
  assert.notEqual(cells[9].kind, 'not_due', 'October has a real visit and keeps showing it');
  const plain = deriveMonthCellStates(job('m', [], { schedule: monthly }), 2026, '2026-06-01');
  assert.equal(plain.every((c) => c.kind === 'due_no_date'), true);
});

test('cancelled visits are ignored when deriving a job\'s state', () => {
  const rows: any[] = [{ id: 'a', scheduled_date: '2026-10-20', status: 'cancelled', reports: null, completed_at: null }];
  assert.equal(deriveVisitState(rows, '2026-10-08', null).status, 'unscheduled');
});

// ---- report queues -----------------------------------------------------------------------------------------------------
const awaiting = visit('a', { status: 'completed', reportId: 'r', reportReviewStatus: 'awaiting_review' });
const returned = visit('b', { status: 'completed', reportId: 'r', reportReviewStatus: 'returned_for_correction' });
const approved = visit('c', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved' });
const approvedDone = visit('d', { status: 'completed', reportId: 'r', reportReviewStatus: 'approved', reportCompletedAt: 't', reportCompletedBy: 'l' });
const approvedDoneDraft = { ...approvedDone, id: 'e', invoiceId: 'i', invoiceStatus: 'draft' };
const approvedDoneSent = { ...approvedDone, id: 'f', invoiceId: 'i', invoiceStatus: 'sent' };
const cancelledJob = (v: any) => job('x', [v], { lifecycleStatus: 'cancelled' });

test('REPORT REVIEW: awaiting review and returned are in the queue, approved ones are not - on any job', () => {
  assert.deepEqual([awaiting, returned, approved, approvedDone].map(isVisitInReviewQueue), [true, true, false, false]);
});

test('READY FOR CLIENT: approved and not Completed is in the queue; Completed is not - the same for cancelled jobs', () => {
  assert.deepEqual([awaiting, approved, approvedDone].map(isVisitInClientQueue), [false, true, false]);
});

test('READY FOR ACCOUNTS on a CANCELLED job: approved with no invoice or an unsent invoice stays - even when the report is Completed; a sent invoice or an unapproved report does not', () => {
  const cj = (v: any) => isVisitInAccountsQueue(cancelledJob(v), v);
  assert.equal(cj(approved), true, 'approved, no invoice');
  assert.equal(cj(approvedDone), true, 'approved + Completed + no invoice: completed does not mean billed');
  assert.equal(cj(approvedDoneDraft), true, 'invoice still a draft');
  assert.equal(cj({ ...approvedDoneDraft, invoiceStatus: 'failed' }), true, 'invoice failed to send');
  assert.equal(cj(approvedDoneSent), false, 'invoice sent: finished, must not leak back');
  assert.equal(cj(awaiting), false, 'not approved');
});

test('READY FOR ACCOUNTS on an ACTIVE job is exactly what it was: approved-and-unbilled, or already invoiced (a sent invoice stays visible)', () => {
  const aj = (v: any) => isVisitInAccountsQueue(job('x', [v]), v);
  assert.equal(aj(approved), true);
  assert.equal(aj(approvedDoneSent), true, 'sent invoices stay listed on active jobs, as before');
  assert.equal(aj(awaiting), false);
});

test('the accounts nav count: active jobs unchanged; cancelled jobs count open accounting work only', () => {
  assert.equal(isVisitCountedForAccounts(job('x', [approved]), approved), true);
  assert.equal(isVisitCountedForAccounts(cancelledJob(approved), approved), true);
  assert.equal(isVisitCountedForAccounts(cancelledJob(approvedDoneSent), approvedDoneSent), false);
  assert.equal(hasOpenAccountsWork(approvedDoneSent), false);
});

test('isActiveJob treats job rows cached before lifecycle status existed as active', () => {
  assert.equal(isActiveJob({ lifecycleStatus: undefined } as any), true);
  assert.equal(isActiveJob({ lifecycleStatus: 'cancelled' } as any), false);
  assert.equal(isActiveJob({ lifecycleStatus: 'on_hold' } as any), false);
});

test('mergeQueueJobs: active jobs first, then closed jobs with open work; a job is never listed twice', () => {
  const a = job('a', []);
  const c = job('c', [], { lifecycleStatus: 'cancelled' });
  assert.deepEqual(mergeQueueJobs([a], [c]).map((j) => j.id), ['a', 'c']);
  assert.deepEqual(mergeQueueJobs([a], [a, c]).map((j) => j.id), ['a', 'c']);
  assert.deepEqual(mergeQueueJobs([], []).map((j) => j.id), []);
});

test('NAV BADGES: the three report-queue counts include open work on cancelled jobs, and respect the division', () => {
  const active = job('a', [approved], { division: 'General', status: 'booked' });
  const cancelledAwaiting = job('c', [awaiting], { division: 'General', lifecycleStatus: 'cancelled', status: 'review' });
  const cancelledSent = job('s', [approvedDoneSent], { division: 'Specialist', lifecycleStatus: 'cancelled', status: 'booked' });
  const rows = [active, cancelledAwaiting, cancelledSent];
  assert.deepEqual(queueCounts(rows, 'Both'), { review: 1, readyForAccounts: 1, readyForClient: 1 }, 'review: the cancelled job; accounts: the active approved one (a sent invoice on a cancelled job does not count)');
  assert.deepEqual(queueCounts(rows, 'Specialist'), { review: 0, readyForAccounts: 0, readyForClient: 0 });
  assert.deepEqual(queueCounts(rows, 'General'), { review: 1, readyForAccounts: 1, readyForClient: 1 });
});
