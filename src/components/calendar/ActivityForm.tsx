import { useState } from 'react';
import type { Technician } from '../../domain/types';
import AutoGrowTextarea from '../shared/AutoGrowTextarea';
import TimeRangeFields from './TimeRangeFields';
import {
  ACTIVITY_DESCRIPTION_MAX,
  ACTIVITY_LOCATION_MAX,
  ACTIVITY_NOTES_MAX,
  validateActivityInput,
  type ActivityFormValues,
} from '../../lib/activityInput';

interface ActivityFormProps {
  mode: 'create' | 'edit';
  initial: ActivityFormValues;
  technicians: Technician[];
  /** Edit mode shows the date so an activity can be rescheduled (its time is kept; the database clears its order). */
  showDate: boolean;
  pending: boolean;
  error: string | null;
  /** Set once the assigned technician has marked it done (edit mode only) - shown as a note. */
  doneNote?: string | null;
  onSubmit: (values: ActivityFormValues) => void;
  /** Edit mode: leave without saving. */
  onClose?: () => void;
  /** Edit mode: cancel the activity itself (soft - the row is kept). Asks for confirmation first. */
  onCancelActivity?: () => void;
}

/**
 * Create / edit an Activity: a short description (required), one optional assignee ("Unassigned" is a
 * normal choice), an optional location and notes, and an optional time (none, a start, or a start + end).
 * Presentational only - the mutations live in ScheduleDayDrawer. A time is display-only and never
 * reorders anything.
 */
export default function ActivityForm({ mode, initial, technicians, showDate, pending, error, doneNote, onSubmit, onClose, onCancelActivity }: ActivityFormProps) {
  const [values, setValues] = useState<ActivityFormValues>(initial);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof ActivityFormValues>(key: K, value: ActivityFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  // Active technicians can be chosen. In edit mode the current assignee stays selectable even if they have since been deactivated.
  const options = technicians.filter((t) => t.isActive || t.id === initial.technicianId);
  const problem = validateActivityInput(values);
  const fieldClass = 'border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-teal';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!problem) onSubmit(values);
      }}
      className="flex flex-col gap-2.5"
    >
      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        What is it?
        <input
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={ACTIVITY_DESCRIPTION_MAX}
          placeholder="e.g. Pick up keys, Quote at Oak Court, Client meeting"
          aria-label="Activity description"
          className={fieldClass}
        />
      </label>

      {showDate && (
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Date
          <input type="date" value={values.scheduledDate} onChange={(e) => set('scheduledDate', e.target.value)} aria-label="Activity date" className={fieldClass} />
        </label>
      )}

      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Who
        <select value={values.technicianId} onChange={(e) => set('technicianId', e.target.value)} aria-label="Assigned technician" className={fieldClass}>
          <option value="">Unassigned</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.isActive ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
      </label>

      <TimeRangeFields start={values.startTime} end={values.endTime} onChange={(s, e) => setValues((v) => ({ ...v, startTime: s, endTime: e }))} label="Activity" />

      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Location (optional)
        <input value={values.location} onChange={(e) => set('location', e.target.value)} maxLength={ACTIVITY_LOCATION_MAX} aria-label="Activity location" className={fieldClass} />
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
        Notes (optional)
        <AutoGrowTextarea
          value={values.notes}
          onChange={(e) => set('notes', e.target.value)}
          maxLength={ACTIVITY_NOTES_MAX}
          minRows={2}
          aria-label="Activity notes"
          className={fieldClass}
        />
      </label>

      {doneNote && <div className="border border-done bg-done/10 px-2 py-1 text-[11.5px] text-done-fg">{doneNote}</div>}
      {(touched && problem) || error ? (
        <div role="alert" className="border border-missed bg-missed/10 px-2 py-1 text-[11.5px] text-missed-fg">
          {(touched && problem) || error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending || (touched && problem != null)}
          className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Saving…' : mode === 'create' ? 'Save activity' : 'Save changes'}
        </button>
        {mode === 'edit' && onClose && (
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
          >
            Back
          </button>
        )}
        {mode === 'edit' && onCancelActivity && !confirmingCancel && (
          <button
            type="button"
            onClick={() => setConfirmingCancel(true)}
            disabled={pending}
            className="ml-auto cursor-pointer border border-missed bg-white px-3 py-1.5 text-xs text-missed-fg hover:bg-missed/10 disabled:opacity-60"
          >
            Cancel activity
          </button>
        )}
      </div>

      {mode === 'edit' && onCancelActivity && confirmingCancel && (
        <div className="flex flex-col gap-1.5 border border-missed bg-missed/10 p-2 text-[11.5px] text-ink">
          <div>Cancel this activity? It is removed from the day and from the technician's list. The record is kept.</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancelActivity}
              disabled={pending}
              className="cursor-pointer bg-missed px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
            >
              {pending ? 'Cancelling…' : 'Yes, cancel it'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingCancel(false)}
              disabled={pending}
              className="cursor-pointer border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
