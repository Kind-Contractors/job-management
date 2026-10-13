// Automatic saving of the manager's text edits in Report Review (src/lib/reportTextAutosave.ts): no "Save changes" button, nothing lost,
// Approve / Return / Resubmit save first, text is locked once approved / Completed / sent, and text changed elsewhere is never silently
// overwritten or replaced. Pure logic with fake timers; the screen wiring is checked in the browser test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_FLUSH_ROUNDS,
  ReportTextAutosave,
  changedFields,
  isReportTextLocked,
  reportTextLockReason,
  type AutosaveState,
  type TextEdits,
  type TextValues,
} from '../src/lib/reportTextAutosave';

function setup(initial: TextValues = { workCarriedOut: 'Cleaned', issues: null, technicianNotes: null }, opts: { failSaves?: number } = {}) {
  const db: TextValues = { ...initial };
  const saves: TextEdits[] = [];
  const expecteds: TextValues[] = [];
  const states: AutosaveState[] = [];
  let failures = opts.failSaves ?? 0;
  let release: (() => void) | null = null;
  let hold = false;
  let locked = false;
  let onSave: ((patch: TextEdits) => void) | null = null;
  const timers: { fn: () => void; ms: number; id: number; cancelled: boolean }[] = [];
  const a = new ReportTextAutosave({
    getSaved: () => db,
    isLocked: () => locked,
    save: async (patch, expected) => {
      saves.push({ ...patch });
      expecteds.push({ ...expected });
      onSave?.(patch);
      if (hold) await new Promise<void>((r) => (release = r));
      if (failures > 0) {
        failures -= 1;
        throw new Error('Failed to update report: network down');
      }
      Object.assign(db, patch); // the database now holds it (the screen has not re-read it until the test calls sync())
    },
    onState: (s) => states.push(s),
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
  });
  a.sync(); // the screen has loaded the report
  const pendingTimers = () => timers.filter((t) => !t.cancelled);
  const fire = async () => {
    const t = pendingTimers().pop();
    assert.ok(t, 'a save was scheduled');
    t.cancelled = true;
    t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return {
    a, db, saves, expecteds, states, timers, pendingTimers, fire,
    hold: (v: boolean) => (hold = v), release: () => release?.(), setFailures: (n: number) => (failures = n),
    lock: (v = true) => (locked = v),
    onSave: (fn: ((patch: TextEdits) => void) | null) => (onSave = fn),
  };
}

// ---- what is sent -------------------------------------------------------------------------------------------------------------------
test('changedFields: only text that really differs from the stored text is sent (null and empty are the same)', () => {
  assert.deepEqual(changedFields({ workCarriedOut: 'a', issues: null }, { workCarriedOut: 'a', issues: '' }), {});
  assert.deepEqual(changedFields({ workCarriedOut: 'a', issues: null }, { workCarriedOut: 'b', issues: '' }), { workCarriedOut: 'b' });
  assert.deepEqual(changedFields({ issues: 'x' }, { issues: '' }), { issues: '' }, 'clearing a field is a real change');
  assert.deepEqual(changedFields({}, { technicianNotes: 'n' }), { technicianNotes: 'n' });
});

// ---- when it saves --------------------------------------------------------------------------------------------------------------------
test('TYPING saves automatically after a quiet moment (1.5 s) - one save for a burst of keystrokes, only the changed field', async () => {
  const t = setup();
  t.a.edit('issues', 'L');
  t.a.edit('issues', 'Leak');
  t.a.edit('issues', 'Leak under sink');
  assert.equal(t.pendingTimers().length, 1, 'each keystroke restarts the one timer');
  assert.equal(t.pendingTimers()[0].ms, 1500);
  assert.equal(t.a.current.status, 'pending');
  assert.equal(t.saves.length, 0, 'nothing is sent while typing');
  await t.fire();
  assert.deepEqual(t.saves, [{ issues: 'Leak under sink' }], 'one save, only the field that changed');
  assert.equal(t.a.current.status, 'saved');
});

test('EVERY write says which stored text it expects to replace (so the database can refuse it if that text changed meanwhile)', async () => {
  const t = setup({ workCarriedOut: 'Cleaned', issues: null, technicianNotes: 'n' });
  t.a.edit('issues', 'Leak');
  t.a.edit('technicianNotes', 'n2');
  await t.a.flush();
  assert.deepEqual(t.saves, [{ issues: 'Leak', technicianNotes: 'n2' }]);
  assert.deepEqual(t.expecteds, [{ issues: null, technicianNotes: 'n' }], 'only the edited fields, with the text they replace');
  t.a.edit('issues', 'Leak fixed');
  await t.a.flush();
  assert.deepEqual(t.expecteds[1], { issues: 'Leak' }, 'the next write expects what this one wrote');
});

test('LEAVING a field saves at once (blur) without waiting for the timer', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Cleaned and polished');
  t.a.blur();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.saves, [{ workCarriedOut: 'Cleaned and polished' }]);
  assert.equal(t.pendingTimers().length, 0, 'the timer was cancelled');
});

test('TYPING BACK to the stored text sends nothing', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Cleaned!');
  t.a.edit('workCarriedOut', 'Cleaned');
  await t.a.flush();
  assert.equal(t.saves.length, 0);
});

test('THE SCREEN shows what is typed, then what was last saved - never flickers back to old text while the report is re-read', async () => {
  const t = setup();
  assert.equal(t.a.value('workCarriedOut'), 'Cleaned');
  t.a.edit('workCarriedOut', 'New text');
  assert.equal(t.a.value('workCarriedOut'), 'New text');
  await t.a.flush();
  t.db.workCarriedOut = 'Cleaned'; // the screen's report data is still the old one (the re-read has not finished)
  t.a.sync();
  assert.equal(t.a.value('workCarriedOut'), 'New text');
  assert.deepEqual(t.a.changedElsewhere, [], 'the old data is not mistaken for someone else\'s change');
  t.db.workCarriedOut = 'New text'; // the re-read arrives
  t.a.sync();
  assert.equal(t.a.value('workCarriedOut'), 'New text');
  assert.deepEqual(t.a.changedElsewhere, []);
});

// ---- Approve / Return / Resubmit --------------------------------------------------------------------------------------------------------
test('FLUSH saves everything pending right now (what Approve awaits) and resolves only when it is stored', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Final wording');
  t.a.edit('technicianNotes', 'Key left with caretaker');
  await t.a.flush();
  assert.deepEqual(t.saves, [{ workCarriedOut: 'Final wording', technicianNotes: 'Key left with caretaker' }]);
  assert.equal(t.db.workCarriedOut, 'Final wording');
  assert.equal(t.pendingTimers().length, 0);
  assert.equal(t.a.hasUnsavedWork(), false);
});

test('FLUSH with nothing pending sends nothing and resolves', async () => {
  const t = setup();
  await t.a.flush();
  assert.equal(t.saves.length, 0);
});

test('FLUSH REJECTS when the save fails - so Approve stops - and the typed text is kept for another try', async () => {
  const t = setup(undefined, { failSaves: 1 });
  t.a.edit('issues', 'Cracked tile in lobby');
  await assert.rejects(t.a.flush(), /network down/);
  assert.equal(t.a.current.status, 'error');
  assert.match(t.a.current.error ?? '', /network down/);
  assert.equal(t.a.value('issues'), 'Cracked tile in lobby', 'the manager\'s text is still on screen');
  assert.equal(t.a.hasUnsavedWork(), true, 'and leaving the page would lose it, so the page warns');
  await t.a.flush(); // Try again
  assert.equal(t.a.current.status, 'saved');
  assert.equal(t.db.issues, 'Cracked tile in lobby');
  assert.equal(t.saves.length, 2);
});

test('A FAILED background save (timer / blur) does not throw into the page: the status line shows the error', async () => {
  const t = setup(undefined, { failSaves: 1 });
  t.a.edit('issues', 'x');
  await t.fire();
  assert.equal(t.a.current.status, 'error');
  assert.equal(t.a.value('issues'), 'x');
  assert.equal(t.a.hasUnsavedWork(), true);
});

test('TYPING WHILE A SAVE IS RUNNING: the newer text is not lost and is saved next', async () => {
  const t = setup();
  t.hold(true);
  t.a.edit('workCarriedOut', 'First');
  const flushing = t.a.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.a.current.status, 'saving');
  t.a.edit('workCarriedOut', 'First, then more'); // typed during the save
  t.hold(false);
  t.release();
  await flushing;
  await t.a.flush();
  assert.deepEqual(t.saves.map((s) => s.workCarriedOut), ['First', 'First, then more']);
  assert.equal(t.db.workCarriedOut, 'First, then more');
  assert.equal(t.a.value('workCarriedOut'), 'First, then more');
});

test('A FLUSH WHILE A SAVE IS RUNNING waits for it instead of saving the same text twice', async () => {
  const t = setup();
  t.hold(true);
  t.a.edit('workCarriedOut', 'Once');
  const first = t.a.flush();
  await new Promise((r) => setImmediate(r));
  const second = t.a.flush();
  t.hold(false);
  t.release();
  await Promise.all([first, second]);
  assert.deepEqual(t.saves.map((s) => s.workCarriedOut), ['Once']);
});

test('FLUSH THROWS (never reports success) when the text keeps changing and is still unsaved after the maximum number of rounds', async () => {
  const t = setup();
  let n = 0;
  t.onSave(() => {
    n += 1;
    t.a.edit('workCarriedOut', `typing ${n}`); // the manager is still typing during every save
  });
  t.a.edit('workCarriedOut', 'typing 0');
  await assert.rejects(t.a.flush(), /not saved yet because the text kept changing/);
  assert.equal(t.saves.length, MAX_FLUSH_ROUNDS, 'it tried every round');
  assert.equal(t.a.current.status, 'error');
  assert.equal(t.a.hasUnsavedWork(), true, 'the last typing is still held, not dropped');
  assert.equal(t.a.value('workCarriedOut'), `typing ${MAX_FLUSH_ROUNDS}`);
});

test('FLUSH succeeds when the manager stops typing in time (the last round leaves nothing pending)', async () => {
  const t = setup();
  let n = 0;
  t.onSave(() => {
    n += 1;
    if (n < 3) t.a.edit('workCarriedOut', `typing ${n}`);
  });
  t.a.edit('workCarriedOut', 'typing 0');
  await t.a.flush();
  assert.equal(t.saves.length, 3);
  assert.equal(t.db.workCarriedOut, 'typing 2');
  assert.equal(t.a.hasUnsavedWork(), false);
});

// ---- locked text ------------------------------------------------------------------------------------------------------------------------
test('LOCK RULES: approved, Completed and sent reports are locked; awaiting review and returned are editable', () => {
  assert.equal(isReportTextLocked({ reviewStatus: 'awaiting_review' }), false);
  assert.equal(isReportTextLocked({ reviewStatus: 'returned_for_correction', completedAt: null, sentToClientAt: null }), false);
  assert.equal(isReportTextLocked({ reviewStatus: 'approved' }), true);
  assert.equal(isReportTextLocked({ reviewStatus: 'awaiting_review', completedAt: '2026-10-03T09:00:00Z' }), true);
  assert.equal(isReportTextLocked({ reviewStatus: 'returned_for_correction', sentToClientAt: '2026-10-03T09:00:00Z' }), true);
  assert.match(reportTextLockReason({ reviewStatus: 'approved' }) ?? '', /approved/);
  assert.match(reportTextLockReason({ reviewStatus: 'approved', completedAt: 'x' }) ?? '', /Completed/);
  assert.match(reportTextLockReason({ reviewStatus: 'approved', completedAt: 'x', sentToClientAt: 'y' }) ?? '', /sent to the client/);
  assert.equal(reportTextLockReason({ reviewStatus: 'awaiting_review' }), null);
});

test('LOCKED: typing is ignored and nothing is ever written', async () => {
  const t = setup();
  t.lock();
  t.a.edit('workCarriedOut', 'sneaky');
  assert.equal(t.a.value('workCarriedOut'), 'Cleaned');
  assert.equal(t.pendingTimers().length, 0);
  await t.a.flush();
  assert.equal(t.saves.length, 0);
});

test('LOCKED AFTER TYPING (the report was approved elsewhere): pending text is dropped, not written, and the page no longer warns', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Half-typed');
  t.lock(); // the report reloads as approved
  t.a.sync();
  assert.equal(t.pendingTimers().length, 0, 'the save timer was cancelled');
  assert.equal(t.a.hasUnsavedWork(), false);
  await t.a.flush();
  t.a.dispose();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.saves.length, 0);
  assert.equal(t.a.value('workCarriedOut'), 'Cleaned');
});

test('LOCKED WHILE A SAVE WAS RUNNING (it was refused because the report got approved): no error is shown for text nobody can edit now', async () => {
  const t = setup(undefined, { failSaves: 1 });
  t.a.edit('issues', 'late');
  t.onSave(() => t.lock());
  await assert.rejects(t.a.flush(), /network down/);
  assert.equal(t.a.current.status, 'idle');
  assert.equal(t.a.hasUnsavedWork(), false);
});

// ---- text changed elsewhere --------------------------------------------------------------------------------------------------------------
test('CHANGED ELSEWHERE, no local edit: the new text is shown and flagged, and stays flagged until acknowledged', () => {
  const t = setup();
  t.db.workCarriedOut = 'Cleaned, plus windows (technician resubmitted)';
  t.a.sync();
  assert.equal(t.a.value('workCarriedOut'), 'Cleaned, plus windows (technician resubmitted)');
  assert.deepEqual(t.a.changedElsewhere, ['workCarriedOut']);
  assert.deepEqual(t.a.conflicts, []);
  t.a.sync(); // another render changes nothing
  assert.deepEqual(t.a.changedElsewhere, ['workCarriedOut']);
  t.a.acknowledgeExternalChanges();
  assert.deepEqual(t.a.changedElsewhere, []);
});

test('CHANGED ELSEWHERE while the manager has unsaved typing in that field: the typing is NOT overwritten, it becomes a conflict and nothing is saved', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'My careful rewrite');
  t.db.workCarriedOut = 'Technician resubmitted this';
  t.a.sync();
  assert.equal(t.a.value('workCarriedOut'), 'My careful rewrite', 'local text kept');
  assert.deepEqual(t.a.conflicts, ['workCarriedOut']);
  assert.equal(t.a.serverText('workCarriedOut'), 'Technician resubmitted this');
  assert.deepEqual(t.a.changedElsewhere, []);
  await t.fire().catch(() => undefined);
  await assert.rejects(t.a.flush(), /was changed elsewhere while you were editing/);
  assert.equal(t.saves.length, 0, 'nothing was written over the newer text');
  assert.equal(t.a.current.status, 'conflict');
  assert.equal(t.a.hasUnsavedWork(), true);
});

test('CONFLICT, "Keep my version": the manager\'s text is saved next, expecting the NEWER stored text', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Mine');
  t.db.workCarriedOut = 'Theirs';
  t.a.sync();
  t.a.keepMine('workCarriedOut');
  await t.a.flush();
  assert.deepEqual(t.saves, [{ workCarriedOut: 'Mine' }]);
  assert.deepEqual(t.expecteds, [{ workCarriedOut: 'Theirs' }]);
  assert.deepEqual(t.a.conflicts, []);
});

test('CONFLICT, "Use the newer text": the manager\'s version is dropped and nothing is written', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Mine');
  t.db.workCarriedOut = 'Theirs';
  t.a.sync();
  t.a.useTheirs('workCarriedOut');
  assert.equal(t.a.value('workCarriedOut'), 'Theirs');
  await t.a.flush();
  assert.equal(t.saves.length, 0);
  assert.deepEqual(t.a.conflicts, []);
  assert.equal(t.a.hasUnsavedWork(), false);
});

test('A CONFLICT IN ONE FIELD does not touch another field: only the conflicting one waits', async () => {
  const t = setup();
  t.a.edit('issues', 'Leak');
  t.a.edit('workCarriedOut', 'Mine');
  t.db.workCarriedOut = 'Theirs';
  t.a.sync();
  assert.deepEqual(t.a.conflicts, ['workCarriedOut']);
  assert.equal(t.a.value('issues'), 'Leak');
  await assert.rejects(t.a.flush(), /“Work carried out”/);
});

test('THE DATABASE REFUSES a write whose expected text is out of date: the controller reports an error, keeps the typing, and the re-read turns it into a conflict', async () => {
  const t = setup();
  t.a.edit('issues', 'Leak');
  t.onSave(() => {
    // someone else saved first; the (real) save refuses, and the screen re-reads the report
    t.db.issues = 'Cracked tile (technician)';
  });
  t.setFailures(1);
  await assert.rejects(t.a.flush());
  t.a.sync(); // the re-read
  assert.deepEqual(t.a.conflicts, ['issues']);
  assert.equal(t.a.value('issues'), 'Leak');
  assert.equal(t.a.serverText('issues'), 'Cracked tile (technician)');
});

test('OUR OWN WRITE coming back in the next read is not "changed elsewhere"', async () => {
  const t = setup();
  t.a.edit('issues', 'Leak');
  await t.a.flush();
  t.a.sync();
  assert.deepEqual(t.a.changedElsewhere, []);
  assert.deepEqual(t.a.conflicts, []);
});

// ---- housekeeping --------------------------------------------------------------------------------------------------------------------------
test('DISCARD forgets unsaved text and cancels the timer (the report text was reset from the technicians\' versions); a fresh baseline avoids a false "changed elsewhere"', async () => {
  const t = setup();
  t.a.edit('workCarriedOut', 'Local edit');
  t.a.discard({ workCarriedOut: 'Combined from technicians', issues: null, technicianNotes: null });
  t.db.workCarriedOut = 'Combined from technicians';
  t.a.sync();
  assert.equal(t.pendingTimers().length, 0);
  assert.equal(t.a.value('workCarriedOut'), 'Combined from technicians');
  assert.deepEqual(t.a.changedElsewhere, []);
  await t.a.flush();
  assert.equal(t.saves.length, 0);
  assert.equal(t.a.current.status, 'idle');
});

test('DISPOSE (leaving the screen) saves what is still pending and stops the timer', async () => {
  const t = setup();
  t.a.edit('issues', 'Late edit');
  t.a.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.saves, [{ issues: 'Late edit' }]);
  assert.equal(t.pendingTimers().length, 0);
});

test('STATUS goes pending -> saving -> saved and each change is announced to the screen', async () => {
  const t = setup();
  t.a.edit('issues', 'x');
  await t.a.flush();
  assert.deepEqual(t.states.map((s) => s.status), ['pending', 'saving', 'saved']);
});
