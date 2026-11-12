// Entry point: `node cli.ts ...` (a Node that runs TypeScript directly; verified only on Node v25.6.0 - see the README).
// All of the logic is in cliMain.ts, so that what it prints can be tested. This file only supplies the real process.

import { runCli } from './cliMain.ts';
import { defaultDeps } from './exportContacts.ts';

const io = {
  out: (line: string) => {
    console.log(line);
  },
  err: (line: string) => {
    console.error(line);
  },
};

// exitCode (not process.exit) so any output still being flushed is not cut off.
process.exitCode = await runCli(process.argv.slice(2), process.env, { ...defaultDeps(), log: io.out }, io);
