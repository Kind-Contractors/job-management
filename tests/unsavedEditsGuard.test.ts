// Leaving Report Review with unsaved typing (src/lib/unsavedEditsGuard.ts): the tab-close warning, held in-app link clicks, and the
// confirmation used before choosing another report. Fake window / document / anchors, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LEAVE_WARNING, confirmLeave, hasUnsavedEdits, installLeaveWarnings, registerUnsavedGuard } from '../src/lib/unsavedEditsGuard';

function guard(over: { unsaved?: boolean; fail?: string } = {}) {
  const g = { unsaved: over.unsaved ?? true, fail: over.fail, flushes: 0 };
  const unregister = registerUnsavedGuard({
    hasUnsaved: () => g.unsaved,
    flush: async () => {
      g.flushes += 1;
      if (g.fail) throw new Error(g.fail);
      g.unsaved = false;
    },
  });
  return { g, unregister };
}

function fakeTargets() {
  const handlers: Record<string, { fn: (e: never) => void; capture?: boolean }[]> = {};
  const add = (type: string, fn: (e: never) => void, capture?: boolean) => ((handlers[type] ??= []).push({ fn, capture }));
  const remove = (type: string, fn: (e: never) => void) => (handlers[type] = (handlers[type] ?? []).filter((h) => h.fn !== fn));
  const asks: string[] = [];
  return {
    handlers,
    asks,
    answer: true,
    targets: () => ({
      win: { addEventListener: add, removeEventListener: remove } as unknown as Window,
      doc: { addEventListener: add, removeEventListener: remove } as unknown as Document,
      ask: (m: string) => (asks.push(m), fake.answer),
      origin: 'https://app.test',
    }),
  };
}
let fake = fakeTargets();

const settle = () => new Promise((r) => setImmediate(r));
function anchor(over: Record<string, unknown> = {}) {
  const a = { origin: 'https://app.test', clicks: 0, click() { this.clicks += 1; }, hasAttribute: () => false, ...over };
  return { a, el: { closest: (sel: string) => (sel === 'a[href]' ? a : null) } };
}
function click(el: unknown, over: Record<string, unknown> = {}) {
  const e = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: el, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...over };
  for (const h of fake.handlers.click ?? []) h.fn(e as never);
  return e;
}

test('confirmLeave: nothing unsaved -> go; unsaved but it saves -> go (and it did save); no guard at all -> go', async () => {
  assert.equal(await confirmLeave(() => assert.fail('no question expected')), true);
  const { g, unregister } = guard({ unsaved: false });
  assert.equal(await confirmLeave(() => assert.fail('no question expected')), true);
  assert.equal(g.flushes, 0);
  g.unsaved = true;
  assert.equal(await confirmLeave(() => assert.fail('no question expected')), true);
  assert.equal(g.flushes, 1);
  unregister();
  assert.equal(hasUnsavedEdits(), false, 'an unregistered guard no longer counts');
});

test('confirmLeave: when the save FAILS the manager is asked, with the reason; Cancel stays, OK leaves', async () => {
  const { unregister } = guard({ fail: 'Failed to update report: network down' });
  const asked: string[] = [];
  assert.equal(await confirmLeave((m) => (asked.push(m), false)), false, 'Cancel -> stay on the report');
  assert.equal(await confirmLeave((m) => (asked.push(m), true)), true, 'OK -> leave and lose it');
  assert.match(asked[0], new RegExp(LEAVE_WARNING.slice(0, 30)));
  assert.match(asked[0], /network down/);
  unregister();
});

test('tab close / reload: the browser warning is requested only while something is unsaved', () => {
  fake = fakeTargets();
  const { g, unregister } = guard();
  const uninstall = installLeaveWarnings(fake.targets());
  const ev = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
  fake.handlers.beforeunload[0].fn(ev as never);
  assert.equal(ev.prevented, true);
  assert.equal(ev.returnValue, '');
  g.unsaved = false;
  const quiet = { prevented: false, preventDefault() { this.prevented = true; } };
  fake.handlers.beforeunload[0].fn(quiet as never);
  assert.equal(quiet.prevented, false, 'nothing unsaved -> no warning');
  uninstall();
  assert.equal(fake.handlers.beforeunload.length, 0, 'listeners are removed');
  assert.equal(fake.handlers.click.length, 0);
  unregister();
});

test('in-app link with unsaved typing: the click is held, the edits are saved, then the link is followed', async () => {
  fake = fakeTargets();
  const { g, unregister } = guard();
  const uninstall = installLeaveWarnings(fake.targets());
  const { a, el } = anchor();
  const e = click(el);
  assert.equal(e.prevented, true);
  assert.equal(e.stopped, true);
  assert.equal(a.clicks, 0, 'not followed yet');
  await settle();
  assert.equal(g.flushes, 1);
  assert.equal(a.clicks, 1, 'followed once the save worked');
  // the replayed click must not be held again
  const replay = click(el);
  assert.equal(replay.prevented, false, 'nothing unsaved any more -> an ordinary click');
  uninstall();
  unregister();
});

test('in-app link when the save FAILS: the link is not followed unless the manager chooses to leave anyway', async () => {
  fake = fakeTargets();
  const { unregister } = guard({ fail: 'network down' });
  const uninstall = installLeaveWarnings(fake.targets());
  const { a, el } = anchor();
  fake.answer = false;
  click(el);
  await settle();
  assert.equal(a.clicks, 0, 'stayed');
  assert.match(fake.asks[0], /network down/);
  fake.answer = true;
  click(el);
  await settle();
  assert.equal(a.clicks, 1, 'left after the manager agreed');
  uninstall();
  unregister();
});

test('clicks that are not plain in-app link clicks are left alone (new tab, other site, downloads, nothing unsaved, non-links)', async () => {
  fake = fakeTargets();
  const { unregister } = guard();
  const uninstall = installLeaveWarnings(fake.targets());
  const { el } = anchor();
  assert.equal(click(el, { ctrlKey: true }).prevented, false, 'ctrl-click opens a new tab');
  assert.equal(click(el, { button: 1 }).prevented, false, 'middle click');
  assert.equal(click(anchor({ target: '_blank' }).el).prevented, false);
  assert.equal(click(anchor({ origin: 'https://elsewhere.test' }).el).prevented, false, 'other sites get the browser\'s own warning');
  assert.equal(click(anchor({ hasAttribute: (n: string) => n === 'download' }).el).prevented, false);
  assert.equal(click({ closest: () => null }).prevented, false, 'not a link');
  assert.equal(click(el, { defaultPrevented: true }).prevented, false, 'already handled');
  uninstall();
  unregister();
});
