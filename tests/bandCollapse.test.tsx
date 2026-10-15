// Collapsing a client/frequency band on All Live Jobs and the Monthly Plan.
//
// AG Grid Community has no row grouping, so the banded look is a flat array of band + job blocks and collapsing
// is a filter over that array (`collapseBlocks`). What matters is that it is a VIEW state: every row is still
// derived, every band keeps its real count and its totals, and nothing about the data changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildGridBlocks, collapseBlocks, type GridBlock } from '../src/lib/grouping';
import GridBandRow from '../src/components/jobs/GridBandRow';
import type { JobRow } from '../src/domain/types';

const job = (id: string, clientId: string, over: Partial<JobRow> = {}): JobRow =>
  ({
    id, clientId, clientName: `Client ${clientId}`, buildingId: `b-${id}`, buildingName: `Building ${id}`,
    jobSummary: 'Communal cleaning', division: 'General', frequency: 'Monthly', frequencyRaw: 'Monthly',
    frequencyType: 'monthly', pricePerVisit: 100, yearlyValue: 1200, monthlyValue: 100,
    clientInvoiceAddress: '1 Test Way', visits: [], schedule: null, serviceEndsOn: null, ...over,
  }) as unknown as JobRow;

const ROWS = [job('a', 'c1'), job('b', 'c1'), job('c', 'c2')];
const bandIdOf = (blocks: GridBlock[], i = 0) => blocks.filter((b) => b.kind === 'band')[i].id;

// ---- the derivation ------------------------------------------------------------------------------------------
test('BUILD: every band reports how many jobs it holds', () => {
  const blocks = buildGridBlocks(ROWS, 'client');
  const bands = blocks.filter((b) => b.kind === 'band');
  assert.deepEqual(bands.map((b) => (b as Extract<GridBlock, { kind: 'band' }>).rowCount), [2, 1]);
  assert.equal(blocks.filter((b) => b.kind === 'row').length, 3);
});

test('COLLAPSE hides only that band’s rows, and leaves every other block exactly as it was', () => {
  const blocks = buildGridBlocks(ROWS, 'client');
  const first = bandIdOf(blocks, 0);
  const out = collapseBlocks(blocks, new Set([first]));

  assert.equal(out.filter((b) => b.kind === 'band').length, 2, 'both bands still shown');
  assert.deepEqual(out.filter((b) => b.kind === 'row').map((b) => b.id), ['c'], 'only the other band’s job remains');

  const collapsedBand = out.find((b) => b.kind === 'band' && b.id === first) as Extract<GridBlock, { kind: 'band' }>;
  assert.equal(collapsedBand.collapsed, true);
  assert.equal(collapsedBand.rowCount, 2, 'it still reports the jobs it holds');
  const openBand = out.find((b) => b.kind === 'band' && b.id !== first) as Extract<GridBlock, { kind: 'band' }>;
  assert.equal(openBand.collapsed, undefined, 'an untouched band is returned exactly as it came in');
});

test('COLLAPSING EVERY BAND leaves the bands and no rows — never an empty screen', () => {
  const blocks = buildGridBlocks(ROWS, 'client');
  const all = new Set(blocks.filter((b) => b.kind === 'band').map((b) => b.id));
  const out = collapseBlocks(blocks, all);
  assert.equal(out.filter((b) => b.kind === 'band').length, 2);
  assert.equal(out.filter((b) => b.kind === 'row').length, 0);
});

test('NOTHING COLLAPSED returns the very same array — no needless re-render', () => {
  const blocks = buildGridBlocks(ROWS, 'client');
  assert.equal(collapseBlocks(blocks, new Set()), blocks);
});

test('AN UNKNOWN band id changes nothing (e.g. a stale id after re-grouping)', () => {
  const blocks = buildGridBlocks(ROWS, 'client');
  assert.deepEqual(collapseBlocks(blocks, new Set(['band-client-nope'])), blocks);
});

test('TOTALS are untouched by collapsing — a shut band still tells the truth about its value', () => {
  const blocks = buildGridBlocks(ROWS, 'client');
  const before = blocks.filter((b) => b.kind === 'band').map((b) => (b as Extract<GridBlock, { kind: 'band' }>).rightLabel);
  const after = collapseBlocks(blocks, new Set([bandIdOf(blocks, 0)]))
    .filter((b) => b.kind === 'band')
    .map((b) => (b as Extract<GridBlock, { kind: 'band' }>).rightLabel);
  assert.deepEqual(after, before);
});

test('IT WORKS THE SAME when grouped by frequency', () => {
  const blocks = buildGridBlocks([job('a', 'c1'), job('b', 'c1', { frequency: 'Weekly' })], 'frequency');
  const out = collapseBlocks(blocks, new Set([bandIdOf(blocks, 0)]));
  assert.equal(out.filter((b) => b.kind === 'row').length, 1);
});

// ---- the band row itself --------------------------------------------------------------------------------------
const band = (over: Partial<Extract<GridBlock, { kind: 'band' }>> = {}): GridBlock => ({
  kind: 'band', id: 'band-client-c1', title: 'ABC Client', subtitle: 'Invoice · 1 Test Way',
  rightLabel: '1 building · 2 jobs · £2,400/yr', rowCount: 2, ...over,
});

// GridBandRow is an AG Grid cell renderer; only `data` and `context` matter here, so the rest of
// ICellRendererParams is cast away rather than stubbed out field by field.
const renderBand = (data: GridBlock, context: unknown = { onToggleBand: () => {} }) =>
  renderToStaticMarkup(<GridBandRow {...({ data, context } as unknown as Parameters<typeof GridBandRow>[0])} />);

test('BAND ROW: the caret is a real button that says what it will do', () => {
  const html = renderBand(band());
  assert.match(html, /<button[^>]*aria-expanded="true"/);
  assert.match(html, /aria-label="Collapse ABC Client"/);
  assert.match(html, /ABC Client/);
});

test('BAND ROW when collapsed: the caret turns, the label flips, and it says what is hidden', () => {
  const html = renderBand(band({ collapsed: true }));
  assert.match(html, /<button[^>]*aria-expanded="false"/);
  assert.match(html, /aria-label="Expand ABC Client"/);
  assert.match(html, /-rotate-90/, 'the caret points right when shut');
  assert.match(html, /2 jobs hidden/);
  assert.match(html, /1 building · 2 jobs · £2,400\/yr/, '...and the real totals are still shown');
});

test('BAND ROW singularises the hidden count', () => {
  assert.match(renderBand(band({ collapsed: true, rowCount: 1 })), /1 job hidden/);
});

test('BAND ROW without a toggle (no context) disables the control rather than offering a dead one', () => {
  const html = renderBand(band(), {});
  assert.match(html, /<button[^>]*disabled=""/);
  assert.doesNotMatch(html, /cursor-pointer hover:bg-neutral-300/, 'and the row is not dressed as clickable');
});
