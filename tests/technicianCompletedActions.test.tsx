// The completion screen's buttons (src/technician/CompletedPage.tsx, CompletedActions): "Back to My day" is ALWAYS there - also while
// photos/videos are uploading or the report is still being sent (that carries on in the background); "Next stop" is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompletedActions } from '../src/technician/CompletedPage';
import type { TechnicianDayItem } from '../src/technician/api';

const nextVisit = { kind: 'visit', visitId: 'v-next', buildingName: 'Acme - Build 2', buildingAddress: '1 Test St' } as unknown as TechnicianDayItem;
const nextActivity = { kind: 'activity', activityId: 'a1', description: 'Collect keys' } as unknown as TechnicianDayItem;

/** The buttons the component renders, in order, with their labels and click handlers. */
function buttons(el: ReactNode): { label: string; onClick: () => void; className: string }[] {
  const out: { label: string; onClick: () => void; className: string }[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const e = n as ReactElement<{ children?: ReactNode; onClick?: () => void; className?: string }>;
    if (e.type === 'button') out.push({ label: renderToStaticMarkup(<>{e.props.children}</>), onClick: e.props.onClick!, className: e.props.className ?? '' });
    else walk(e.props.children);
  };
  walk(el);
  return out;
}

test('NEXT VISIT: "Next stop" stays the main button (to that visit), "Back to My day" beneath it (to My day)', () => {
  const went: string[] = [];
  const b = buttons(CompletedActions({ nextStop: nextVisit, onNavigate: (to) => went.push(to) }));
  assert.deepEqual(b.map((x) => x.label), ['Next stop — Acme - Build 2', 'Back to My day']);
  assert.match(b[0].className, /bg-teal .*text-white/, 'Next stop keeps its primary look');
  assert.match(b[1].className, /border border-teal bg-white .*text-teal-700/, 'Back to My day is the secondary button');
  b[0].onClick();
  b[1].onClick();
  assert.deepEqual(went, ['/technician/visits/v-next', '/technician']);
});

test('NO NEXT STOP: "Back to My day" is still there (as the one button), and goes to My day', () => {
  const went: string[] = [];
  const b = buttons(CompletedActions({ nextStop: undefined, onNavigate: (to) => went.push(to) }));
  assert.deepEqual(b.map((x) => x.label), ['Back to My day']);
  b[0].onClick();
  assert.deepEqual(went, ['/technician']);
});

test('NEXT ACTIVITY: unchanged "Next — Activity" button, plus "Back to My day"', () => {
  const went: string[] = [];
  const b = buttons(CompletedActions({ nextStop: nextActivity, onNavigate: (to) => went.push(to) }));
  assert.deepEqual(b.map((x) => x.label), ['Next — Activity: Collect keys', 'Back to My day']);
  b[0].onClick();
  assert.deepEqual(went, ['/technician'], 'as before: an activity is done from My day');
});

test('ALWAYS: the completion screen shows the buttons whatever the upload/send state; nothing on it stops the background work', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'technician', 'CompletedPage.tsx'), 'utf8');
  const page = src.slice(src.indexOf('export default function CompletedPage'));
  assert.equal((page.match(/<CompletedActions /g) ?? []).length, 1);
  assert.match(page, /\r?\n {6}<CompletedActions nextStop=\{nextStop\} onNavigate=\{navigate\} \/>\r?\n {4}<\/div>\r?\n {2}\);\r?\n\}/, 'rendered unconditionally at the end of the screen - not behind "synced"');
  assert.doesNotMatch(src, /showBackToJobsList/, 'the old "only once synced" rule is gone');
  // The uploads and the report send run in engines started once for the whole technician app, not by this screen.
  const shell = readFileSync(join(process.cwd(), 'src', 'technician', 'TechnicianShell.tsx'), 'utf8');
  assert.match(shell, /startSyncEngine\(\);/);
  assert.match(shell, /startVideoSyncEngine\(\);/);
  assert.doesNotMatch(src, /startSyncEngine|startVideoSyncEngine|abort\(|removeQueuedVideo/, 'leaving this screen cannot start, stop or cancel uploads');
});
