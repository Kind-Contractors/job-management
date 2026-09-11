import type { JobRow } from '../../domain/types';

const GROUPS: { key: 'overdue' | 'unscheduled'; label: string; emptyLabel: string }[] = [
  { key: 'overdue', label: 'Overdue', emptyLabel: 'Nothing overdue' },
  { key: 'unscheduled', label: 'Needs booking', emptyLabel: 'Nothing waiting' },
];

/**
 * The same Overdue/Needs-booking drag source that used to be a permanently
 * docked 220px sidebar — now a panel the manager opens on demand from the
 * toolbar's "Jobs to book" button, so it doesn't compete with the
 * calendar for width/attention except when actually being worked from.
 * Same data (`overdueJobs`/`needsBookingJobs`, already Division-filtered in
 * ThisWeekPage.tsx), same drag-and-drop behavior — only the presentation
 * changed.
 */
export default function NeedsAttentionPanel({
  overdueJobs,
  needsBookingJobs,
  onClose,
}: {
  overdueJobs: JobRow[];
  needsBookingJobs: JobRow[];
  onClose: () => void;
}) {
  return (
    <div className="absolute top-full right-0 z-20 mt-1.5 flex w-[300px] flex-col border border-neutral-300 bg-white shadow-lg">
      <div className="flex items-center gap-2 border-b border-neutral-300 bg-neutral-100 px-3 py-2">
        <span className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
          Jobs to book
        </span>
        <button onClick={onClose} className="ml-auto cursor-pointer px-1 text-neutral-500 hover:text-ink" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="max-h-[420px] overflow-y-auto px-3 py-2.5">
        {GROUPS.map(({ key, label, emptyLabel }) => {
          const groupJobs = key === 'overdue' ? overdueJobs : needsBookingJobs;
          return (
            <div key={key} className="mb-3.5 last:mb-0">
              <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                {label} <span className="text-neutral-400">({groupJobs.length})</span>
              </div>
              {groupJobs.length === 0 ? (
                <div className="text-[11px] text-neutral-400">{emptyLabel}</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {groupJobs.map((job) => (
                    <div
                      key={job.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', job.id)}
                      title={`${job.jobSummary} · ${job.buildingName}`}
                      className="cursor-grab border border-neutral-300 bg-white px-2 py-1.5 text-[11px] hover:border-teal active:cursor-grabbing"
                    >
                      <div className="truncate font-semibold text-ink">{job.buildingName}</div>
                      <div className="truncate text-neutral-600">{job.jobSummary}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-neutral-300 px-3 py-2 text-[10.5px] leading-normal text-neutral-500">
        Drag a job onto a day (or a technician's day) to book it.
      </div>
    </div>
  );
}
