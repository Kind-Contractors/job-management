// Automatic saving of the manager's edits to a report's text (Report Review). There is no "Save changes" button: what the manager
// types is kept, and Approve / Return / Resubmit save anything still pending FIRST (and refuse to go on if that save fails), so an edit
// can never be lost by clicking Approve.
//
// Three more rules live here so they can be tested without a browser:
//  * LOCKED: once a report is approved, Completed or sent to the client its text is not editable, and nothing pending is ever written.
//  * EXTERNAL CHANGES: if the stored text changes while the report is open (a technician resubmits, another tab saves), the manager's
//    unsaved typing is never overwritten and the new text is never silently replaced either - it is surfaced for the manager to see
//    (`changedElsewhere`) or to choose between (`conflicts`). Every write also says what text it expects to replace, so the database
//    refuses it if the text changed in the meantime.
//  * FLUSH IS ALL-OR-ERROR: `flush()` resolves only when nothing is pending any more; otherwise it throws.
//
// Plain code with injectable timers, so it is tested without a browser (same approach as videoUploadController.ts).

export type TextField = 'workCarriedOut' | 'issues' | 'technicianNotes';
export type TextValues = Partial<Record<TextField, string | null | undefined>>;
export type TextEdits = Partial<Record<TextField, string>>;
export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

const FIELDS: TextField[] = ['workCarriedOut', 'issues', 'technicianNotes'];
export const MAX_FLUSH_ROUNDS = 6;

export const FIELD_LABEL: Record<TextField, string> = {
  workCarriedOut: 'Work carried out',
  issues: 'Notes / Issues',
  technicianNotes: 'Optional notes',
};

export interface AutosaveState {
  status: AutosaveStatus;
  /** Plain-words reason when status is 'error'. */
  error: string | null;
}

/** The report fields that decide whether its text may still be edited. */
export interface TextLockInput {
  reviewStatus: string;
  completedAt?: string | null;
  sentToClientAt?: string | null;
}

/** The text is editable only while the report is awaiting review or returned for correction: approved, Completed and sent reports are locked. */
export function isReportTextLocked(report: TextLockInput): boolean {
  return report.reviewStatus === 'approved' || (report.completedAt ?? null) != null || (report.sentToClientAt ?? null) != null;
}

/** Why the text is locked, in plain words (null when it is not). */
export function reportTextLockReason(report: TextLockInput): string | null {
  if (!isReportTextLocked(report)) return null;
  if ((report.sentToClientAt ?? null) != null) return 'This report has been sent to the client, so its text is locked.';
  if ((report.completedAt ?? null) != null) return 'This report is Completed, so its text is locked.';
  return 'This report is approved, so its text is locked.';
}

const norm = (v: string | null | undefined): string => v ?? '';

/** The fields whose edited text really differs from what is stored (null and '' count as the same empty text). Only these are sent. */
export function changedFields(saved: TextValues, edits: TextEdits): TextEdits {
  const out: TextEdits = {};
  for (const field of Object.keys(edits) as TextField[]) {
    const edited = edits[field];
    if (edited !== undefined && edited !== norm(saved[field])) out[field] = edited;
  }
  return out;
}

export interface AutosaveDeps {
  /** What the database holds, as last loaded (null until the report has loaded). Read again on every `sync()`. */
  getSaved: () => TextValues | null;
  /** True when the text may no longer be edited (approved, Completed, sent). Nothing is written while it is. */
  isLocked?: () => boolean;
  /**
   * Writes only the changed fields. `expected` is the stored text each of them is about to replace: the write must be refused (throw)
   * if the database now holds something else. Must throw if the write fails.
   */
  save: (patch: TextEdits, expected: TextValues) => Promise<void>;
  onState?: (state: AutosaveState) => void;
  /** Quiet time after the last keystroke before saving. */
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 1500;

export class ReportTextAutosave {
  private edits: TextEdits = {};
  /** The text the database is believed to hold for each field (the report as loaded, then what this controller wrote). */
  private base: TextValues = {};
  /** After our own write, a report read that is not up to date yet still shows the OLD text: it is ignored until it catches up. */
  private staleFrom: Partial<Record<TextField, string>> = {};
  private conflictServer: TextEdits = {};
  private elsewhere = new Set<TextField>();
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private state: AutosaveState = { status: 'idle', error: null };

  constructor(private readonly deps: AutosaveDeps) {}

  get current(): AutosaveState {
    return this.state;
  }

  /** Fields the manager edited while the stored text was changed elsewhere: their version is kept, unsaved, until they choose. */
  get conflicts(): TextField[] {
    return FIELDS.filter((f) => this.conflictServer[f] !== undefined);
  }

  /** The text someone else saved for a conflicting field. */
  serverText(field: TextField): string {
    return this.conflictServer[field] ?? '';
  }

  /** Fields whose stored text changed elsewhere while open; the new text is already shown. Approve waits until the manager has seen it. */
  get changedElsewhere(): TextField[] {
    return FIELDS.filter((f) => this.elsewhere.has(f));
  }

  /** True while anything the manager typed is not safely stored (so leaving the page would lose it). */
  hasUnsavedWork(): boolean {
    if (this.locked()) return false;
    return this.inFlight !== null || Object.keys(changedFields(this.base, this.edits)).length > 0;
  }

  /** The text to show in a field: what is being typed, else what the database is believed to hold. */
  value(field: TextField): string {
    return this.edits[field] ?? norm(this.base[field]);
  }

  /**
   * Compare the report as just loaded with what this controller knows. Safe to call on every render (it changes nothing when nothing
   * changed, and never notifies unless asked). A text that differs from what we know and is not our own write is an external change:
   * adopted and flagged when the manager has no edit on that field, otherwise kept apart as a conflict.
   */
  sync(values: TextValues | null = this.deps.getSaved(), notify = false): void {
    if (!values) return;
    let changed = false;
    for (const field of FIELDS) {
      const server = values[field];
      if (server === undefined) continue;
      if (!(field in this.base)) {
        this.base[field] = server;
        continue;
      }
      const s = norm(server);
      if (s === norm(this.base[field])) {
        delete this.staleFrom[field];
        continue;
      }
      if (this.staleFrom[field] !== undefined && s === this.staleFrom[field]) continue; // our own write has not shown up in the report read yet
      delete this.staleFrom[field];
      this.base[field] = server;
      changed = true;
      const mine = this.edits[field];
      if (mine !== undefined && mine !== s) {
        this.conflictServer[field] = s;
      } else {
        delete this.edits[field];
        delete this.conflictServer[field];
        this.elsewhere.add(field);
      }
    }
    if (this.locked() && this.hasEditState()) {
      this.dropEdits();
      this.state = { status: 'idle', error: null };
      changed = true;
    }
    if (changed && notify) this.notify();
  }

  /** The manager typed. Saves after a quiet moment. Ignored once the text is locked. */
  edit(field: TextField, text: string): void {
    if (this.locked()) return;
    this.edits[field] = text;
    this.setState({ status: this.conflicts.length > 0 ? 'conflict' : 'pending', error: null });
    if (this.conflicts.length === 0) this.startTimer();
  }

  /** A field lost focus: save now (in the background - a failure shows in the status line). */
  blur(): void {
    void this.flush().catch(() => undefined);
  }

  /** Conflict: keep the manager's version (it overwrites the newer stored text on the next save). */
  keepMine(field: TextField): void {
    delete this.conflictServer[field];
    this.setState({ status: this.conflicts.length > 0 ? 'conflict' : 'pending', error: null });
    if (this.conflicts.length === 0) this.startTimer();
  }

  /** Conflict: drop the manager's version and show the newer stored text. */
  useTheirs(field: TextField): void {
    delete this.conflictServer[field];
    delete this.edits[field];
    this.setState({ status: this.conflicts.length > 0 ? 'conflict' : Object.keys(this.edits).length > 0 ? 'pending' : 'idle', error: null });
    if (this.conflicts.length === 0 && Object.keys(this.edits).length > 0) this.startTimer();
  }

  /** The manager has read the text that changed elsewhere. */
  acknowledgeExternalChanges(): void {
    this.elsewhere.clear();
    this.notify();
  }

  /**
   * Saves everything pending and resolves ONLY when it is safely stored. REJECTS if a save fails, if a conflict is unresolved, or if
   * the text keeps changing and is still not stored after MAX_FLUSH_ROUNDS - callers that must not go on without the edits (Approve,
   * Return, Resubmit) await this and stop on the error. If the text is locked, pending edits are dropped, never written.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
      if (this.inFlight) {
        try {
          await this.inFlight;
        } catch {
          // the failure is reported below by the next attempt
        }
      }
      if (this.locked()) {
        this.dropEdits();
        this.setState({ status: 'idle', error: null });
        return;
      }
      this.dropUnchanged();
      const patch = changedFields(this.base, this.edits);
      if (Object.keys(patch).length === 0) {
        if (this.state.status === 'pending' || this.state.status === 'saving' || this.state.status === 'error' || this.state.status === 'conflict') {
          this.setState({ status: 'saved', error: null });
        }
        return;
      }
      const conflicting = this.conflicts;
      if (conflicting.length > 0) {
        this.setState({ status: 'conflict', error: null });
        throw new Error(`${conflicting.map((f) => `“${FIELD_LABEL[f]}”`).join(' and ')} was changed elsewhere while you were editing. Choose which version to keep first.`);
      }
      this.inFlight = this.write(patch);
      await this.inFlight; // throws on failure
    }
    // Out of rounds: the text was still changing. Never report success while something is unsaved.
    this.dropUnchanged();
    if (Object.keys(changedFields(this.base, this.edits)).length > 0) {
      const message = 'Your latest typing is not saved yet because the text kept changing. Stop typing for a moment and try again.';
      this.setState({ status: 'error', error: message });
      throw new Error(message);
    }
  }

  /** Forget everything unsaved (the report text was reset or replaced from elsewhere). `fresh` is the text now stored, if known. */
  discard(fresh?: TextValues): void {
    this.clearTimer();
    this.dropEdits();
    this.base = fresh ? { ...fresh } : {};
    this.staleFrom = {};
    this.setState({ status: 'idle', error: null });
  }

  /** The screen is going away: save what is pending (best effort, nobody is left to read an error) and stop the timer. */
  dispose(): void {
    this.clearTimer();
    void this.flush().catch(() => undefined);
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------------

  private locked(): boolean {
    return this.deps.isLocked?.() ?? false;
  }

  private hasEditState(): boolean {
    return Object.keys(this.edits).length > 0 || this.conflicts.length > 0 || this.timer !== null;
  }

  private dropEdits(): void {
    this.clearTimer();
    this.edits = {};
    this.conflictServer = {};
    this.elsewhere.clear();
  }

  private async write(patch: TextEdits): Promise<void> {
    const expected: TextValues = {};
    for (const field of Object.keys(patch) as TextField[]) expected[field] = this.base[field] ?? null;
    this.setState({ status: 'saving', error: null });
    try {
      await this.deps.save(patch, expected);
    } catch (err) {
      if (this.locked()) {
        // The report was approved (or Completed) while this save was running: its text is no longer ours to change.
        this.dropEdits();
        this.setState({ status: 'idle', error: null });
      } else if (this.conflicts.length > 0) this.setState({ status: 'conflict', error: null });
      else this.setState({ status: 'error', error: err instanceof Error && err.message ? err.message : 'Your changes could not be saved.' });
      throw err;
    } finally {
      this.inFlight = null;
    }
    for (const field of Object.keys(patch) as TextField[]) {
      const next = patch[field] as string;
      if (norm(this.base[field]) !== next) this.staleFrom[field] = norm(this.base[field]);
      this.base[field] = next;
      // Only forget the edit if the manager has not typed more since this save started.
      if (this.edits[field] === next) delete this.edits[field];
    }
    this.setState({ status: Object.keys(this.edits).length > 0 ? 'pending' : 'saved', error: null });
    if (Object.keys(this.edits).length > 0) this.startTimer();
  }

  private dropUnchanged(): void {
    for (const field of Object.keys(this.edits) as TextField[]) {
      if (this.edits[field] === norm(this.base[field])) {
        delete this.edits[field];
        delete this.conflictServer[field];
      }
    }
  }

  private startTimer(): void {
    this.clearTimer();
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.deps.debounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** Re-announce the current state (as a new object, so the screen re-renders). */
  private notify(): void {
    this.state = { ...this.state };
    this.deps.onState?.(this.state);
  }

  private setState(state: AutosaveState): void {
    this.state = state;
    this.deps.onState?.(state);
  }
}
