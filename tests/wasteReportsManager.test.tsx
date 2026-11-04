// Luke's side of waste reports: the list filters sent to the database, the detail screen (photos, videos, sent mark, archive,
// history), the waste PDF (its wording, photos and clickable video links) - and proof that the client service report PDF is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { escapeLike, listWasteReports, type WasteReportDetail } from '../src/repository/wasteReportsRepository';
import WasteReportDetailPanel from '../src/components/waste/WasteReportDetailPanel';
import { WasteReportRow } from '../src/pages/WasteReportsPage';
import { buildWasteReportModel, generateWasteReportPdf, singleLineAddress, wasteReportLayout, wasteReportPdfFileName, formatWasteWorkDates } from '../src/lib/wasteReportPdf';
import { generateClientReportPdf, serviceReportLayout } from '../src/lib/clientReportPdf';
import type { ClientReportModel } from '../src/lib/clientReportModel';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ---- list filters --------------------------------------------------------------------------------------------------------------
test('list: address search is matched literally; work dates overlap the range; each state filter', async () => {
  const urls: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    urls.push(new URL(typeof input === 'string' ? input : input.url));
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
    await listWasteReports({ search: ' High St ', from: '2026-10-01', to: '2026-10-31', status: 'active' });
    let p = urls.at(-1)!.searchParams;
    assert.equal(p.get('address'), 'ilike.%High St%');
    assert.equal(p.get('work_end_date'), 'gte.2026-10-01');
    assert.equal(p.get('work_start_date'), 'lte.2026-10-31');
    assert.equal(p.get('archived_at'), 'is.null');
    assert.equal(p.get('order'), 'submitted_at.desc');
    await listWasteReports({ search: '', from: '', to: '', status: 'unsent' });
    p = urls.at(-1)!.searchParams;
    assert.equal(p.get('sent_to_client_at'), 'is.null');
    assert.equal(p.get('address'), null);
    await listWasteReports({ search: '', from: '', to: '', status: 'sent' });
    assert.equal(urls.at(-1)!.searchParams.get('sent_to_client_at'), 'not.is.null');
    await listWasteReports({ search: '', from: '', to: '', status: 'archived' });
    assert.equal(urls.at(-1)!.searchParams.get('archived_at'), 'not.is.null');
    await listWasteReports({ search: '', from: '', to: '', status: 'all' });
    assert.equal(urls.at(-1)!.searchParams.get('archived_at'), null, '"All" includes archived reports');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- detail screen ---------------------------------------------------------------------------------------------------------------
const report: WasteReportDetail = {
  id: 'r1',
  address: '12 High Street\nLeeds LS1 1AA',
  startDate: '2026-10-31',
  endDate: '2026-11-01',
  submittedAt: '2026-11-02T09:30:00Z',
  reporterName: 'Jack',
  photoCount: 2,
  videoCount: 1,
  sentAt: null,
  sentBy: null,
  archivedAt: null,
  archivedBy: null,
  description: 'Cleared garden waste - 2 loads.',
  media: [
    { id: 'p1', kind: 'photo', phase: 'before', storagePath: 'u/r1/before/p1.jpg', thumbnailPath: null, mimeType: 'image/jpeg', sizeBytes: 10, durationSeconds: null, sortOrder: 0 },
    { id: 'p2', kind: 'photo', phase: 'after', storagePath: 'u/r1/after/p2.jpg', thumbnailPath: null, mimeType: 'image/jpeg', sizeBytes: 10, durationSeconds: null, sortOrder: 1 },
    { id: 'v1', kind: 'video', phase: 'after', storagePath: 'u/r1/after/v1.mp4', thumbnailPath: 'u/r1/after/v1.thumb.jpg', mimeType: 'video/mp4', sizeBytes: 10, durationSeconds: 42, sortOrder: 2 },
  ],
  events: [
    { id: 'e2', type: 'marked_sent', actor: 'Luke', occurredAt: '2026-11-02T11:00:00Z' },
    { id: 'e1', type: 'submitted', actor: 'Jack', occurredAt: '2026-11-02T09:30:00Z' },
  ],
};
const panel = (r: WasteReportDetail) =>
  renderToStaticMarkup(
    <WasteReportDetailPanel
      report={r}
      urls={{ 'u/r1/before/p1.jpg': 'blob:p1', 'u/r1/after/v1.thumb.jpg': 'blob:t1' }}
      urlsLoading={false}
      onPlay={async () => 'blob:v'}
      busy={null}
      error={null}
      onViewPdf={() => {}}
      onDownloadPdf={() => {}}
      onSetSent={() => {}}
      onSetArchived={() => {}}
    />,
  );

test('detail: address, dates, who and when; Before/After photos and a playable video; PDF buttons; history newest first', () => {
  const html = panel(report);
  assert.match(html, /12 High Street\nLeeds LS1 1AA/);
  assert.match(html, /31 Oct – 1 Nov 2026 · by Jack · submitted 2 Nov 2026, 09:30/);
  assert.match(html, /Before · 1 photo, 0 videos/);
  assert.match(html, /After · 1 photo, 1 video/);
  assert.match(html, /src="blob:p1"/);
  assert.match(html, /Unavailable/, 'a photo without a URL shows a placeholder');
  assert.match(html, /aria-label="Play after video"/);
  assert.match(html, /0:42/);
  assert.match(html, /View PDF/);
  assert.match(html, /Download PDF/);
  assert.ok(html.indexOf('Marked as sent to the client') < html.indexOf('Submitted<'), 'history newest first');
  assert.match(html, /Not marked as sent to the client/);
  assert.match(html, />Mark as sent</);
  assert.match(html, />Archive</);
});

test('detail: sent and archived states say by whom and when, offer Unmark / Restore, and say archived links still work', () => {
  const html = panel({ ...report, sentAt: '2026-11-02T11:00:00Z', sentBy: 'Luke', archivedAt: '2026-11-03T08:00:00Z', archivedBy: 'Luke' });
  assert.match(html, /Sent to the client.*marked 2 Nov 2026, 11:00 by Luke/s);
  assert.match(html, />Unmark</);
  assert.match(html, /Archived.*3 Nov 2026, 08:00 by Luke\. Its video links still work\./s);
  assert.match(html, />Restore</);
});

test('list row: one-line address, work dates, counts and its state', () => {
  const r = (over: object) => renderToStaticMarkup(<WasteReportRow row={{ ...report, ...over }} selected={false} onSelect={() => {}} />);
  assert.match(r({}), /12 High Street, Leeds LS1 1AA/);
  assert.match(r({}), /31 Oct – 1 Nov 2026 · 2 photos · 1 video/);
  assert.match(r({}), /Not sent/);
  assert.match(r({ sentAt: 'x' }), />Sent</);
  assert.match(r({ sentAt: 'x', archivedAt: 'y' }), /Archived/);
});

// ---- PDF ---------------------------------------------------------------------------------------------------------------------------
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('waste PDF model: client-safe facts only (address on one line, dates, description, media); no ids, paths or reporter', () => {
  const m = buildWasteReportModel(report, { 'u/r1/before/p1.jpg': 'https://signed/p1', 'u/r1/after/p2.jpg': 'https://signed/p2' }, { 'u/r1/after/v1.thumb.jpg': 'https://signed/t1' });
  assert.equal(m.buildingName, '12 High Street, Leeds LS1 1AA');
  assert.equal(m.jobSummary, 'Waste removal');
  assert.equal(m.visitDateLabel, '31 Oct – 1 Nov 2026');
  assert.equal(m.workCarriedOut, 'Cleared garden waste - 2 loads.');
  assert.deepEqual(m.photos.map((p) => p.phase), ['before', 'after']);
  assert.deepEqual(m.videos, [{ id: 'v1', phase: 'after', durationLabel: '0:42', thumbnailUrl: 'https://signed/t1' }]);
  assert.doesNotMatch(JSON.stringify(m), /Jack|u\/r1/);
  assert.deepEqual(wasteReportLayout(report), {
    documentTitle: 'Waste removal report',
    runningTitle: 'WASTE REMOVAL REPORT',
    subtitle: null,
    facts: [['Started', '31 Oct 2026'], ['Finished', '1 Nov 2026']],
    showSpecStatus: false,
  });
  assert.deepEqual(wasteReportLayout({ startDate: '2026-11-01', endDate: '2026-11-01' }).facts, [['Work date', '1 Nov 2026']]);
  assert.equal(wasteReportPdfFileName({ address: '12 High St / Flat 3\nLeeds', endDate: '2026-11-01' }), 'Waste report - 12 High St Flat 3, Leeds - 2026-11-01.pdf');
  assert.equal(singleLineAddress('  a \n\n b '), 'a, b');
  assert.equal(formatWasteWorkDates('2026-12-31', '2027-01-02'), '31 Dec 2026 – 2 Jan 2027');
});

test('waste PDF: its own wording, no specification card or "Prepared for", the photos, and a clickable link per video', async () => {
  const model = buildWasteReportModel(report, {}, {});
  const blob = await generateWasteReportPdf(report, {
    model,
    photos: { photos: [{ id: 'p1', phase: 'before', image: { dataUrl: JPEG, width: 1, height: 1 } }, { id: 'p2', phase: 'after', image: { dataUrl: JPEG, width: 1, height: 1 } }], skippedCount: 0 },
    videos: { videos: [{ id: 'v1', phase: 'after', durationLabel: '0:42', url: 'https://x.test/functions/v1/watch-waste-video?t=TOKEN123', thumbnail: null }], thumbnailsMissing: 1 },
    skippedPhotos: 0,
  });
  const pdf = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.match(pdf, /\(Waste removal report\)/);
  assert.match(pdf, /\(Started\)[\s\S]*\(31 Oct 2026\)[\s\S]*\(Finished\)[\s\S]*\(1 Nov 2026\)/, 'both dates, in full');
  assert.doesNotMatch(pdf, /\.\.\.\) Tj/, 'nothing in the PDF is cut off');
  assert.match(pdf, /\(Before and after\)/);
  assert.match(pdf, /\(Watch video\)/);
  assert.match(pdf, /\/URI \(https:\/\/x\.test\/functions\/v1\/watch-waste-video\?t=TOKEN123\)/);
  assert.doesNotMatch(pdf, /Service report|Prepared for|Specification completed/);
});

test('the client service report PDF is unchanged: no layout = its own wording, identical to passing serviceReportLayout', async () => {
  const model: ClientReportModel = {
    clientName: 'ZZ Client', buildingName: 'Oak Court', jobSummary: 'Window Cleaning', visitDateLabel: '15 Sep 2026', workCarriedOut: 'Cleaned.', notes: 'Rear gate.', issues: 'Cracked pane.', specMet: false, photos: [], videos: [],
  };
  const photos = { photos: [{ id: 'p1', phase: 'before' as const, image: { dataUrl: JPEG, width: 1, height: 1 } }], skippedCount: 0 };
  const norm = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString('latin1').replace(/\/CreationDate \(D:[^)]*\)/g, '').replace(/\/ID \[ <[0-9A-Fa-f]+> <[0-9A-Fa-f]+> \]/g, '');
  const plain = await norm(await generateClientReportPdf(model, photos));
  const explicit = await norm(await generateClientReportPdf(model, photos, undefined, serviceReportLayout(model)));
  assert.equal(plain, explicit);
  assert.match(plain, /\(Service report\)/);
  assert.match(plain, /\(Prepared for ZZ Client\)/);
  assert.match(plain, /\(Visit date\)/);
  assert.match(plain, /Part of the specification was not fully completed\./);
  assert.match(plain, /\(S E R V I C E|SERVICE REPORT|\(Oak Court\)/);
});

// ---- the migration -----------------------------------------------------------------------------------------------------------------
const sql = read('supabase/migrations/20261103110000_waste_reports_manager.sql');

test('migration: sent / archive are manager-only, record who and when, log an event, and repeating them changes nothing', () => {
  for (const fn of ['manager_waste_set_sent', 'manager_waste_set_archived']) {
    const body = sql.slice(sql.indexOf(`create or replace function public.${fn}`));
    assert.match(body, /if private\.current_app_role\(\) is distinct from 'manager' then\s*raise exception 'Not authorized\.';/);
    assert.match(body, /for update;/);
  }
  assert.match(sql, /if p_sent and v_row\.sent_to_client_at is null then[\s\S]*?sent_to_client_by = v_by, sent_to_client_by_user_id = auth\.uid\(\)[\s\S]*?'marked_sent'/);
  assert.match(sql, /elsif not p_sent and v_row\.sent_to_client_at is not null then[\s\S]*?'unmarked_sent'/);
  assert.match(sql, /if p_archived and v_row\.archived_at is null then[\s\S]*?'archived'/);
  assert.match(sql, /elsif not p_archived and v_row\.archived_at is not null then[\s\S]*?'restored'/);
  assert.match(sql, /revoke execute on function public\.manager_waste_set_sent\(uuid, boolean\) from public, anon;/);
});

test('migration: links are their own table (hash only, manager read-only), resolve is service-role only and ignores archiving', () => {
  assert.match(sql, /create table public\.waste_video_links \(/);
  assert.match(sql, /constraint waste_video_links_hash_check check \(octet_length\(token_hash\) = 32\)/);
  assert.match(sql, /expires_at <= created_at \+ interval '731 days'/);
  assert.match(sql, /revoke all on public\.waste_video_links from anon, authenticated;\s*grant select on public\.waste_video_links to authenticated;/);
  assert.doesNotMatch(sql, /create policy \w+ on public\.waste_video_links for (insert|update|delete|all)/);
  assert.match(sql, /revoke execute on function public\.resolve_waste_video_link\(bytea\) from public, anon, authenticated;\s*grant execute on function public\.resolve_waste_video_link\(bytea\) to service_role;/);
  const resolve = sql.slice(sql.indexOf('create or replace function public.resolve_waste_video_link'));
  assert.doesNotMatch(resolve, /archived_at/);
  // The job-report link objects are only named in the header comment - never created, altered or read here.
  assert.doesNotMatch(sql, /public\.report_video_links|function public\.resolve_report_video_link|public\.report_videos\b/);
  assert.match(sql, /and kind = 'video'/);
});

test('Luke reaches Waste reports from the rail; the route is in the manager app only', () => {
  const app = read('src/App.tsx');
  assert.ok(app.indexOf('path="/waste-reports"') > app.indexOf('<AppShell />'), 'manager routes only');
  const rail = read('src/components/shell/NavRail.tsx');
  assert.match(rail, /key: 'waste', label: 'Waste reports'.*count: unsentWasteReports/);
});
