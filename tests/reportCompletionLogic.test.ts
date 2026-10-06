// Pure-logic tests for report completion: the shared "Ready for client" queue rule, the completed predicate, the
// job-lifecycle rule, the database-row mapping, and the plain-words explanation of the one rule completion adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JobVisitSummary } from '../src/domain/types';
import { isReportCompleted, isReportReadyForClient } from '../src/lib/statusPresentation';
import { hasIncompleteReportWork } from '../src/components/jobs/JobLifecycleDialog';
import { mapVisitRow, type SupabaseVisit } from '../src/repository/mapJobRow';
import { REOPEN_FIRST_MESSAGE, explainCompletionBlock } from '../src/repository/reportsRepository';

// ---- fixtures -------------------------------------------------------------------------
function visit(over: Partial<JobVisitSummary> = {}): JobVisitSummary {
  return {
    id: 'v1', scheduledDate: '2026-10-01', status: 'completed', technicianId: 'mo', technicianName: 'Mo', additionalTechnicians: [], reportHasContributions: false,
    primaryContribution: 'submitted', priceCharged: 100, completedAt: '2026-10-01T10:00:00Z', reportId: 'r1', reportReviewStatus: 'approved',
    sentToClientAt: null, sentToAccountsAt: null, reportCompletedAt: null, reportCompletedBy: null, invoiceId: null, invoiceStatus: null, ...over,
  };
}
const SENT = '2026-10-02T09:00:00Z';
const DONE = '2026-10-03T09:00:00Z';

// ---- the queue rule: approved, until completed - however it was delivered ----------------------------------
test('an approved report that was never sent is in the Ready for client queue', () => {
  assert.equal(isReportReadyForClient(visit()), true);
});

test('KEY RULE: a report EMAILED through the system stays in the queue until it is completed', () => {
  assert.equal(isReportReadyForClient(visit({ sentToClientAt: SENT })), true);
});

test('a COMPLETED report leaves the queue - whether it was emailed or delivered by hand', () => {
  assert.equal(isReportReadyForClient(visit({ reportCompletedAt: DONE, reportCompletedBy: 'luke@x' })), false, 'delivered by hand');
  assert.equal(isReportReadyForClient(visit({ sentToClientAt: SENT, reportCompletedAt: DONE, reportCompletedBy: 'luke@x' })), false, 'emailed, then completed');
});

test('reports that are not approved are never in the queue', () => {
  assert.equal(isReportReadyForClient(visit({ reportReviewStatus: 'awaiting_review' })), false);
  assert.equal(isReportReadyForClient(visit({ reportReviewStatus: 'returned_for_correction' })), false);
  assert.equal(isReportReadyForClient(visit({ reportReviewStatus: null, reportId: null })), false);
});

test('isReportCompleted is true only once a completion time is recorded', () => {
  assert.equal(isReportCompleted(visit()), false);
  assert.equal(isReportCompleted(visit({ sentToClientAt: SENT })), false, 'sending does not complete');
  assert.equal(isReportCompleted(visit({ reportCompletedAt: DONE, reportCompletedBy: 'luke@x' })), true);
});

test('Reopen puts a report straight back in the queue (the same fields, cleared)', () => {
  const completed = visit({ sentToClientAt: SENT, reportCompletedAt: DONE, reportCompletedBy: 'luke@x' });
  assert.equal(isReportReadyForClient(completed), false);
  const reopened = { ...completed, reportCompletedAt: null, reportCompletedBy: null };
  assert.equal(isReportReadyForClient(reopened), true);
  assert.equal(reopened.sentToClientAt, SENT, 'reopening never touches the send record');
});

test('visits cached before completion existed (no completed fields) read as not completed, without throwing', () => {
  const old: any = { ...visit() };
  delete old.reportCompletedAt;
  delete old.reportCompletedBy;
  assert.doesNotThrow(() => {
    assert.equal(isReportReadyForClient(old), true);
    assert.equal(isReportCompleted(old), false);
    assert.equal(hasIncompleteReportWork(old), true);
  });
});

// ---- the job lifecycle: can the job be ended? -----------------------------------------------------------------
test('LIFECYCLE: a COMPLETED report no longer blocks ending the job', () => {
  assert.equal(hasIncompleteReportWork(visit({ reportCompletedAt: DONE, reportCompletedBy: 'luke@x' })), false);
  assert.equal(hasIncompleteReportWork(visit({ sentToClientAt: SENT, reportCompletedAt: DONE, reportCompletedBy: 'luke@x' })), false);
});

test('LIFECYCLE: a report that was SENT but not completed still counts as incomplete work', () => {
  assert.equal(hasIncompleteReportWork(visit({ sentToClientAt: SENT })), true);
  // even a fully invoiced and sent one: it is still waiting for the manager to complete it
  assert.equal(hasIncompleteReportWork(visit({ sentToClientAt: SENT, invoiceId: 'inv1', invoiceStatus: 'sent' })), true);
});

test('LIFECYCLE: everything that blocked before still blocks', () => {
  assert.equal(hasIncompleteReportWork(visit({ reportReviewStatus: 'awaiting_review' })), true);
  assert.equal(hasIncompleteReportWork(visit({ reportReviewStatus: 'returned_for_correction' })), true);
  assert.equal(hasIncompleteReportWork(visit()), true, 'approved, not completed');
});

test('LIFECYCLE: a visit with no report at all does not block', () => {
  assert.equal(hasIncompleteReportWork(visit({ reportId: null, reportReviewStatus: null })), false);
});

// ---- database row -> job visit summary --------------------------------------------------------------------------
function dbVisit(report: Record<string, unknown> | null): SupabaseVisit {
  return {
    id: 'v1', technician_id: 'mo', scheduled_date: '2026-10-01', status: 'completed', price_charged: 100, completed_at: '2026-10-01T10:00:00Z',
    technicians: { id: 'mo', name: 'Mo', is_active: true } as any, visit_technicians: [], invoice_line_items: null,
    reports: report as any,
  };
}

test('the job-row mapping carries completed_at / completed_by onto the visit, independent of the sent fields', () => {
  const v = mapVisitRow(dbVisit({ id: 'r1', review_status: 'approved', sent_to_client_at: null, sent_to_accounts_at: null, completed_at: DONE, completed_by: 'luke@x', report_contributions: [] }));
  assert.equal(v.reportCompletedAt, DONE);
  assert.equal(v.reportCompletedBy, 'luke@x');
  assert.equal(v.sentToClientAt, null, 'completed by hand: never emailed');
  const sentOnly = mapVisitRow(dbVisit({ id: 'r1', review_status: 'approved', sent_to_client_at: SENT, sent_to_accounts_at: null, completed_at: null, completed_by: null, report_contributions: [] }));
  assert.equal(sentOnly.sentToClientAt, SENT);
  assert.equal(sentOnly.reportCompletedAt, null);
});

test('a visit without a report, or from a row that lacks the new columns, maps to "not completed"', () => {
  assert.equal(mapVisitRow(dbVisit(null)).reportCompletedAt, null);
  const legacy = mapVisitRow(dbVisit({ id: 'r1', review_status: 'approved', sent_to_client_at: null, sent_to_accounts_at: null, report_contributions: [] }));
  assert.equal(legacy.reportCompletedAt, null);
  assert.equal(legacy.reportCompletedBy, null);
});

// ---- the one rule completion adds, in plain words -----------------------------------------------------------------
test('the database refusal for a completed report is explained as "reopen it first"', () => {
  const raw = 'new row for relation "reports" violates check constraint "reports_completion_requires_approval_check"';
  assert.equal(explainCompletionBlock(raw), REOPEN_FIRST_MESSAGE);
  assert.match(REOPEN_FIRST_MESSAGE, /Reopen it first/);
  assert.match(REOPEN_FIRST_MESSAGE, /returning it for correction/);
  assert.match(REOPEN_FIRST_MESSAGE, /technician/);
});

test('any other database error is NOT rewritten', () => {
  assert.equal(explainCompletionBlock('permission denied for table reports'), null);
  assert.equal(explainCompletionBlock('new row violates check constraint "reports_return_reason_check"'), null);
});
