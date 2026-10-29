// RecipientSelect: the recipient dropdown that can colour PART of an option (only the warning words amber). Rendered to static
// markup (no DOM library here); keyboard handling is checked from the source and in a real browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import RecipientSelect, { type RecipientOption } from '../src/components/shared/RecipientSelect';

const OPTIONS: RecipientOption[] = [
  { value: '', text: 'Choose a recipient…', disabled: true },
  { value: 'a', text: 'Sam — sam@client.test', note: { text: 'Xero: Sam Ltd' } },
  { value: 'b', text: 'Pat — pat@client.test', note: { text: 'not linked to Xero yet', warn: true } },
];
const render = (value: string, extra: Partial<{ disabled: boolean }> = {}) =>
  renderToStaticMarkup(<RecipientSelect label="Send invoice to" value={value} onChange={() => {}} options={OPTIONS} {...extra} />);

test('A select-only combobox with a listbox, named by its heading; closed to start with, every option still in the page', () => {
  const html = render('');
  assert.match(html, /<button type="button" role="combobox" aria-label="Send invoice to" aria-haspopup="listbox" aria-expanded="false" aria-controls="[^"]+"/);
  assert.match(html, /<ul [^>]*role="listbox" aria-label="Send invoice to" hidden=""/);
  assert.equal((html.match(/role="option"/g) ?? []).length, 3);
});

test('Only the warning words are amber; the main text and plain notes keep the normal colour', () => {
  const html = render('');
  assert.match(html, /data-value="b"[^>]*><span>Pat — pat@client\.test<\/span><span class="text-due-fg"> · not linked to Xero yet<\/span><\/li>/);
  assert.match(html, /data-value="a"[^>]*><span>Sam — sam@client\.test<\/span><span> · Xero: Sam Ltd<\/span><\/li>/);
});

test('The closed box shows the chosen option the same way; the chosen option is marked selected; disabled options are marked', () => {
  const html = render('b');
  assert.match(html, /role="combobox"[^>]*><span class="min-w-0 flex-1 truncate"><span>Pat — pat@client\.test<\/span><span class="text-due-fg"> · not linked to Xero yet<\/span><\/span>/);
  assert.match(html, /data-value="b" aria-selected="true"/);
  assert.match(html, /data-value="a" aria-selected="false"/);
  assert.match(html, /data-value="" aria-selected="false" aria-disabled="true"/);
  assert.match(render('', { disabled: true }), /role="combobox"[^>]*disabled=""/);
});

test('Keyboard and mouse: like a select - open with Enter / Space / arrows, move with arrows / Home / End, Enter chooses, Escape closes', () => {
  const code = readFileSync(join(process.cwd(), 'src', 'components', 'shared', 'RecipientSelect.tsx'), 'utf8');
  assert.match(code, /if \(\['Enter', ' ', 'ArrowDown', 'ArrowUp'\]\.includes\(e\.key\)\)/);
  assert.match(code, /Escape: \(\) => setOpen\(false\),/);
  assert.match(code, /if \(e\.key === 'Escape'\) e\.stopPropagation\(\);/, 'Escape closes the list, not a dialog around it');
  assert.match(code, /ArrowDown: \(\) => setActive\(\(a\) => step\(a, 1\)\),/);
  assert.match(code, /setUpwards\(below < wanted && box\.top > below\);/, 'opens upwards when there is no room below');
  assert.match(code, /if \(!o \|\| o\.disabled\) return;/, 'a disabled option cannot be chosen');
  assert.match(code, /onMouseDown=\{\(e\) => \{\s+e\.preventDefault\(\);[^\n]*\n\s+choose\(i\);/, 'a click chooses (focus stays on the box)');
  assert.match(code, /document\.addEventListener\('mousedown', onDown\);\s+return \(\) => document\.removeEventListener\('mousedown', onDown\);/, 'a click outside closes it');
  assert.match(code, /if \(o\.value !== value\) onChange\(o\.value\);/, 'choosing the same option again changes nothing');
});
