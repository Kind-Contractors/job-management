import { useState } from 'react';
import type { JobRow } from '../../domain/types';

interface JobInspectorDrawerProps {
  job: JobRow;
  siblings: JobRow[];
  onClose: () => void;
  onSelectSibling: (jobId: string) => void;
}

const NOT_BUILT_TITLE = 'Not built yet — this pass only covers the All live jobs view';

export default function JobInspectorDrawer({ job, siblings, onClose, onSelectSibling }: JobInspectorDrawerProps) {
  const [revealed, setRevealed] = useState(false);

  const facts: [string, string][] = [
    ['Client', job.clientName],
    ['Invoice address', job.clientInvoiceAddress.split(',')[0]],
    ['Price per visit', `£${job.pricePerVisit.toLocaleString('en-GB')}.00`],
    ['Contract per year', job.yearlyValue ? `£${job.yearlyValue.toLocaleString('en-GB')}.00` : 'On request'],
    ['Assigned', job.team],
    ['Next visit', job.nextDueLabel],
  ];

  return (
    <aside className="hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white lg:flex">
      <div className="border-b border-divider p-4">
        <div className="flex items-center gap-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Job · {job.id}
          <button onClick={onClose} className="ml-auto font-body text-sm text-neutral-500 hover:text-ink">
            ✕
          </button>
        </div>
        <h2 className="mt-1.5 font-heading text-xl leading-tight font-semibold">{job.jobSummary}</h2>
        <div className="text-[13px]">
          <span className="text-neutral-600">{job.buildingName} · {job.street}, {job.postcode}</span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span
            className={`px-2 py-0.5 font-heading text-[10.5px] font-semibold tracking-[0.09em] uppercase ${
              job.division === 'Specialist'
                ? 'border border-teal-700 bg-teal-100 text-teal-700'
                : 'border border-neutral-300 bg-neutral-200 text-neutral-700'
            }`}
          >
            {job.division}
          </span>
          <span className="border border-neutral-300 px-2 py-0.5 font-heading text-[10.5px] font-semibold tracking-[0.09em] text-neutral-700 uppercase">
            {job.schedulePattern}
          </span>
        </div>
      </div>

      {job.status === 'review' && (
        <div className="m-3.5 border border-teal-700/40 bg-teal-100 p-3">
          <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-teal-700 uppercase">
            Report waiting on you
          </div>
          <div className="mt-1 mb-2.5 text-[12.5px] leading-snug text-teal-700">
            This job has a submitted report awaiting your review.
          </div>
          <div
            title={NOT_BUILT_TITLE}
            className="inline-block cursor-not-allowed bg-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-500"
          >
            Review report
          </div>
        </div>
      )}
      {job.status === 'needs_booking' && (
        <div className="m-3.5 border border-due bg-due/10 p-3">
          <div className="font-heading text-[11px] font-semibold tracking-[0.11em] text-due-fg uppercase">
            Due, no date set
          </div>
          <div className="mt-1 mb-2.5 text-[12.5px] leading-snug text-ink">
            Pattern is {job.schedulePattern}.
          </div>
          <div className="flex gap-1.5">
            <div
              title={NOT_BUILT_TITLE}
              className="cursor-not-allowed bg-neutral-300 px-3 py-1.5 text-xs font-semibold text-neutral-500"
            >
              Book this job
            </div>
            <div
              title={NOT_BUILT_TITLE}
              className="cursor-not-allowed border border-neutral-300 px-3 py-1.5 text-xs text-neutral-500"
            >
              Open the week
            </div>
          </div>
        </div>
      )}

      <div className="px-4 pt-3.5">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-divider py-1.5 text-[12.5px]">
            <span className="text-neutral-600">{k}</span>
            <span className="tabular-nums">{v}</span>
          </div>
        ))}
      </div>

      <div className="m-3.5 border border-dashed border-neutral-400 bg-neutral-100 p-3">
        <div className="flex items-center gap-2">
          <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
            Internal only · access
          </div>
          <button
            onClick={() => setRevealed((r) => !r)}
            className="ml-auto cursor-pointer text-[11.5px] text-teal-700 hover:underline"
          >
            {revealed ? 'Hide' : 'Reveal'}
          </button>
        </div>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
          {revealed ? job.buildingInternalAccessNote : 'Hidden. Reveal to show key safe, keyholder and parking details.'}
        </div>
      </div>

      {siblings.length > 0 && (
        <div className="px-4 pb-1">
          <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Also at this building
          </div>
          {siblings.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelectSibling(s.id)}
              className="flex cursor-pointer justify-between border-b border-divider py-1.5 text-[12.5px] hover:text-teal-700"
            >
              {s.jobSummary} · {s.frequency}
              <span className="text-neutral-600 tabular-nums">£{s.pricePerVisit.toLocaleString('en-GB')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-1.5 border-t border-divider p-3.5">
        <div title={NOT_BUILT_TITLE} className="cursor-not-allowed border border-neutral-300 px-3 py-1.5 text-xs text-neutral-500">
          Building file
        </div>
        <div title={NOT_BUILT_TITLE} className="cursor-not-allowed border border-neutral-300 px-3 py-1.5 text-xs text-neutral-500">
          Edit job
        </div>
        <div title={NOT_BUILT_TITLE} className="cursor-not-allowed border border-neutral-300 px-3 py-1.5 text-xs text-neutral-500">
          See the year
        </div>
      </div>
    </aside>
  );
}
