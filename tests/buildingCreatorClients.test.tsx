// New building (Nov 2026): the Client field lists the existing clients as soon as it is opened - the shared SearchableSelect (the
// same picker Schedule's day drawer uses) - instead of a search box that showed nothing until something was typed. Typing still
// narrows the list; choosing still shows the client with "Change"; "New client" is unchanged.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BuildingCreator from '../src/components/jobs/BuildingCreator';

Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
const noop = () => {};
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['clients'], [
    { id: 'c1', companyName: 'Acme Property' },
    { id: 'c2', companyName: 'Zenith Estates' },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <BuildingCreator onCreated={noop} onCancel={noop} />
    </QueryClientProvider>,
  );
}

test('CLIENT FIELD: the shared client picker, fed with every existing client', () => {
  const html = render();
  assert.match(html, /aria-label="Search for an existing client"[^>]*placeholder="Choose or search clients…"|placeholder="Choose or search clients…"[^>]*aria-label="Search for an existing client"/);
  const code = src('src', 'components', 'jobs', 'BuildingCreator.tsx');
  assert.match(code, /<SearchableSelect\s+value=\{form\.clientId\}\s+onChange=\{\(id\) => setForm\(\{ \.\.\.form, clientId: id \}\)\}\s+options=\{clients\.map\(\(c\) => \(\{ id: c\.id, label: c\.companyName \}\)\)\}/);
  assert.doesNotMatch(code, /if \(!q\) return \[\];/, 'the old "nothing until you type" filter is gone');
});

test('PICKER: opening it with nothing typed lists ALL options; typing narrows them; Change clears the choice', () => {
  const picker = src('src', 'components', 'shared', 'SearchableSelect.tsx');
  assert.match(picker, /if \(!q\) return options;/, 'empty query -> the full list');
  assert.match(picker, /\.filter\(\(o\) => `\$\{o\.label\} \$\{o\.sublabel \?\? ''\}`\.toLowerCase\(\)\.includes\(q\)\)/, 'typing narrows it');
  assert.match(picker, /onClick=\{\(\) => onChange\(''\)\}[^>]*>\s*Change/, 'Change clears the choice');
  // The list comes from the database in alphabetical order.
  assert.match(src('src', 'repository', 'clientsRepository.ts'), /\.from\('clients'\)\.select\('id, company_name'\)\.order\('company_name'\)/);
});

test('UNCHANGED: "Existing client" / "New client" toggle, and the existing-client building is still created for the chosen client', () => {
  const html = render();
  assert.match(html, />Existing client</);
  assert.match(html, />New client</);
  const code = src('src', 'components', 'jobs', 'BuildingCreator.tsx');
  assert.match(code, /const buildingId = await createBuilding\(form\.clientId, buildingFields\);/);
});
