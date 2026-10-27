// Breadcrumbs (Building File only, first pass): Buildings › client › building. Buildings links to the list; the client is plain
// text (there is no client page); the building is the current page. Rendered to static markup inside a router (no DOM library here).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import Breadcrumbs, { type BreadcrumbItem } from '../src/components/shell/Breadcrumbs';

const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const render = (items: BreadcrumbItem[]) =>
  decode(
    renderToStaticMarkup(
      <MemoryRouter>
        <Breadcrumbs items={items} />
      </MemoryRouter>,
    ),
  );
const page = () => readFileSync(join(process.cwd(), 'src', 'pages', 'BuildingFilePage.tsx'), 'utf8');
const TRAIL: BreadcrumbItem[] = [{ label: 'Buildings', to: '/buildings' }, { label: 'ABC Client' }, { label: 'Flair' }];

test('MARKUP: a labelled nav landmark with an ordered list, one item per level', () => {
  const html = render(TRAIL);
  assert.match(html, /^<nav aria-label="Breadcrumb"><ol[^>]*>/);
  assert.equal((html.match(/<li /g) ?? []).length, 3);
});

test('LEVELS: Buildings links to /buildings; the client is plain text; the building is the current page, not a link', () => {
  const html = render(TRAIL);
  assert.match(html, /<a [^>]*href="\/buildings"[^>]*>Buildings<\/a>/);
  assert.equal((html.match(/<a /g) ?? []).length, 1, 'only Buildings is a link');
  assert.match(html, /<span title="ABC Client"[^>]*>ABC Client<\/span>/);
  assert.match(html, /<span aria-current="page" title="Flair"[^>]*>Flair<\/span>/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test('SEPARATORS: shown between levels only, hidden from screen readers', () => {
  const html = render(TRAIL);
  assert.equal((html.match(/<span aria-hidden="true"[^>]*>›<\/span>/g) ?? []).length, 2);
  assert.doesNotMatch(html.slice(0, html.indexOf('Buildings')), /›/, 'nothing before the first level');
});

test('MISSING CLIENT: an empty level is left out (no empty or broken item)', () => {
  const html = render([{ label: 'Buildings', to: '/buildings' }, { label: '' }, { label: 'Flair' }]);
  assert.equal((html.match(/<li /g) ?? []).length, 2);
  assert.equal((html.match(/›/g) ?? []).length, 1);
  assert.match(html, /<span aria-current="page"[^>]*>Flair<\/span>/);
  assert.equal((render([{ label: 'Buildings', to: '/buildings' }, { label: '   ' }, { label: 'Flair' }]).match(/<li /g) ?? []).length, 2);
});

test('LONG NAMES: cut with an ellipsis, the full name in the tooltip; the trail wraps on narrow screens', () => {
  const long = 'A very long building name that would otherwise push the page sideways on a phone';
  const html = render([{ label: 'Buildings', to: '/buildings' }, { label: long }]);
  assert.match(html, new RegExp(`title="${long}" class="[^"]*truncate`));
  assert.match(html, /<ol class="[^"]*flex-wrap/);
});

test('PAGE: every state of the Building File uses the breadcrumbs; the old back links are gone', () => {
  const p = page();
  assert.match(p, /<Breadcrumbs items=\{\[\{ label: 'Buildings', to: '\/buildings' \}, \{ label: '…' \}\]\} \/>/, 'loading');
  assert.match(p, /<Breadcrumbs items=\{\[\{ label: 'Buildings', to: '\/buildings' \}, \{ label: "Couldn't load" \}\]\} \/>/, 'load error');
  assert.match(p, /<Breadcrumbs items=\{\[\{ label: 'Buildings', to: '\/buildings' \}, \{ label: 'Building not found' \}\]\} \/>/, 'not found');
  assert.match(p, /\{ label: building\.clientName \?\? '' \}, \{ label: building\.buildingName \|\| 'Building' \}/, 'loaded');
  assert.doesNotMatch(p, /Back to Buildings|navigate\('\/buildings'\)/, 'no duplicate back link');
  assert.equal((p.match(/<Breadcrumbs/g) ?? []).length, 4);
});

test('SCOPE: breadcrumbs are on the Building File only (no other page imports them)', () => {
  const pages = readdirSync(join(process.cwd(), 'src', 'pages')).filter((f: string) => f.endsWith('.tsx'));
  const users = pages.filter((f: string) => readFileSync(join(process.cwd(), 'src', 'pages', f), 'utf8').includes('<Breadcrumbs'));
  assert.deepEqual(users, ['BuildingFilePage.tsx']);
});
