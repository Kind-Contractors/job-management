import { useState } from 'react';
import NeedsAttentionPanel from './NeedsAttentionPanel';
import type { JobRow } from '../../domain/types';

/**
 * One consolidated control row — date navigation, view switch, search, and
 * filters all at the same visual weight, replacing the old single
 * overloaded flex row. Fully presentational: every value/handler comes from
 * ThisWeekPage.tsx, which still owns all state/queries/mutations (CLAUDE.md
 * section 12).
 *
 * Division is deliberately not shown here — it already has one home, the
 * left rail's Division control (NavRail.tsx), which every page including
 * this one already reads via the same shared `division` URL param. A
 * second copy here was tried and removed per feedback — one control per
 * piece of shared state, not two.
 */
export default function ScheduleToolbar({
  mode,
  onModeChange,
  dateRangeLabel,
  onPrev,
  onNext,
  onToday,
  isAtToday,
  datePickerValue,
  onDatePick,
  q,
  onQueryChange,
  overdueJobs,
  needsBookingJobs,
}: {
  mode: 'day' | 'week' | 'month';
  onModeChange: (m: 'day' | 'week' | 'month') => void;
  dateRangeLabel: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  isAtToday: boolean;
  datePickerValue: string;
  onDatePick: (value: string) => void;
  q: string;
  onQueryChange: (value: string) => void;
  overdueJobs: JobRow[];
  needsBookingJobs: JobRow[];
}) {
  const [needsAttentionOpen, setNeedsAttentionOpen] = useState(false);
  const needsAttentionCount = overdueJobs.length + needsBookingJobs.length;

  return (
    <div className="flex flex-none flex-wrap items-center gap-2 border-y border-neutral-300 bg-neutral-100 px-5 py-2.5">
      <div className="flex items-center border border-neutral-300 bg-white">
        <button onClick={onToday} className="cursor-pointer border-r border-neutral-300 px-2.5 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100">
          Today
        </button>
        <button onClick={onPrev} className="cursor-pointer border-r border-neutral-300 px-2 py-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-ink">
          ‹
        </button>
        <button onClick={onNext} className="cursor-pointer px-2 py-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-ink">
          ›
        </button>
      </div>

      <div className={`text-[13px] font-semibold ${isAtToday ? 'text-ink' : 'text-teal-700'}`}>{dateRangeLabel}</div>

      <input
        type="date"
        value={datePickerValue}
        onChange={(e) => onDatePick(e.target.value)}
        title="Jump to date"
        className="border border-neutral-300 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-teal"
      />

      <div className="flex border border-neutral-300 bg-white">
        <button
          onClick={() => onModeChange('day')}
          className={`px-3 py-1.5 text-xs cursor-pointer ${mode === 'day' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
        >
          Day
        </button>
        <button
          onClick={() => onModeChange('week')}
          className={`border-l border-neutral-300 px-3 py-1.5 text-xs cursor-pointer ${mode === 'week' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
        >
          Week
        </button>
        <button
          onClick={() => onModeChange('month')}
          className={`border-l border-neutral-300 px-3 py-1.5 text-xs cursor-pointer ${mode === 'month' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
        >
          Month
        </button>
      </div>

      <input
        value={q}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search building, job, technician…"
        className="w-[220px] border border-neutral-300 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-teal"
      />

      <div className="relative ml-auto">
        <button
          onClick={() => setNeedsAttentionOpen((o) => !o)}
          className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 text-xs ${
            needsAttentionOpen ? 'border-teal bg-teal-100 text-teal-700' : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100'
          }`}
        >
          Needs attention
          {needsAttentionCount > 0 && (
            <span className="border border-current px-1 text-[10.5px] tabular-nums">{needsAttentionCount}</span>
          )}
        </button>
        {needsAttentionOpen && (
          <NeedsAttentionPanel
            overdueJobs={overdueJobs}
            needsBookingJobs={needsBookingJobs}
            onClose={() => setNeedsAttentionOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
