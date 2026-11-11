// The command-line logic, separated from the process so that everything it prints can be tested.
//
// Every line of output goes through `io`; nothing here touches `console` or `process` directly. The thin entry point
// (cli.ts) supplies the real ones. Exit code 0 means success, 1 means nothing was exported.

import { parseArgs, readCredentials, USAGE } from './cliArgs.ts';
import { DEFAULT_TUNING, ExportError, exportContacts, inspectOrganisation } from './exportContacts.ts';
import type { Deps } from './exportContacts.ts';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export async function runCli(argv: string[], env: Record<string, string | undefined>, deps: Deps, io: CliIo): Promise<number> {
  try {
    const command = parseArgs(argv);
    if (command.kind === 'help') {
      io.out(USAGE);
      return 0;
    }

    const creds = readCredentials(env);

    if (command.kind === 'inspect') {
      const org = await inspectOrganisation(creds, deps);
      io.out('Connected Xero organisation (confirm this with the business before exporting):');
      io.out(`  organisation id : ${org.organisationId}`);
      io.out(`  name            : ${org.name ?? '(not returned)'}`);
      io.out(`  demo company    : ${org.isDemoCompany === null ? '(not returned)' : org.isDemoCompany ? 'YES' : 'no'}`);
      io.out(`  type / country  : ${org.organisationType ?? '?'} / ${org.countryCode ?? '?'}`);
      io.out(`  status          : ${org.organisationStatus ?? '(not reported)'}${org.organisationStatus !== null && org.organisationStatus.toUpperCase() !== 'ACTIVE' ? '  <-- NOT ACTIVE: an export will be refused' : ''}`);
      io.out(`  granted scopes  : ${org.grantedScopes ?? '(not reported in the token response)'}`);
      io.out('\nNo contacts were requested. To export, re-run with --confirm-org <organisation id> --out <path>.json');
      return 0;
    }

    io.out('Reminder: the export must go in a private LOCAL folder - not a cloud-synced folder (OneDrive, Dropbox, Google Drive, iCloud...) and not a network share.');
    const summary = await exportContacts(
      { creds, confirmOrgId: command.confirmOrgId, outPath: command.outPath, tuning: { ...DEFAULT_TUNING, pageSize: command.pageSize } },
      deps,
    );
    io.out(`Done: ${summary.contactCount} contacts (${summary.archivedCount} archived) in ${summary.pages} pages.`);
    io.out(`Detail: ${summary.detail.withAddress} with an address, ${summary.detail.withEmail} with an email, ${summary.detail.withContactPersons} with contact persons (${summary.detail.contactPersonsIncludedInEmails} flagged for invoice emails), ${summary.detail.mergedAway} merged away.`);
    io.out(`File : ${summary.outPath}`);
    io.out(`SHA-256: ${summary.sha256}`);
    io.out('Keep this file private. It contains real client contact data and must never be committed.');
    io.out('Delete it (and its .sha256 file) when the review is finished - see the README for how.');
    return 0;
  } catch (err: unknown) {
    // Only the message of a known error is shown; anything unexpected is reported generically (no stack, no request detail).
    io.err(err instanceof ExportError ? `Error (${err.code}): ${err.message}` : 'Error: the export failed unexpectedly. Nothing was written.');
    return 1;
  }
}
