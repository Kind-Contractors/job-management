// Dialogs no longer close while the manager is typing. A browser fires `click` on the nearest common ancestor of the press and
// the release, so a press that starts in a field and ends over the backdrop (selecting text, a small drag) used to close any
// dialog whose backdrop closed it. backdropDismiss closes only when the press ALSO started on the backdrop. Also: Edit contact
// opens as a dialog (like "+ Add contact"), and the Contacts & Defaults searches run as you type.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backdropDismiss } from '../src/lib/dialogHooks';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (code: string) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** A fake backdrop element and the events a browser would send to its handlers. */
function backdrop() {
  const el = { dataset: {} as Record<string, string> };
  const inner = { dataset: {} };
  const ev = (target: unknown) => ({ target, currentTarget: el }) as any;
  return { el, inner, ev };
}

// ---- the rule --------------------------------------------------------------------------------------------------------------------
test('BACKDROP: a click that started AND ended on the backdrop closes the dialog', () => {
  let closed = 0;
  const h = backdropDismiss(() => closed++);
  const { el, ev } = backdrop();
  h.onMouseDown(ev(el));
  h.onClick(ev(el));
  assert.equal(closed, 1);
});

test('BACKDROP: a press inside the dialog (typing, selecting text) released over the backdrop does NOT close it', () => {
  let closed = 0;
  const h = backdropDismiss(() => closed++);
  const { el, inner, ev } = backdrop();
  h.onMouseDown(ev(inner)); // pressed in a field
  h.onClick(ev(el)); // the browser reports the click on the common ancestor: the backdrop
  assert.equal(closed, 0);
});

test('BACKDROP: the mark is one-shot (a later click with no press on the backdrop does not close); no handler = never closes', () => {
  let closed = 0;
  const h = backdropDismiss(() => closed++);
  const { el, inner, ev } = backdrop();
  h.onMouseDown(ev(el));
  h.onClick(ev(el));
  h.onMouseDown(ev(inner));
  h.onClick(ev(el));
  h.onClick(ev(el));
  assert.equal(closed, 1);
  const off = backdropDismiss(undefined);
  off.onMouseDown(ev(el));
  assert.doesNotThrow(() => off.onClick(ev(el)), 'disabled while saving: nothing happens');
});

// ---- every dialog that closes on its backdrop uses the rule ------------------------------------------------------------------
const DIALOGS = [
  'src/pages/UsersPage.tsx',
  'src/pages/ReadyForClientPage.tsx',
  'src/auth/ChangePasswordDialog.tsx',
  'src/components/calendar/ScheduleDayDrawer.tsx',
  'src/components/buildings/BuildingReportsPanel.tsx',
  'src/components/jobs/ContactPopover.tsx',
  'src/components/jobs/LinkXeroContactDialog.tsx',
  'src/components/jobs/JobLifecycleDialog.tsx',
  'src/components/settings/AutoInvoiceEmailSetting.tsx',
  'src/components/jobs/CancelWorkDialog.tsx',
  'src/components/reports/PdfDocumentView.tsx',
  'src/components/monthlyPlan/SetScheduleDialog.tsx',
  'src/components/reports/SkippedPhotosDialog.tsx',
  'src/technician/ConfirmDeleteDialog.tsx',
];

test('ALL DIALOGS: every centred dialog that closes on its backdrop goes through backdropDismiss (none closes on a plain backdrop click)', () => {
  for (const f of DIALOGS) {
    const code = noComments(src(f));
    assert.match(code, /backdropDismiss\(/, f);
    assert.match(code, /\{\.\.\.(backdrop|jobCreatorBackdrop)\}/, f);
    // A centred overlay (fixed inset-0 ... items-center / justify-end panel) must not close on a plain onClick any more.
    for (const m of code.matchAll(/<div\s+className="fixed inset-0 [^"]*"([^>]*)>/g)) {
      if (/hidden bg-ink\/30 lg:block|z-40 bg-ink\/30"/.test(m[0])) continue; // side drawers: their backdrop is a sibling (see below)
      assert.doesNotMatch(m[1], /onClick=\{(onClose|onCancel|\(\) =>)/, `${f}: ${m[0].slice(0, 90)}`);
    }
  }
});

test('ALL DIALOGS: the conditions that already stopped a close are kept (while saving / once done / while deleting)', () => {
  assert.match(src('src/components/settings/AutoInvoiceEmailSetting.tsx'), /backdropDismiss\(state\.saving \? undefined : onCancel\)/);
  assert.match(src('src/components/jobs/CancelWorkDialog.tsx'), /backdropDismiss\(result \? undefined : onClose\)/);
  assert.match(src('src/technician/ConfirmDeleteDialog.tsx'), /backdropDismiss\(busy \? undefined : onCancel\)/);
});

test('SIDE DRAWERS are already safe: their backdrop is a SIBLING of the panel, so a press in the panel can never click it', () => {
  for (const f of ['src/components/jobs/JobInspectorDrawer.tsx', 'src/pages/HistoricalJobsPage.tsx']) {
    assert.match(src(f), /<div className="fixed inset-0 z-40 hidden bg-ink\/30 lg:block" onClick=\{onClose\} \/>\s*<aside/, f);
  }
});

test('FORM DIALOGS that never close on the backdrop are unchanged (Edit building, + Add contact, Edit contact)', () => {
  for (const f of ['src/components/jobs/BuildingEditor.tsx', 'src/components/buildings/BuildingAddContactForm.tsx']) {
    const code = src(f);
    assert.match(code, /onMouseDown=\{\(e\) => \{\s+if \(e\.target === e\.currentTarget\) e\.preventDefault\(\);/, f);
    assert.doesNotMatch(code.slice(0, code.indexOf('role="dialog"')), /onClick=/, f);
  }
});

// ---- Edit contact as a dialog -------------------------------------------------------------------------------------------------------
test('EDIT CONTACT: opens as a dialog over the page; closed only by Cancel, the close button or Escape - never the backdrop', () => {
  const tab = src('src/components/buildings/ContactsAndDefaultsTab.tsx');
  const dialog = tab.slice(tab.indexOf('function EditContactDialog('));
  assert.match(dialog, /className="fixed inset-0 z-50 flex items-center justify-center bg-ink\/30"\s+onMouseDown=\{\(e\) => \{\s+if \(e\.target === e\.currentTarget\) e\.preventDefault\(\);/);
  assert.match(dialog, /data-testid="edit-contact-dialog"\s+role="dialog"\s+aria-modal="true"\s+aria-label=\{`Edit contact: \$\{name\}`\}/);
  assert.match(dialog, /if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.match(dialog, /aria-label="Close"/);
  assert.doesNotMatch(dialog.slice(0, dialog.indexOf('role="dialog"')), /onClick=/, 'the backdrop does not close it');
  assert.match(tab, /<EditContactDialog name=\{editingContact\.name\} onClose=\{\(\) => setEditingId\(null\)\}>\s+<EditContactForm/);
  assert.match(tab, /onCancel=\{\(\) => setEditingId\(null\)\}/);
  assert.doesNotMatch(tab, /<div className="mt-2 border border-neutral-300 bg-neutral-100 p-2\.5">\s*<EditContactForm/, 'no longer inline under the row');
  assert.match(src('src/components/contacts/EditContactForm.tsx'), /aria-required="true"\s+autoFocus/, 'the cursor starts in Name, inside the dialog (so Escape works)');
});

// ---- search as you type --------------------------------------------------------------------------------------------------------------
test('AUTOSEARCH: the contact filter already filters as you type; both Xero searches wait for a pause, not every keystroke', () => {
  const tab = src('src/components/buildings/ContactsAndDefaultsTab.tsx');
  assert.match(tab, /onChange=\{\(e\) => setFilter\(e\.target\.value\)\}/);
  assert.match(tab, /const shown = q \? contacts\.filter/);
  const hooks = src('src/lib/dialogHooks.ts');
  assert.match(hooks, /const timer = setTimeout\(\(\) => setDebounced\(value\), delayMs\);\s+return \(\) => clearTimeout\(timer\);/, 'one timer per pause, cleared on every change');
});
