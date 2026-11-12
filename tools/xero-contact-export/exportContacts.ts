// Read-only export of ONE Xero organisation's contacts, run locally by an operator.
//
// It exists so the contacts (with their real ContactIDs) can be reviewed against the Manager app's buildings BEFORE
// anything is linked. It changes nothing in Xero or in this project: it never creates, updates, merges, archives or
// emails a contact, never touches an invoice, and never reads or writes the app's database.
//
// Safety properties (each is enforced here and pinned by tests/xeroContactExport.test.ts):
//   - The output path is validated BEFORE any request: absolute, outside every git work tree, never an existing file.
//   - The connected organisation is read from Xero (GET /Organisation) and must equal the id the operator explicitly
//     confirmed. On a mismatch NO contact request is made.
//   - The only non-GET request is the token request (it authenticates; it changes nothing).
//   - Every contact request asks for archived contacts too. Paging stops only on an EMPTY page, so a server that
//     returns fewer rows than asked for cannot silently truncate the export.
//   - A ContactID seen twice, a malformed row, a missing page or an unexpected status aborts the whole export:
//     a partial or inconsistent export is never written as if it were complete.
//   - Rate limits are respected (spacing between requests, Retry-After on 429, and a stop well before the daily
//     allowance is used up, because the app's own invoicing shares it).
//   - Nothing sensitive is logged: no token, credential, contact name or email address.
//
// Authentication deliberately copies the app's existing pattern (supabase/functions/_shared/xeroClient.ts
// getXeroAccessToken): client_credentials, HTTP Basic, body "grant_type=client_credentials", NO scope parameter.
// Whether a newly created Custom Connection needs a scope parameter is an open question; this tool does not decide it.
//
// Written as erasable-only TypeScript (no enums, namespaces or parameter properties) so a Node that runs .ts files
// without flags can run it as `node cli.ts`, and so it type-checks with the repository's compiler. It has been verified
// ONLY on Node v25.6.0 (see the README); other versions have not been tested.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const IDENTITY_URL = 'https://identity.xero.com/connect/token';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

export type ExportErrorCode =
  | 'BAD_ARGUMENT'
  | 'UNSAFE_OUTPUT_PATH'
  | 'AUTH_FAILED'
  | 'ORG_LOOKUP_FAILED'
  | 'ORG_MISMATCH'
  | 'ORG_NOT_ACTIVE'
  | 'RATE_LIMITED'
  | 'XERO_ERROR'
  | 'BAD_RESPONSE'
  | 'DATA_CHANGED_DURING_EXPORT'
  | 'TOO_MANY_PAGES'
  | 'WRITE_FAILED';

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

/** The file operations the export uses to write its result. Real by default; tests substitute failing ones. */
export interface FsOps {
  existsSync(path: string): boolean;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  chmodSync(path: string, mode: number): void;
}

export const realFs: FsOps = { existsSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync };

export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Overrides for individual file operations. Only tests use this. */
  fsOps?: Partial<FsOps>;
}

export interface Tuning {
  /** Contacts requested per page. Xero's default is 100 and its documented maximum is 1000. */
  pageSize: number;
  /** Pause before every Accounting API request after the first (1100ms keeps a single client under 60 a minute). */
  minIntervalMs: number;
  /** How many times one request may be retried after a 429, and (separately) after a 5xx or a network failure. */
  maxRetries: number;
  /** Upper bound on pages, so a misbehaving server cannot loop the tool forever. */
  maxPages: number;
  /** Stop (without writing anything) if Xero reports fewer than this many calls left in the day. */
  minDayRemaining: number;
}

export const DEFAULT_TUNING: Tuning = { pageSize: 100, minIntervalMs: 1100, maxRetries: 5, maxPages: 500, minDayRemaining: 100 };

export function defaultDeps(): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => {
      console.log(line);
    },
  };
}

// ---- logging that cannot leak ---------------------------------------------------------------------------------------

/** Defence in depth: whatever a log line contains, a known secret and anything shaped like an email address never leaves. */
export function makeSafeLog(log: (line: string) => void, secrets: string[]): (line: string) => void {
  return (line) => {
    let out = line;
    for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
    out = out.replace(/[^\s@]+@[^\s@]+/g, '[redacted]');
    log(out);
  };
}

// ---- output path ------------------------------------------------------------------------------------------------------

/** True for something that exists at `path` in any form, including a dangling symlink (which `existsSync` reports as absent). */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A git repository's own folder, as opposed to a work tree: it has no .git entry, but it has HEAD, objects/ and refs/. */
function looksLikeBareRepository(dir: string): boolean {
  return existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects')) && existsSync(join(dir, 'refs'));
}

/** The first folder, walking up from `start`, that is (or contains the metadata of) a git repository; otherwise null. */
function findGitRoot(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')) || looksLikeBareRepository(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Folders that sync to a cloud service or are shared over a network are the wrong place for an export of real client
 * contacts. Folder NAMES and a UNC prefix are the only things that can be detected reliably, so this is a best-effort
 * warning, not a guarantee: a sync client pointed at an ordinarily-named folder, or a mapped network drive that looks
 * like a local one (for example `Z:\`), is NOT detected. Returns a description of what looks wrong, or null.
 */
export function findSyncOrNetworkWarning(path: string): string | null {
  if (/^(\\\\|\/\/)/.test(path)) return 'this looks like a network share (UNC path)';
  const synced = /^(onedrive.*|dropbox.*|google ?drive.*|my drive|icloud.*|box|box sync|pcloud.*|mega|megasync|nextcloud.*|owncloud.*|sync)$/i;
  const hit = path.split(/[\\/]/).find((segment) => synced.test(segment));
  return hit ? 'one of its folders looks like a cloud-synced folder' : null;
}

/**
 * The export holds real client contact data, so it must never end up somewhere that gets committed. The path must be
 * absolute and its folder must already exist. Symlinks and junctions are RESOLVED first, and the resolved location -
 * not just the path as typed - must not sit inside ANY git work tree (a normal work tree, a worktree or submodule, or a
 * bare repository). The file itself must not exist, in any form (an export is never overwritten). Called before any
 * request is made.
 *
 * It is called twice: first before any request, and AGAIN immediately before the file is written, because the export
 * takes a while (paced requests) and the folder could change in between.
 *
 * Known limits (documented in the README):
 *  - A repository whose git folder lives elsewhere (GIT_DIR, or a `.git` that is not in an ancestor folder) cannot be
 *    detected, nor can a mapped network drive or a sync client on an ordinary folder.
 *  - A very small window remains between this last check and the file actually being created. It cannot be removed
 *    without operating-system support (checking and creating in one atomic step). Overwriting is still impossible
 *    (the file is created with the exclusive `wx` flag), but a folder swapped into a repository in that instant would
 *    not be noticed.
 */
export function assertSafeOutputPath(outPath: string): string {
  if (!outPath || !isAbsolute(outPath)) {
    throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output path must be an absolute path.');
  }
  const target = resolve(outPath);
  if (!target.toLowerCase().endsWith('.json')) {
    throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output file name must end in .json.');
  }
  const folder = dirname(target);
  let folderOk = false;
  try {
    folderOk = statSync(folder).isDirectory();
  } catch {
    folderOk = false;
  }
  if (!folderOk) throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output folder does not exist. Create it first; this tool will not create folders.');

  // Where the folder REALLY is, after following symlinks and junctions.
  let realFolder: string;
  try {
    realFolder = realpathSync(folder);
  } catch {
    throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output folder could not be resolved to its real location, so it cannot be checked. Choose a plain folder.');
  }

  // Both the path as typed and its real location are checked: either one inside a repository is refused.
  if (findGitRoot(folder) !== null || findGitRoot(realFolder) !== null) {
    throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output path is inside (or resolves into) a git repository. Choose a private folder outside any repository.');
  }

  const realTarget = join(realFolder, basename(target));
  for (const candidate of [target, `${target}.sha256`, realTarget, `${realTarget}.sha256`]) {
    if (entryExists(candidate)) {
      throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output file (or its .sha256 file) already exists. An export is never overwritten.');
    }
  }
  return target;
}

// ---- Xero access --------------------------------------------------------------------------------------------------------

interface Session {
  deps: Deps;
  tuning: Tuning;
  accessToken: string;
  /** Accounting API requests made so far (token request excluded). */
  requests: number;
  /** Extra pause to apply before the next request (set when Xero says the per-minute allowance is nearly used). */
  extraWaitMs: number;
}

/** The same request the app makes (see the header comment). Returns the access token and the scopes Xero says it granted. */
async function getToken(creds: Credentials, deps: Deps): Promise<{ accessToken: string; scope: string | null }> {
  let res: Response;
  try {
    res = await deps.fetch(IDENTITY_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
  } catch {
    throw new ExportError('AUTH_FAILED', 'Could not reach Xero to authenticate.');
  }
  if (!res.ok) throw new ExportError('AUTH_FAILED', `Xero refused the token request (HTTP ${res.status}). Check the Custom Connection credentials. The Custom Connection's scope requirements may also need verifying (this tool sends no scope parameter); that is not necessarily the cause.`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new ExportError('BAD_RESPONSE', 'Xero returned an unreadable token response.');
  }
  if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new ExportError('BAD_RESPONSE', 'Xero did not return an access token.');
  }
  return { accessToken: body.access_token, scope: typeof body.scope === 'string' ? body.scope : null };
}

function retryAfterSeconds(res: Response): number {
  const raw = Number(res.headers.get('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

/** One read-only GET with pacing, rate-limit handling and bounded retries. `label` is what appears in messages (never a query value). */
async function getJson(s: Session, label: string, path: string): Promise<any> {
  let rateRetries = 0;
  let errorRetries = 0;
  for (;;) {
    if (s.requests > 0) await s.deps.sleep(s.tuning.minIntervalMs + s.extraWaitMs);
    s.extraWaitMs = 0;
    s.requests += 1;

    let res: Response;
    try {
      res = await s.deps.fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.accessToken}`, Accept: 'application/json' },
      });
    } catch {
      if (errorRetries < 3) {
        errorRetries += 1;
        await s.deps.sleep(2000 * 2 ** (errorRetries - 1));
        continue;
      }
      throw new ExportError('XERO_ERROR', `${label}: could not reach Xero.`);
    }

    if (res.status === 429) {
      const wait = retryAfterSeconds(res);
      if (res.headers.get('x-rate-limit-problem')?.toLowerCase() === 'day' || wait > 900) {
        throw new ExportError('RATE_LIMITED', `${label}: Xero's daily call limit is reached. Nothing was written. Try again after it resets.`);
      }
      if (rateRetries >= s.tuning.maxRetries) {
        throw new ExportError('RATE_LIMITED', `${label}: still rate limited after ${s.tuning.maxRetries} retries. Nothing was written.`);
      }
      rateRetries += 1;
      s.deps.log(`${label}: rate limited, waiting ${wait}s (retry ${rateRetries} of ${s.tuning.maxRetries})`);
      await s.deps.sleep(wait * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new ExportError('AUTH_FAILED', `${label}: Xero returned HTTP ${res.status}. The credentials may lack authorisation for this request; the Custom Connection's scopes may need verifying.`);
    }
    if (res.status >= 500) {
      if (errorRetries < 3) {
        errorRetries += 1;
        await s.deps.sleep(2000 * 2 ** (errorRetries - 1));
        continue;
      }
      throw new ExportError('XERO_ERROR', `${label}: Xero returned HTTP ${res.status}.`);
    }
    if (!res.ok) throw new ExportError('XERO_ERROR', `${label}: Xero returned HTTP ${res.status}.`);

    const dayLeft = Number(res.headers.get('x-daylimit-remaining'));
    if (res.headers.get('x-daylimit-remaining') !== null && Number.isFinite(dayLeft) && dayLeft < s.tuning.minDayRemaining) {
      throw new ExportError('RATE_LIMITED', `${label}: only ${dayLeft} Xero calls are left today, so the export stops to leave them for invoicing. Nothing was written.`);
    }
    const minLeft = Number(res.headers.get('x-minlimit-remaining'));
    if (res.headers.get('x-minlimit-remaining') !== null && Number.isFinite(minLeft) && minLeft <= 2) s.extraWaitMs = 60_000;

    try {
      return JSON.parse(await res.text());
    } catch {
      throw new ExportError('BAD_RESPONSE', `${label}: Xero returned a response that is not valid JSON.`);
    }
  }
}

export interface OrganisationInfo {
  organisationId: string;
  name: string | null;
  isDemoCompany: boolean | null;
  organisationType: string | null;
  countryCode: string | null;
  /** Xero documents OrganisationStatus as "ACTIVE when connectable via the API". Null when Xero does not report it. */
  organisationStatus: string | null;
}

async function readOrganisation(s: Session): Promise<OrganisationInfo> {
  let body: any;
  try {
    body = await getJson(s, 'organisation lookup', '/Organisation');
  } catch (err) {
    if (err instanceof ExportError && err.code === 'AUTH_FAILED') {
      throw new ExportError('ORG_LOOKUP_FAILED', err.message.replace(/^organisation lookup: /, 'Could not read the connected organisation: '));
    }
    throw err;
  }
  const org = body?.Organisations?.[0];
  const id = org?.OrganisationID;
  if (typeof id !== 'string' || id.trim() === '') throw new ExportError('ORG_LOOKUP_FAILED', 'Xero did not return an organisation id, so the connection cannot be verified.');
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    organisationId: id.trim(),
    name: text(org.Name),
    isDemoCompany: typeof org.IsDemoCompany === 'boolean' ? org.IsDemoCompany : null,
    organisationType: text(org.OrganisationType),
    countryCode: text(org.CountryCode),
    organisationStatus: text(org.OrganisationStatus),
  };
}

async function openSession(creds: Credentials, deps: Deps, tuning: Tuning): Promise<{ session: Session; scope: string | null }> {
  const { accessToken, scope } = await getToken(creds, deps);
  return { session: { deps, tuning, accessToken, requests: 0, extraWaitMs: 0 }, scope };
}

function safeDeps(deps: Deps, creds: Credentials): Deps {
  return { ...deps, log: makeSafeLog(deps.log, [creds.clientSecret, creds.clientId]) };
}

/**
 * Inspect mode: token + GET /Organisation only. Shows which organisation the credentials belong to so the operator can
 * confirm it with the business BEFORE running an export. Requests no contacts.
 */
export async function inspectOrganisation(
  creds: Credentials,
  rawDeps: Deps,
  tuning: Tuning = DEFAULT_TUNING,
): Promise<OrganisationInfo & { grantedScopes: string | null }> {
  const deps = safeDeps(rawDeps, creds);
  const { session, scope } = await openSession(creds, deps, tuning);
  const org = await readOrganisation(session);
  return { ...org, grantedScopes: scope };
}

// ---- contact mapping ----------------------------------------------------------------------------------------------------------

export interface ExportedAddress {
  type: string | null;
  attentionTo: string | null;
  line1: string | null;
  line2: string | null;
  line3: string | null;
  line4: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface ExportedContactPerson {
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
  includeInEmails: boolean | null;
}

export interface ExportedContact {
  contactId: string;
  name: string | null;
  status: string | null;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
  accountNumber: string | null;
  isCustomer: boolean | null;
  isSupplier: boolean | null;
  updatedDateUtc: string | null;
  /** Set by Xero when this contact was merged into another: the surviving contact's id. Only returned when paging. */
  mergedToContactId: string | null;
  addresses: ExportedAddress[];
  contactPersons: ExportedContactPerson[];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** An allow-list copy: only these fields are kept, with their meaning unchanged. Anything else Xero sends is dropped. */
export function mapContact(raw: any): ExportedContact {
  const id = raw?.ContactID;
  if (typeof id !== 'string' || id.trim() === '') throw new ExportError('BAD_RESPONSE', 'Xero returned a contact without a ContactID. Nothing was written.');
  return {
    contactId: id,
    name: str(raw.Name),
    status: str(raw.ContactStatus),
    firstName: str(raw.FirstName),
    lastName: str(raw.LastName),
    emailAddress: str(raw.EmailAddress),
    accountNumber: str(raw.AccountNumber),
    isCustomer: bool(raw.IsCustomer),
    isSupplier: bool(raw.IsSupplier),
    updatedDateUtc: str(raw.UpdatedDateUTC),
    mergedToContactId: str(raw.MergedToContactID),
    addresses: list(raw.Addresses).map((a) => ({
      type: str(a?.AddressType),
      attentionTo: str(a?.AttentionTo),
      line1: str(a?.AddressLine1),
      line2: str(a?.AddressLine2),
      line3: str(a?.AddressLine3),
      line4: str(a?.AddressLine4),
      city: str(a?.City),
      region: str(a?.Region),
      postalCode: str(a?.PostalCode),
      country: str(a?.Country),
    })),
    contactPersons: list(raw.ContactPersons).map((p) => ({
      firstName: str(p?.FirstName),
      lastName: str(p?.LastName),
      emailAddress: str(p?.EmailAddress),
      includeInEmails: bool(p?.IncludeInEmails),
    })),
  };
}

// ---- the export ---------------------------------------------------------------------------------------------------------------------

export interface ExportArgs {
  creds: Credentials;
  /** The organisation id the operator has explicitly confirmed with the business. */
  confirmOrgId: string;
  outPath: string;
  tuning?: Tuning;
}

export interface ExportDetailCounts {
  /** Contacts with at least one address that has any content (Xero often returns empty address entries). */
  withAddress: number;
  withEmail: number;
  withContactPersons: number;
  /** Contact persons whose IncludeInEmails flag is true: they receive invoice emails as well as the main address. */
  contactPersonsIncludedInEmails: number;
  /** Contacts that were merged into another contact in Xero (MergedToContactID present). */
  mergedAway: number;
}

const hasContent = (v: string | null) => v !== null && v.trim() !== '';

/** Pure counting over the whole export: nothing about any individual contact is returned or logged. */
export function summariseDetail(contacts: ExportedContact[]): ExportDetailCounts {
  return {
    withAddress: contacts.filter((c) => c.addresses.some((a) => [a.line1, a.line2, a.line3, a.line4, a.city, a.region, a.postalCode, a.country].some(hasContent))).length,
    withEmail: contacts.filter((c) => hasContent(c.emailAddress)).length,
    withContactPersons: contacts.filter((c) => c.contactPersons.length > 0).length,
    contactPersonsIncludedInEmails: contacts.reduce((n, c) => n + c.contactPersons.filter((p) => p.includeInEmails === true).length, 0),
    mergedAway: contacts.filter((c) => hasContent(c.mergedToContactId)).length,
  };
}

export interface ExportSummary {
  outPath: string;
  sha256: string;
  pages: number;
  requests: number;
  contactCount: number;
  archivedCount: number;
  organisationId: string;
  /** Aggregate counts only: they tell the operator whether the response really carried full detail. */
  detail: ExportDetailCounts;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function exportContacts(args: ExportArgs, rawDeps: Deps): Promise<ExportSummary> {
  const tuning = args.tuning ?? DEFAULT_TUNING;
  if (!Number.isInteger(tuning.pageSize) || tuning.pageSize < 1 || tuning.pageSize > 1000) {
    throw new ExportError('BAD_ARGUMENT', 'The page size must be a whole number from 1 to 1000.');
  }
  const confirm = args.confirmOrgId.trim().toLowerCase();
  if (!GUID.test(confirm)) throw new ExportError('BAD_ARGUMENT', 'The confirmed organisation id is not a valid id. Run --inspect-organisation to see it.');

  // 1. Everything that can be checked without Xero is checked first: an unsafe path means zero requests.
  const target = assertSafeOutputPath(args.outPath);

  const deps = safeDeps(rawDeps, args.creds);
  const location = findSyncOrNetworkWarning(target);
  if (location) {
    deps.log(`WARNING: ${location}. Do not keep an export of real client contacts in a cloud-synced or shared folder; use a private local folder.`);
  }
  const { session, scope } = await openSession(args.creds, deps, tuning);

  // 2. The connected organisation must be the confirmed one BEFORE any contact is requested.
  const org = await readOrganisation(session);
  if (org.organisationId.toLowerCase() !== confirm) {
    throw new ExportError('ORG_MISMATCH', 'The connected Xero organisation is not the one you confirmed. No contacts were requested. Run --inspect-organisation to see which organisation these credentials belong to.');
  }
  deps.log('organisation verified against the confirmed id');
  if (org.organisationStatus !== null && org.organisationStatus.toUpperCase() !== 'ACTIVE') {
    throw new ExportError('ORG_NOT_ACTIVE', 'Xero reports this organisation as not active, so no contacts were requested.');
  }
  if (org.organisationStatus === null) deps.log('note: Xero did not report an organisation status');

  // 3. Every page, archived included, until an EMPTY page.
  const contacts: ExportedContact[] = [];
  const seen = new Set<string>();
  let page = 1;
  for (;;) {
    if (page > tuning.maxPages) throw new ExportError('TOO_MANY_PAGES', `More than ${tuning.maxPages} pages were returned. Nothing was written.`);
    const body = await getJson(session, `contacts page ${page}`, `/Contacts?includeArchived=true&page=${page}&pageSize=${tuning.pageSize}`);
    const rows = body?.Contacts;
    if (!Array.isArray(rows)) throw new ExportError('BAD_RESPONSE', `contacts page ${page}: the response has no contact list. Nothing was written.`);
    if (rows.length === 0) break;
    for (const raw of rows) {
      const contact = mapContact(raw);
      if (seen.has(contact.contactId)) {
        throw new ExportError(
          'DATA_CHANGED_DURING_EXPORT',
          'The same contact appeared on two pages, which means contacts changed while the export was running. Nothing was written. Run it again.',
        );
      }
      seen.add(contact.contactId);
      contacts.push(contact);
    }
    deps.log(`page ${page}: ${rows.length} contacts (${contacts.length} so far)`);
    page += 1;
  }

  // 4. Only now, with everything in hand, is anything written.
  const archivedCount = contacts.filter((c) => c.status === 'ARCHIVED').length;
  const detail = summariseDetail(contacts);
  const document = JSON.stringify(
    {
      meta: {
        tool: 'xero-contact-export',
        exportedAt: new Date().toISOString(),
        organisation: org,
        grantedScopes: scope,
        pageSize: tuning.pageSize,
        pagesRequested: page,
        contactCount: contacts.length,
        archivedCount,
        detail,
      },
      contacts,
    },
    null,
    1,
  );
  const sha256 = createHash('sha256').update(document).digest('hex');

  // The folder and the file name are checked AGAIN, now: everything above took time, and the output folder may have
  // changed since the first check (a repository created in it, a junction swapped in, the folder removed, a file appeared).
  assertSafeOutputPath(target);
  writeNewFile(target, document, sha256, { ...realFs, ...(rawDeps.fsOps ?? {}) });

  deps.log(`wrote ${contacts.length} contacts (${archivedCount} archived) to ${target}`);
  deps.log(`detail: ${detail.withAddress} with an address, ${detail.withEmail} with an email, ${detail.withContactPersons} with contact persons (${detail.contactPersonsIncludedInEmails} flagged for invoice emails), ${detail.mergedAway} merged away`);
  if (contacts.length >= 20 && (detail.withAddress === 0 || detail.withContactPersons === 0)) {
    deps.log('NOTE: no contact has any address or no contact has any contact person. Check that Xero returned full detail before relying on this export.');
  }
  return { outPath: target, sha256, pages: page - 1, requests: session.requests, contactCount: contacts.length, archivedCount, organisationId: org.organisationId, detail };
}

/**
 * Writes the export through a temporary file and renames it into place, so a half-written export can never be mistaken
 * for a complete one: the final `.json` name only ever comes into existence by the last rename, after the data was
 * written and flushed. The checksum file is created first; if anything fails, the files THIS call created are removed
 * (a pre-existing file is never touched). Exported so the failure paths can be tested.
 *
 * If the process is killed (or the machine loses power) mid-write, a `<name>.json.<hex>.tmp` file and/or an orphan
 * `<name>.json.sha256` can be left behind; the README tells the operator to look for and delete them.
 */
export function writeNewFile(target: string, document: string, sha256: string, ops: FsOps = realFs): void {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const sidecar = `${target}.sha256`;
  let fd: number | null = null;
  let tempCreated = false;
  let sidecarCreated = false;
  try {
    fd = ops.openSync(temp, 'wx', 0o600);
    tempCreated = true;
    ops.writeSync(fd, document);
    ops.fsyncSync(fd);
    const done = fd;
    fd = null;
    ops.closeSync(done);

    const sfd = ops.openSync(sidecar, 'wx', 0o600);
    sidecarCreated = true;
    try {
      ops.writeSync(sfd, `${sha256}  ${target.split(/[\\/]/).pop()}\n`);
    } finally {
      ops.closeSync(sfd);
    }

    if (ops.existsSync(target)) throw new ExportError('UNSAFE_OUTPUT_PATH', 'The output file appeared while the export was running. It was not overwritten.');
    ops.renameSync(temp, target);
    try {
      ops.chmodSync(target, 0o600);
    } catch {
      // Not every file system supports permissions (for example on Windows); the folder choice is what matters there.
    }
  } catch (err) {
    if (fd !== null) {
      try {
        ops.closeSync(fd);
      } catch {
        // already closed
      }
    }
    for (const leftover of [...(tempCreated ? [temp] : []), ...(sidecarCreated ? [sidecar] : [])]) {
      try {
        ops.unlinkSync(leftover);
      } catch {
        // nothing to clean up
      }
    }
    if (err instanceof ExportError) throw err;
    throw new ExportError('WRITE_FAILED', 'The export could not be written. Nothing usable was left behind.');
  }
}
