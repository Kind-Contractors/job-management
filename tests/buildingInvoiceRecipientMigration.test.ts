// The building invoice recipient migration (supabase/migrations/20261110100000_building_invoice_recipient.sql) and its rollback:
// a building's Xero recipient is its own record (no person contact needed), shared freely between buildings, never guessed, set
// only by the server, and never reaching other buildings or invoices. (Its behaviour was also run against a real Postgres -
// migrate, every write path, rollback - before it was applied anywhere.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Line endings normalised: a Windows checkout may give the older migrations CRLF, and the comparisons below are by text.
const src = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const MIG = src('supabase', 'migrations', '20261110100000_building_invoice_recipient.sql');
const RB = src('supabase', 'rollbacks', '20261110100000_building_invoice_recipient.rollback.sql');
const code = (s: string) => s.replace(/^\s*--.*$/gm, '');
const between = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

test('MIGRATION: the four detail columns are added, nullable and additive; nothing dropped', () => {
  for (const c of ['default_invoice_xero_contact_name text', 'default_invoice_xero_contact_email text', 'default_invoice_set_at timestamptz', 'default_invoice_set_by text']) {
    assert.match(MIG, new RegExp(`alter table public\\.buildings add column if not exists ${c};`));
  }
  assert.doesNotMatch(code(MIG), /\bnot null default\b|drop column|drop table/i);
});

test('MIGRATION: the contact is optional; a recipient needs a Xero id, organisation and name; no uniqueness rule', () => {
  assert.match(MIG, /drop constraint if exists buildings_default_invoice_recipient_all_or_none;/);
  const rule = between(MIG, 'add constraint buildings_default_invoice_recipient_complete', ');');
  assert.match(rule, /default_invoice_contact_id is null and default_invoice_xero_contact_id is null and default_invoice_xero_org_id is null/);
  assert.match(rule, /nullif\(btrim\(coalesce\(default_invoice_xero_contact_id, ''\)\), ''\) is not null\s+and nullif\(btrim\(coalesce\(default_invoice_xero_org_id, ''\)\), ''\) is not null\s+and nullif\(btrim\(coalesce\(default_invoice_xero_contact_name, ''\)\), ''\) is not null/);
  assert.doesNotMatch(rule, /default_invoice_contact_id is not null/, 'a contact is no longer required');
  assert.doesNotMatch(code(MIG), /unique|create (unique )?index/i, 'the same Xero contact may be shared by any number of buildings');
});

test('MIGRATION: existing defaults keep everything; only the name is copied from their own contact; nothing is guessed', () => {
  const backfill = between(MIG, 'update public.buildings b', ';');
  assert.match(backfill, /set default_invoice_xero_contact_name = c\.xero_contact_name\s+from public\.contacts c\s+where c\.id = b\.default_invoice_contact_id/);
  assert.doesNotMatch(code(MIG), /\bemail\b\s*(=|ilike|like)\s*[^>]|invoice_details\s*(=|ilike|like)/i, 'no matching by email or by invoice details text');
  assert.doesNotMatch(code(MIG), /update (public\.)?(contacts|invoices|jobs|visits|reports)\b/i, 'contacts and invoices are never written');
});

test('TRIGGER: contact-less recipients only through the server gate; "when / who" stamped by the database, never by the writer', () => {
  const fn = between(MIG, 'create or replace function public.buildings_invoice_recipient_details()', 'drop trigger if exists buildings_invoice_recipient_details');
  assert.match(fn, /v_via_function boolean := coalesce\(current_setting\('app\.building_invoice_recipient_write', true\), ''\) = 'on';/);
  assert.match(fn, /if not v_via_function and v_touched and \(v_new_contactless or v_old_contactless\) then\s+raise exception 'building_invoice_recipient_server_only:/);
  // a different recipient = another Xero id, organisation or contact - never judged by name or email
  assert.match(fn, /v_changed := new\.default_invoice_xero_contact_id is distinct from old\.default_invoice_xero_contact_id\s+or new\.default_invoice_xero_org_id is distinct from old\.default_invoice_xero_org_id\s+or new\.default_invoice_contact_id is distinct from old\.default_invoice_contact_id;/);
  assert.match(fn, /if v_changed then\s+new\.default_invoice_set_at := now\(\);\s+new\.default_invoice_set_by := case\s+when v_via_function then nullif\(btrim\(coalesce\(current_setting\('app\.building_invoice_recipient_actor', true\), ''\)\), ''\)\s+else nullif\(auth\.jwt\(\) ->> 'email', ''\)\s+end;\s+elsif tg_op = 'UPDATE' then\s+new\.default_invoice_set_at := old\.default_invoice_set_at;\s+new\.default_invoice_set_by := old\.default_invoice_set_by;/);
  assert.doesNotMatch(fn, /coalesce\(new\.default_invoice_set_(at|by)/, 'the writer\'s value is never used');
  assert.match(fn, /if new\.default_invoice_xero_contact_id is null then\s+new\.default_invoice_xero_contact_name := null;\s+new\.default_invoice_xero_contact_email := null;\s+new\.default_invoice_set_at := null;\s+new\.default_invoice_set_by := null;/);
  assert.match(fn, /if new\.default_invoice_contact_id is not null then\s+select c\.xero_contact_name into new\.default_invoice_xero_contact_name\s+from public\.contacts c where c\.id = new\.default_invoice_contact_id;\s+new\.default_invoice_xero_contact_email := null;/);
});

test('FUNCTIONS: set / clear are server-only, check the contact AND organisation the manager saw, and close the gate after their update', () => {
  assert.match(MIG, /revoke all on function public\.set_building_invoice_recipient\(uuid, text, text, text, text, text, text, text\) from public, anon, authenticated;/);
  assert.match(MIG, /revoke all on function public\.clear_building_invoice_recipient\(uuid, text, text\) from public, anon, authenticated;/);
  assert.match(MIG, /grant execute on function public\.set_building_invoice_recipient\(uuid, text, text, text, text, text, text, text\) to service_role;/);
  assert.match(MIG, /grant execute on function public\.clear_building_invoice_recipient\(uuid, text, text\) to service_role;/);
  assert.doesNotMatch(between(MIG, 'create or replace function public.set_building_invoice_recipient(', '$$;\n\ncreate or replace function public.clear'), /security definer/);
  for (const name of ['set_building_invoice_recipient', 'clear_building_invoice_recipient']) {
    const fn = between(MIG, `create or replace function public.${name}(`, '\n$$;');
    // A recipient is its Xero contact id AND organisation: both must still be what the manager saw.
    assert.match(fn, /p_expected_current_xero_contact_id text,\s+p_expected_current_xero_org_id text\s+\)/);
    assert.match(fn, /select default_invoice_xero_contact_id, default_invoice_xero_org_id into v_current_id, v_current_org\s+from buildings where id = p_building_id for update;/);
    assert.match(fn, /if v_current_id is distinct from nullif\(btrim\(coalesce\(p_expected_current_xero_contact_id, ''\)\), ''\)\s+or v_current_org is distinct from nullif\(btrim\(coalesce\(p_expected_current_xero_org_id, ''\)\), ''\) then\s+raise exception 'building_invoice_recipient_changed:/);
    assert.ok(fn.indexOf('building_invoice_recipient_changed') < fn.indexOf('update buildings'), 'checked before anything is written');
    assert.match(fn, /perform set_config\('app\.building_invoice_recipient_write', 'on', true\);(\s+perform set_config\('app\.building_invoice_recipient_actor', btrim\(p_actor\), true\);)?\s+update buildings[\s\S]*?where id = p_building_id;\s+perform set_config\('app\.building_invoice_recipient_write', '', true\);/);
  }
});

test('MIGRATION: the other guards and the invoice lock are left as they are', () => {
  assert.doesNotMatch(code(MIG), /function public\.buildings_default_recipient_guard|contacts_xero_link_guard|invoices_xero_recipient_lock/, 'not redefined');
});

test('MIGRATION: change_building_client differs only in what counts as cleared and the gate around its update', () => {
  const pick = (s: string) => between(s, 'create or replace function public.change_building_client(\n', '$$;');
  const before = pick(src('supabase', 'migrations', '20261023100000_building_client_history.sql'));
  const after = pick(MIG);
  assert.match(after, /v_cleared := v_building\.default_invoice_xero_contact_id is not null or v_building\.default_invoice_contact_id is not null;\s+perform set_config\('app\.building_invoice_recipient_write', 'on', true\);\s+update buildings/);
  assert.match(after, /where id = p_building_id;\s+perform set_config\('app\.building_invoice_recipient_write', '', true\);\s+insert into building_client_history/);
  const strip = (s: string) => code(s).replace(/^\s*v_cleared := .*$/m, '').replace(/^\s*perform set_config\('app\.building_invoice_recipient_write'.*$/gm, '').replace(/\s+/g, ' ');
  assert.equal(strip(after), strip(before));
});

test('ROLLBACK: kept out of migrations, refuses first while a contact-less recipient exists, restores the original exactly', () => {
  assert.match(RB, /raise exception 'rollback_refused: % building\(s\) have an invoice recipient chosen without a contact/);
  assert.ok(RB.indexOf('rollback_refused') < RB.indexOf('drop trigger'), 'checked before anything changes');
  for (const f of ['buildings_invoice_recipient_details()', 'set_building_invoice_recipient(uuid, text, text, text, text, text, text, text)', 'clear_building_invoice_recipient(uuid, text, text)']) {
    assert.ok(RB.includes(`drop function if exists public.${f};`), f);
  }
  assert.match(RB, /add constraint buildings_default_invoice_recipient_all_or_none check \(/);
  const original = between(src('supabase', 'migrations', '20261023100000_building_client_history.sql'), 'create or replace function public.change_building_client(\n', '$$;');
  assert.ok(RB.includes(original), 'change_building_client restored verbatim');
  assert.match(RB, /^begin;$/m);
  assert.match(RB, /^commit;\s*$/m);
});

test('DOCS: MIGRATION_README documents supabase/rollbacks/ - hand-run only, refuses before changing, code first, then mark the migration reverted', () => {
  const readme = src('supabase', 'migrations', 'MIGRATION_README.md');
  const section = readme.slice(readme.indexOf('## `supabase/rollbacks/`'), readme.indexOf('## Known outstanding gap'));
  assert.ok(section.length > 200, 'the section exists, before "Known outstanding gap"');
  assert.match(section, /`supabase db push`[^.]*only ever reads\s+`supabase\/migrations\/`/);
  assert.match(section, /\*\*Run by hand, as one transaction\*\*/);
  assert.match(section, /supabase migration repair --status reverted\s+<version>/);
  assert.match(section, /\*\*`20261110100000_building_invoice_recipient\.rollback\.sql`\*\*/);
  assert.match(section, /Refuses while any building has a recipient chosen without a person contact/);
  assert.match(readme, /A fourth folder,\s+`supabase\/rollbacks\/`, holds hand-run undo scripts that no tool ever applies/);
});
