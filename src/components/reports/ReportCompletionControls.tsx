import type { ReactNode } from 'react';

// Small, presentational pieces for the "Completed" step of the Ready for client workflow. All state and every write
// live in ReadyForClientPage (CLAUDE.md section 12: orchestration in the container, not here).
//
// "Completed" is the manager's explicit "this report is fully dealt with". It is independent of HOW the report
// reached the client: downloaded and sent by hand, emailed through the system, or both.

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 'D Mon YYYY, HH:MM', or an em dash for a missing / unreadable value (never throws on a bad cached value). */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : DATE_TIME.format(d);
}

export type QueueView = 'awaiting' | 'completed';

/** Switches the Ready for client list between reports still awaiting completion and those already completed. */
export function ReadyForClientTabs({
  view,
  awaitingCount,
  completedCount,
  onChange,
}: {
  view: QueueView;
  awaitingCount: number;
  completedCount: number;
  onChange: (view: QueueView) => void;
}) {
  const tab = (value: QueueView, label: string, count: number) => (
    <button
      key={value}
      type="button"
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className={`flex-1 cursor-pointer px-2 py-1.5 text-[11.5px] font-semibold tabular-nums ${
        view === value ? 'bg-teal text-white' : 'bg-white text-neutral-700 hover:bg-neutral-100'
      }`}
    >
      {label} ({count})
    </button>
  );
  return (
    <div className="segmented mt-2 flex border border-neutral-300" role="group" aria-label="Show reports">
      {tab('awaiting', 'Awaiting completion', awaitingCount)}
      {tab('completed', 'Completed', completedCount)}
    </div>
  );
}

/** Marks an emailed report on its list card, so "sent through the system" is visible without leaving the queue. */
export function SentBadge({ sentAt }: { sentAt: string }) {
  return (
    <span title={`Emailed through the system on ${formatWhen(sentAt)}`} className="inline-block border border-done px-1 text-[10px] font-semibold text-done-fg">
      ✓ Sent to client
    </span>
  );
}

/** The "Completed" action, shown beside Download PDF and Send to client. It only asks for confirmation; the write is the page's. */
export function CompleteButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Mark this report as fully dealt with - it leaves this queue. Works whether you emailed it through the system or sent it by hand."
      className="cursor-pointer border border-teal-700 bg-white px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100 disabled:cursor-not-allowed disabled:opacity-60"
    >
      Completed
    </button>
  );
}

/** One-line confirmation before a report is marked Completed (it removes the report from the queue). */
export function CompleteConfirm({
  sentAt,
  pending,
  onConfirm,
  onCancel,
}: {
  /** When the report was emailed through the system, if it was. Null for a report delivered by hand or not yet delivered. */
  sentAt: string | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" aria-label="Confirm completed" className="mt-2 flex flex-col gap-1.5 border border-teal-700 bg-teal-100 p-2.5 text-[12px] text-ink">
      <div>
        Mark this report as <span className="font-semibold">Completed</span>? It will leave the Ready for client queue.{' '}
        {sentAt ? `It was emailed to the client on ${formatWhen(sentAt)}.` : 'It has not been emailed through the system - use this when you delivered it by hand.'}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="cursor-pointer bg-teal px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Mark completed'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="cursor-pointer border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Shown on a completed report: who completed it and when, with Reopen to put it back in the queue. */
export function CompletedBanner({
  completedAt,
  completedBy,
  sentAt,
  pending,
  onReopen,
}: {
  completedAt: string | null;
  completedBy: string | null;
  sentAt: string | null;
  pending: boolean;
  onReopen: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 border border-done bg-done/10 px-3 py-2 text-[12.5px] text-done-fg">
      <span className="font-heading text-[10.5px] font-semibold tracking-[0.1em] uppercase">Completed</span>
      <span>
        by {completedBy ?? 'unknown'} on {formatWhen(completedAt)}
        {sentAt ? ` · emailed to the client ${formatWhen(sentAt)}` : ' · delivered by hand (not emailed through the system)'}
      </span>
      <button
        type="button"
        onClick={onReopen}
        disabled={pending}
        title="Put this report back in the Ready for client queue"
        className="ml-auto cursor-pointer border border-done bg-white px-2.5 py-1 text-xs font-semibold text-done-fg hover:bg-done/10 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Reopening…' : 'Reopen'}
      </button>
      <div className="basis-full text-[11.5px]">
        A completed report can&rsquo;t be returned for correction, or have a technician&rsquo;s section sent back, until you reopen it.
      </div>
    </div>
  );
}

/**
 * Explains the one rule completion adds: a completed report cannot be returned for correction, or have a technician's
 * section sent back, until it is reopened. Shown on a completed report wherever those actions would otherwise live.
 */
export function ReopenFirstNotice({ completedBy, completedAt, children }: { completedBy: string | null; completedAt: string | null; children?: ReactNode }) {
  return (
    <div role="note" className="border border-done bg-done/10 p-2 text-[11.5px] text-done-fg">
      <span className="font-semibold">Completed</span> by {completedBy ?? 'unknown'} on {formatWhen(completedAt)}. To return this report for correction,
      or send a technician&rsquo;s section back, reopen it first: Ready for client &rarr; Completed &rarr; Reopen.
      {children}
    </div>
  );
}
