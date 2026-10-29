// Building File lists scroll within their card once they have more than 5 rows: Jobs at this building, Job reports, the Site
// file's contacts summary and the Contacts & Defaults contact list. Up to 5 rows nothing changes (no box, no scrollbar); headers,
// filters and totals stay outside the scrolling part. Rendered to static markup (the measured height is applied in a browser).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import ScrollableList, { LIST_SCROLL_AFTER } from '../src/components/shared/ScrollableList';

const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const rows = (n: number) => Array.from({ length: n }, (_, i) => <div key={i}>Row {i + 1}</div>);
const render = (n: number) => renderToStaticMarkup(<ScrollableList count={n} label="Jobs at this building">{rows(n)}</ScrollableList>);

test('UP TO 5 ROWS: the rows are rendered as they are - no box, no scrollbar', () => {
  assert.equal(LIST_SCROLL_AFTER, 5);
  for (const n of [0, 1, 5]) {
    const html = render(n);
    assert.doesNotMatch(html, /overflow-y-auto|data-scroll-list/, String(n));
    assert.equal((html.match(/<div>Row /g) ?? []).length, n);
  }
});

test('MORE THAN 5: every row is kept, inside a scrolling region named for screen readers and reachable by keyboard', () => {
  const html = render(6);
  assert.match(html, /^<div data-scroll-list="true" role="region" aria-label="Jobs at this building \(scroll for more\)" tabindex="0" class="overflow-y-auto [^"]*max-h-\[320px\]/, 'scrolls; a fallback height until the real rows are measured');
  assert.equal((html.match(/<div>Row /g) ?? []).length, 6, 'nothing is hidden or dropped');
  assert.equal((render(40).match(/<div>Row /g) ?? []).length, 40);
});

test('HEIGHT: five whole rows plus half of the sixth (so it is clear there is more), from the real rows; re-measured on change and resize', () => {
  const code = src('src', 'components', 'shared', 'ScrollableList.tsx');
  assert.match(code, /const shown = rows\.slice\(0, maxItems\)\.reduce\(\(sum, row\) => sum \+ row\.offsetHeight, 0\);/);
  assert.match(code, /const peek = Math\.round\(\(rows\[maxItems\]\?\.offsetHeight \?\? 0\) \/ 2\);/);
  assert.match(code, /\}, \[scrolls, count, maxItems\]\);/);
  assert.match(code, /window\.addEventListener\('resize', measure\);\s+return \(\) => window\.removeEventListener\('resize', measure\);/);
});

test('WHERE: the four Building File lists use it - only their rows scroll (headers, filters, totals and notices stay visible)', () => {
  const page = src('src', 'pages', 'BuildingFilePage.tsx');
  const jobs = page.slice(page.indexOf('<ScrollableList count={buildingJobs.length} label="Jobs at this building">'));
  assert.ok(page.indexOf('<span>Service</span>') < page.indexOf('<ScrollableList count={buildingJobs.length}'), 'column titles above');
  assert.match(jobs, /^<ScrollableList[^>]*>\s+\{buildingJobs\.map\(\(job\) => \([\s\S]*?\)\)\}\s+<\/ScrollableList>\s+<div className="flex justify-between gap-3 bg-neutral-100/, 'yearly total below, outside');
  assert.match(page, /<ScrollableList count=\{contacts\.length\} label="Contacts">\s+\{contacts\.map\(\(c\) => \(/);
  assert.ok(page.indexOf('data-testid="defaults-summary"') < page.indexOf('<ScrollableList count={contacts.length}'), 'the defaults summary stays above');
  const reports = src('src', 'components', 'buildings', 'BuildingReportsPanel.tsx');
  assert.match(reports, /<ScrollableList count=\{available\.length\} label="Job reports">\s+\{available\.map\(\(entry\) => \{/);
  assert.ok(reports.indexOf('</ScrollableList>') < reports.indexOf('{notYetAvailable > 0 && ('), 'the "N more reports" note stays below, outside');
  const tab = src('src', 'components', 'buildings', 'ContactsAndDefaultsTab.tsx');
  assert.match(tab, /<ScrollableList count=\{shown\.length\} label="Contacts">\s+\{shown\.map\(\(c\) => \{/);
  assert.ok(tab.indexOf('aria-label="Filter contacts"') < tab.indexOf('<ScrollableList count={shown.length}'), 'the filter stays above');
});
