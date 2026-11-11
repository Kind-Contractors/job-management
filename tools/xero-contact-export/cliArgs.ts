// Command-line parsing for the Xero contact export. Pure (no I/O) so it can be tested directly.
//
// Credentials are NEVER accepted as arguments: a command line is stored in shell history and visible in process
// listings. They are read from the environment only.

import type { Credentials } from './exportContacts.ts';
import { DEFAULT_TUNING, ExportError } from './exportContacts.ts';

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'inspect' }
  | { kind: 'export'; confirmOrgId: string; outPath: string; pageSize: number };

export const USAGE = `Read-only Xero contact export (changes nothing in Xero).

Credentials come from the environment, never from arguments:
  XERO_CLIENT_ID, XERO_CLIENT_SECRET   the Custom Connection's client id and secret

Step 1 - find out which organisation the credentials belong to (requests no contacts):
  node cli.ts --inspect-organisation

Step 2 - once the business has confirmed that organisation, export its contacts:
  node cli.ts --confirm-org <organisation id> --out <absolute path>.json [--page-size 100]

The output file must be OUTSIDE any git repository, in an existing private folder, and must not already exist.
`;

const SECRET_FLAGS = new Set(['--client-id', '--client-secret', '--secret', '--token', '--access-token', '--password']);

export function parseArgs(argv: string[]): CliCommand {
  let inspect = false;
  let help = false;
  let confirmOrgId: string | null = null;
  let outPath: string | null = null;
  let pageSize = DEFAULT_TUNING.pageSize;

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : null;
    const value = (): string => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new ExportError('BAD_ARGUMENT', `${flag} needs a value.`);
      i += 1;
      return next;
    };

    if (SECRET_FLAGS.has(flag)) {
      throw new ExportError('BAD_ARGUMENT', 'Credentials are read from the environment (XERO_CLIENT_ID, XERO_CLIENT_SECRET), never from command-line arguments.');
    } else if (flag === '--help' || flag === '-h') help = true;
    else if (flag === '--inspect-organisation') inspect = true;
    else if (flag === '--confirm-org') confirmOrgId = value();
    else if (flag === '--out') outPath = value();
    else if (flag === '--page-size') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ExportError('BAD_ARGUMENT', '--page-size must be a whole number from 1 to 1000.');
      pageSize = n;
    } else {
      // The argument is deliberately NOT repeated: a secret typed here by mistake must not be echoed to the screen or a log.
      throw new ExportError('BAD_ARGUMENT', `Unknown or unexpected argument (number ${i + 1} on the command line, not shown). Use --help.`);
    }
  }

  if (help) return { kind: 'help' };
  if (inspect) {
    if (confirmOrgId !== null || outPath !== null) throw new ExportError('BAD_ARGUMENT', '--inspect-organisation cannot be combined with --confirm-org or --out.');
    return { kind: 'inspect' };
  }
  if (confirmOrgId === null) throw new ExportError('BAD_ARGUMENT', 'An export needs --confirm-org <organisation id>. Run --inspect-organisation first to see it.');
  if (outPath === null) throw new ExportError('BAD_ARGUMENT', 'An export needs --out <absolute path>.json (outside any git repository).');
  return { kind: 'export', confirmOrgId, outPath, pageSize };
}

export function readCredentials(env: Record<string, string | undefined>): Credentials {
  const clientId = env.XERO_CLIENT_ID?.trim();
  const clientSecret = env.XERO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new ExportError('BAD_ARGUMENT', 'Set XERO_CLIENT_ID and XERO_CLIENT_SECRET in the environment of this terminal session before running.');
  }
  return { clientId, clientSecret };
}
