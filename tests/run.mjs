// Minimal test runner (the repo has no test framework): bundles each tests/*.test.ts(x) with
// esbuild (already installed as part of Vite) and runs the result with Node's built-in
// test runner. Usage: npm test
import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'node_modules', '.cache', 'app-tests');
mkdirSync(outDir, { recursive: true });

const entries = readdirSync(join(root, 'tests'))
  .filter((f) => /\.test\.tsx?$/.test(f))
  .map((f) => join(root, 'tests', f));

// The Edge Functions import their packages Deno-style ('npm:@supabase/supabase-js@2'). Point those at the copy installed
// here so a function's real code can be bundled and run in Node (the Deno runtime itself is faked by the test).
const denoNpmSpecifiers = {
  name: 'deno-npm-specifiers',
  setup(b) {
    b.onResolve({ filter: /^npm:@supabase\/supabase-js@2(\/cors)?$/ }, (args) =>
      b.resolve(args.path.replace(/^npm:/, '').replace('@2', ''), { resolveDir: root, kind: args.kind }),
    );
  },
};

await build({
  plugins: [denoNpmSpecifiers],
  entryPoints: entries,
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  // Pages import their logo images; they are never rendered in these tests, so inline them as data URLs.
  loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.svg': 'dataurl' },
  logLevel: 'warning',
  // The app reads Vite env at import time (src/lib/supabaseClient.ts). No network call is ever made in these tests.
  define: {
    'process.env.NODE_ENV': '"test"',
    'import.meta.env.VITE_SUPABASE_URL': '"https://tests.invalid"',
    'import.meta.env.VITE_SUPABASE_ANON_KEY': '"test-key"',
    'import.meta.env.DEV': 'false',
  },
  // Bundled ESM needs a require for any CommonJS dependency pulled in.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const files = entries.map((e) => join(outDir, basename(e).replace(/\.tsx?$/, '.mjs')));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
