// Report text fields renamed (Nov 2026): "Notes / Issues" -> "Issue" and "Optional notes" -> "Notes", everywhere a person types or
// reads them - the technician's report, Report review, and the office's Complete & report form (and its resumed-submission summary).
// What is written under Issue reaches the client as "Flagged for your attention"; Notes is for anything else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_LABEL } from '../src/lib/reportTextAutosave';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

test('MANAGER: one shared label map - "Issue" and "Notes" (Report review + Complete & report use it)', () => {
  assert.deepEqual(FIELD_LABEL, { workCarriedOut: 'Work carried out', issues: 'Issue', technicianNotes: 'Notes' });
  assert.match(src('src', 'components', 'jobs', 'ReportPanel.tsx'), /\{FIELD_LABEL\[field\]\}/);
  const form = src('src', 'components', 'jobs', 'OfficeReportForm.tsx');
  assert.match(form, /\{FIELD_LABEL\.issues\}/);
  assert.match(form, /\{FIELD_LABEL\.technicianNotes\}/);
  const dialog = src('src', 'components', 'jobs', 'OfficeReportDialog.tsx');
  assert.match(dialog, /\[FIELD_LABEL\.issues, i\.issues \?\? '—'\]/);
  assert.match(dialog, /\[FIELD_LABEL\.technicianNotes, i\.technicianNotes \?\? '—'\]/);
});

test('TECHNICIAN: the report has an "Issue" section (with the quick phrases) and a separate "Notes" section', () => {
  const page = src('src', 'technician', 'JobReportPage.tsx');
  const visible = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(visible, /Notes \/ issues|Notes\/issues|Optional notes/i, 'old labels gone from the screen (code comments aside)');
  const issue = page.indexOf('>\n              Issue\n            </div>'.replace(/\n/g, page.includes('\r\n') ? '\r\n' : '\n'));
  const notes = page.indexOf('>\n              Notes\n            </div>'.replace(/\n/g, page.includes('\r\n') ? '\r\n' : '\n'));
  assert.ok(issue > 0 && notes > issue, 'Issue heading, then a Notes heading');
  assert.ok(page.indexOf('ISSUE_CHIPS.map') > issue && page.indexOf('ISSUE_CHIPS.map') < notes, 'quick phrases stay under Issue');
  assert.ok(page.indexOf('setTechnicianNotes(e.target.value)') > notes, 'the notes box sits under Notes');
  assert.match(page, /You can still add details in\s+Issue below/);
});
