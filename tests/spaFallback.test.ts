// REGRESSION: hard-refreshing an application route (/monthly-plan, /jobs, /month-matrix, ...) on Netlify showed
// "Page not found".
//
// The app is a single-page app: only `/` is a real file, every other route exists in the browser alone. A request for
// one of them reaches Netlify, which has no such file and says 404 - unless a `_redirects` rule rewrites it to
// index.html. That rule existed (public/_redirects) and was correct, but the file had NEVER BEEN COMMITTED. Netlify
// builds from Git, so its build never saw it and the deployed site had no fallback. In-app navigation never makes the
// request, which is why the site seemed fine until someone refreshed or pasted a link.
//
// These tests pin the three things that all have to be true for the fix to reach production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const REDIRECTS = 'public/_redirects';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- 1. the rule is right ----------------------------------------------------------------------------------------
test('public/_redirects exists and holds the SPA fallback as a 200 REWRITE', () => {
  assert.ok(existsSync(join(root, REDIRECTS)), `${REDIRECTS} is missing`);
  const rules = readFileSync(join(root, REDIRECTS), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));

  assert.deepEqual(rules, [['/*', '/index.html', '200']], 'exactly one rule: everything unmatched is rewritten to index.html');
  // 200, not 301/302: a redirect would change the URL and break the router's own path; a rewrite keeps it.
  assert.equal(rules[0][2], '200');
});

test('the rule is non-forced, so real static files still win over it', () => {
  // Netlify only shadows a real file when a rule ends in "!". The catch-all must not, or /assets/*.js, /sw.js and the
  // manifest would all be answered with index.html.
  const text = readFileSync(join(root, REDIRECTS), 'utf8');
  assert.doesNotMatch(text, /\d{3}!/, 'no forced (!) rule');
});

// ---- 2. Vite actually ships it --------------------------------------------------------------------------------------
test('Vite copies public/ into the build, so the file lands in dist/ untouched', () => {
  const config = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  // `publicDir` defaults to "public"; overriding or disabling it would silently drop the file from the build.
  assert.doesNotMatch(config.replace(/\/\/[^\n]*/g, ''), /publicDir/, 'the default publicDir is in use');
});

// ---- 3. it is IN GIT, which is the bug that actually happened ----------------------------------------------------
test('public/_redirects is tracked by Git — Netlify builds from the repository, not from a working folder', () => {
  let tracked = true;
  try {
    git('ls-files', '--error-unmatch', '--', REDIRECTS);
  } catch {
    tracked = false;
  }
  assert.ok(
    tracked,
    `${REDIRECTS} exists on disk but is NOT tracked by Git, so a Netlify build (which starts from a clean checkout) has no SPA fallback ` +
      'and every route except "/" returns 404 on refresh. Fix: git add public/_redirects, then commit.',
  );
});

test('and it is not Git-ignored (a tracked-then-ignored file can still go missing from a fresh clone)', () => {
  let ignored = false;
  try {
    git('check-ignore', '-q', '--', REDIRECTS);
    ignored = true; // exit 0 = ignored
  } catch {
    ignored = false; // exit 1 = not ignored
  }
  assert.equal(ignored, false, `${REDIRECTS} matches a .gitignore rule`);
});
