import { timeRangeError } from '../../lib/timeRange';

interface TimeRangeFieldsProps {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  disabled?: boolean;
  /** Prefix for the inputs' accessible names, e.g. "Visit" or "Activity". */
  label?: string;
}

/**
 * The optional time of day for a job or an activity: leave both empty for no time, fill only the
 * start for "from 09:00", or fill both for a range such as 09:00-11:00. The end box is disabled until
 * there is a start, and an invalid pair is explained underneath (the database enforces the same rule).
 * A time is display-only - it never reorders anything.
 */
export default function TimeRangeFields({ start, end, onChange, disabled, label = 'Item' }: TimeRangeFieldsProps) {
  const problem = timeRangeError(start, end);
  const inputClass =
    'border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal disabled:bg-neutral-100 disabled:text-neutral-400';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
          Start time (optional)
          <input
            type="time"
            value={start}
            disabled={disabled}
            aria-label={`${label} start time`}
            onChange={(e) => onChange(e.target.value, e.target.value === '' ? '' : end)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
          End time (optional)
          <input
            type="time"
            value={end}
            disabled={disabled || start === ''}
            aria-label={`${label} end time`}
            onChange={(e) => onChange(start, e.target.value)}
            className={inputClass}
          />
        </label>
        {(start !== '' || end !== '') && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange('', '')}
            className="cursor-pointer border border-neutral-300 bg-white px-2 py-1.5 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
      {problem && <div className="text-[11px] text-missed-fg">{problem}</div>}
    </div>
  );
}
