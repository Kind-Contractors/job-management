# Xero contact export (read-only, local)

Exports one Xero organisation's contacts (with their ContactIDs) to a private JSON file so they can be reviewed
against the Manager app's buildings **before** anything is linked. It never creates, updates, merges, archives or
emails a contact, never touches an invoice, and never touches this project's database.

## Requirements

- **Node.js.** Verified on **Node v25.6.0 (Windows)**, which runs `.ts` files directly. Other versions that run
  TypeScript without flags (newer releases of the 22.x line and Node 23.6+ are expected to) have **not** been tested
  here. If `node --version` is older and the command stops with an error about the `.ts` extension, do not work around
  it: report it.
- Nothing to install or build. Run every command from the repository root.
- **Authentication is deliberately unchanged from the app's:** a `client_credentials` token request with no `scope`
  parameter. Whether a Custom Connection created after 29 April 2026 needs one is still **unverified**. If the token
  request is refused, that is one thing to check, but it is not necessarily the cause.

## Choosing where the export goes

The file holds real client names, email addresses and addresses. Save it in a **private, local folder on a disk you
control**, outside any git repository (for example a new folder under your own user profile that only your account can
open).

- **Do not** use a **cloud-synced** folder (OneDrive, Dropbox, Google Drive, iCloud Drive, Box, pCloud, MEGA, Nextcloud,
  and so on) or a **shared or network folder**. Their contents are copied off this computer and often kept in history.
  Windows can redirect Desktop, Documents and Downloads into OneDrive, so check where the folder really is.
- The tool refuses a folder that is inside, or that a symlink or junction resolves into, a git repository. It also
  prints a warning when a folder name looks cloud-synced or the path is a network share (UNC).
- **What it cannot detect:** a repository whose git folder lives elsewhere (for example set by `GIT_DIR`), a mapped
  network drive that looks like a local one (such as `Z:\`), and a sync client pointed at an ordinary folder name.
  Those are your responsibility.
- On Windows the file's access is whatever the folder already allows (the tool's owner-only permission setting has no
  effect there), so use a folder only your own account can open.

## Supplying the credentials safely

The credentials are read **only from the environment** of the terminal you run the tool in. The tool rejects them as
command-line arguments. Do **not** type the secret into a command (`set X=secret`, `$env:X = 'secret'`, `export X=secret`)
because a command line can be saved in shell history. Use a prompt instead: what you type at a prompt is not part of the
command line. These behaviours are believed correct for each shell but were not tested here, so check your own history
afterwards.

**PowerShell** (preferred: the typed secret is hidden)

```powershell
Set-PSReadLineOption -HistorySaveStyle SaveNothing      # nothing from this session is saved
$env:XERO_CLIENT_ID = Read-Host 'Xero client id'
$secret = Read-Host 'Xero client secret' -AsSecureString
$env:XERO_CLIENT_SECRET = [System.Net.NetworkCredential]::new('', $secret).Password
Remove-Variable secret
```

**Git Bash / bash** (the typed secret is hidden)

```bash
read -r -p 'Xero client id: ' XERO_CLIENT_ID; export XERO_CLIENT_ID
read -r -s -p 'Xero client secret: ' XERO_CLIENT_SECRET; echo; export XERO_CLIENT_SECRET
```

**cmd.exe** (the typed secret is **visible on screen**; prefer one of the two above)

```bat
set /p XERO_CLIENT_ID=Xero client id: 
set /p XERO_CLIENT_SECRET=Xero client secret: 
```

When you are finished, remove the values and close the terminal: PowerShell
`Remove-Item Env:XERO_CLIENT_ID, Env:XERO_CLIENT_SECRET`; bash `unset XERO_CLIENT_ID XERO_CLIENT_SECRET`; cmd
`set XERO_CLIENT_SECRET=`. Never put the credentials in a file in the repository, an email, or a chat.

## Running it

```
# 1. which organisation do these credentials belong to? (requests no contacts)
node tools/xero-contact-export/cli.ts --inspect-organisation

# 2. after the business has confirmed that organisation, export it
node tools/xero-contact-export/cli.ts --confirm-org <organisation id> --out <absolute path>.json
```

Step 1 shows the organisation's id, name, whether it is a demo company, its **status**, and the scopes Xero reports as
granted (if it reports them). If the status is not `ACTIVE`, step 2 refuses to run (Xero documents `OrganisationStatus`
as "ACTIVE when connectable via the API"; if Xero does not report it, the tool says so and carries on).

## Rules the tool enforces

- The output path is checked **before anything is sent to Xero**: absolute, `.json`, in an existing folder, symlinks and
  junctions resolved, nowhere inside a git repository, and the file (and its `.sha256` file) must not already exist in
  any form. An export is never overwritten.
- The folder and file name are checked **again immediately before the file is written**, because the export takes a
  while (paced requests) and the folder could change in between: a repository created in it, a junction swapped in, the
  folder removed, or a file appearing all stop the export with nothing written. **A very small window remains** between
  that last check and the file being created. It cannot be removed without operating-system support, so a folder swapped
  into a repository in that instant would not be noticed. Overwriting is still impossible, because the file is created
  with an exclusive flag.
- If the connected organisation is not the one you confirmed, **no contact is requested**.
- Archived contacts are included. Paging stops only on an empty page. Any inconsistency (a contact on two pages, a
  malformed row, a failed page) aborts the whole export; a partial file is never written.
- Requests are spaced to stay under Xero's per-minute limit, `Retry-After` is honoured, and the export stops (writing
  nothing) if Xero reports fewer than 100 calls left for the day, so invoicing keeps its allowance.
- Nothing sensitive is logged: no token, credential, contact name or email address. (The organisation's own name and id
  are shown in inspect mode so you can confirm them.) An unrecognised command-line argument is rejected **without being
  repeated**, in case it was a secret typed by mistake.

## What the export contains

Per contact: `contactId`, `status`, name, email, account number, addresses (`POBOX`/`STREET`), contact persons with their
`includeInEmails` flag, and **`mergedToContactId`** (set when the contact was merged into another in Xero, so a link to a
merged-away contact can be traced to its survivor). Bank and tax details are not exported.

At the end the tool prints **aggregate counts only** (also saved in the file's `meta.detail`): how many contacts have a
real address, an email, contact persons, how many contact persons are flagged to receive invoice emails, and how many
contacts were merged away. If many contacts come back with no address or no contact persons, check that Xero returned
full detail before relying on the file.

## If a run fails or is interrupted

The export is held in memory until every page has arrived, then written to a temporary file, flushed, and only then
given its final `.json` name by a rename. So a `.json` file with its `.sha256` next to it is complete, and a failed
run leaves neither. If a write fails, the files that run created are removed (a file that was already there is never
touched).

If the program is **killed, or the machine loses power, while writing**, leftovers can remain in the folder: a
`<name>.json.<random>.tmp` file (it can hold real contact data) and/or a `<name>.json.sha256` with no `.json`. Look for
them and **delete them** (see below). A leftover `.sha256` also makes the next run refuse that file name until it is
removed.

## Keeping and deleting the export

It is a temporary working file for the linking review, not an archive.

- Keep it in the private local folder only. Do not email it, upload it, put it on a USB stick or shared drive, or paste
  it into a chat or an AI tool. Treat any review sheet derived from it the same way.
- **Delete it when the review is finished**, and no later than a limit agreed with Luke (30 days is a sensible default).
  Delete **both** files: `contacts.json` and `contacts.json.sha256`.

```powershell
Remove-Item -LiteralPath 'C:\path\to\contacts.json', 'C:\path\to\contacts.json.sha256'    # skips the Recycle Bin
```
```bash
rm -- /path/to/contacts.json /path/to/contacts.json.sha256
```

- Deleting in Explorer sends the file to the Recycle Bin: empty it.
- **Deleting does not guarantee the data cannot be recovered**: copies can remain in disk free space, backups, File
  History, Previous Versions and other backup software. The real protections are a disk that is encrypted (BitLocker or
  device encryption), a folder excluded from backups, and a short retention. On NTFS, `cipher /w:<folder>` overwrites
  free space in that folder's volume (it can take a long time).
- Note the date you deleted it.

## Checks

Type-check: `npx tsc -p tools/xero-contact-export/tsconfig.json` (the repository has no `@types/node`, and nothing is
installed for this, so `node-stubs.d.ts` declares the few Node APIs used). Tests: `npm test`
(`tests/xeroContactExport.test.ts`).
