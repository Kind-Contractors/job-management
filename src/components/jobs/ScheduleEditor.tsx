import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Schedule, ScheduleIntervalUnit, ScheduleType, ScheduleWeekOrdinal, ScheduleWeekday } from '../../domain/types';
import { deleteSchedule, upsertSchedule, type ScheduleInput } from '../../repository/schedulesRepository';
import { describeSchedule } from '../../lib/scheduleFormat';

const SCHEDULE_TYPE_LABEL: Record<ScheduleType, string> = {
  fixed_weekday: 'Fixed weekday',
  fixed_date: 'Fixed date',
  due_month: 'Due month',
  ad_hoc: 'Ask / ad-hoc',
};

const INTERVAL_UNITS: ScheduleIntervalUnit[] = ['week', 'month', 'quarter', 'year'];
const WEEKDAYS: ScheduleWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_LABEL: Record<ScheduleWeekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
const WEEK_ORDINALS: ScheduleWeekOrdinal[] = ['1st', '2nd', '3rd', '4th', 'last'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface FormState {
  scheduleType: ScheduleType | '';
  intervalUnit: ScheduleIntervalUnit;
  intervalCount: string;
  weekday: ScheduleWeekday;
  weekOrdinal: ScheduleWeekOrdinal;
  dayOfMonth: string;
  rollForwardOnWeekend: boolean;
  dueMonth: string;
  notes: string;
}

const BLANK_FORM: FormState = {
  scheduleType: '',
  intervalUnit: 'month',
  intervalCount: '1',
  weekday: 'mon',
  weekOrdinal: '1st',
  dayOfMonth: '1',
  rollForwardOnWeekend: true,
  dueMonth: '1',
  notes: '',
};

function formFromSchedule(s: Schedule): FormState {
  return {
    scheduleType: s.scheduleType,
    intervalUnit: s.intervalUnit ?? 'month',
    intervalCount: s.intervalCount != null ? String(s.intervalCount) : '1',
    weekday: s.weekday ?? 'mon',
    weekOrdinal: s.weekOrdinal ?? '1st',
    dayOfMonth: s.dayOfMonth != null ? String(s.dayOfMonth) : '1',
    rollForwardOnWeekend: s.rollForwardOnWeekend,
    dueMonth: s.dueMonth != null ? String(s.dueMonth) : '1',
    notes: s.notes ?? '',
  };
}

/** Builds a validated ScheduleInput, or null while the form is incomplete/invalid — never inferred from frequency, only from what's typed here. */
function toInput(form: FormState): ScheduleInput | null {
  const notes = form.notes.trim() || null;

  if (form.scheduleType === 'ad_hoc') {
    return { scheduleType: 'ad_hoc', notes };
  }

  const intervalCount = Number(form.intervalCount);
  if (!Number.isInteger(intervalCount) || intervalCount < 1) return null;

  if (form.scheduleType === 'fixed_weekday') {
    return {
      scheduleType: 'fixed_weekday',
      intervalUnit: form.intervalUnit,
      intervalCount,
      weekday: form.weekday,
      weekOrdinal: form.weekOrdinal,
      notes,
    };
  }

  if (form.scheduleType === 'fixed_date') {
    const dayOfMonth = Number(form.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
    return {
      scheduleType: 'fixed_date',
      intervalUnit: form.intervalUnit,
      intervalCount,
      dayOfMonth,
      rollForwardOnWeekend: form.rollForwardOnWeekend,
      notes,
    };
  }

  if (form.scheduleType === 'due_month') {
    const dueMonth = Number(form.dueMonth);
    if (!Number.isInteger(dueMonth) || dueMonth < 1 || dueMonth > 12) return null;
    return { scheduleType: 'due_month', intervalUnit: form.intervalUnit, intervalCount, dueMonth, notes };
  }

  return null;
}

interface ScheduleEditorProps {
  jobId: string;
  schedule: Schedule | null;
}

export default function ScheduleEditor({ jobId, schedule }: ScheduleEditorProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-remove'>('view');
  const [form, setForm] = useState<FormState>(schedule ? formFromSchedule(schedule) : BLANK_FORM);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['jobRows'] });

  const saveMutation = useMutation({
    mutationFn: (input: ScheduleInput) => upsertSchedule(jobId, input),
    onSuccess: () => {
      invalidate();
      setMode('view');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save schedule.'),
  });

  const removeMutation = useMutation({
    mutationFn: () => deleteSchedule(jobId),
    onSuccess: () => {
      invalidate();
      setMode('view');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to remove schedule.'),
  });

  const startEdit = () => {
    setForm(schedule ? formFromSchedule(schedule) : BLANK_FORM);
    setError(null);
    setMode('edit');
  };

  const input = toInput(form);

  return (
    <div className="m-3.5 border border-neutral-300 p-3">
      <div className="flex items-center gap-2">
        <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Schedule</div>
        {mode === 'view' && (
          <div className="ml-auto flex gap-2.5">
            <button onClick={startEdit} className="cursor-pointer text-[11.5px] text-teal-700 hover:underline">
              {schedule ? 'Edit' : 'Add schedule'}
            </button>
            {schedule && (
              <button
                onClick={() => setMode('confirm-remove')}
                className="cursor-pointer text-[11.5px] text-missed-fg hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      {mode === 'view' && (
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-700">
          {schedule ? (
            <>
              {describeSchedule(schedule)}
              {schedule.notes && <div className="mt-1 text-neutral-500">{schedule.notes}</div>}
            </>
          ) : (
            'No schedule set for this job.'
          )}
        </div>
      )}

      {mode === 'confirm-remove' && (
        <div className="mt-2 flex flex-col gap-1.5 border border-due bg-due/10 p-2.5">
          <div className="text-[12.5px] text-due-fg">Remove this schedule? This job returns to "no schedule set".</div>
          {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}
          <div className="flex gap-1.5">
            <button
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
              className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-60"
            >
              {removeMutation.isPending ? 'Removing…' : 'Confirm remove'}
            </button>
            <button
              onClick={() => setMode('view')}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === 'edit' && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Type
            <select
              value={form.scheduleType}
              onChange={(e) => setForm({ ...form, scheduleType: e.target.value as ScheduleType | '' })}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            >
              <option value="" disabled>
                Choose a type…
              </option>
              {(Object.keys(SCHEDULE_TYPE_LABEL) as ScheduleType[]).map((t) => (
                <option key={t} value={t}>
                  {SCHEDULE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>

          {(form.scheduleType === 'fixed_weekday' || form.scheduleType === 'fixed_date' || form.scheduleType === 'due_month') && (
            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
                Every
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={form.intervalCount}
                  onChange={(e) => setForm({ ...form, intervalCount: e.target.value })}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
                Unit
                <select
                  value={form.intervalUnit}
                  onChange={(e) => setForm({ ...form, intervalUnit: e.target.value as ScheduleIntervalUnit })}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                >
                  {INTERVAL_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {form.scheduleType === 'fixed_weekday' && (
            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
                Which occurrence
                <select
                  value={form.weekOrdinal}
                  onChange={(e) => setForm({ ...form, weekOrdinal: e.target.value as ScheduleWeekOrdinal })}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                >
                  {WEEK_ORDINALS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
                Weekday
                <select
                  value={form.weekday}
                  onChange={(e) => setForm({ ...form, weekday: e.target.value as ScheduleWeekday })}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                >
                  {WEEKDAYS.map((w) => (
                    <option key={w} value={w}>
                      {WEEKDAY_LABEL[w]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {form.scheduleType === 'fixed_date' && (
            <>
              <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                Day of month
                <input
                  type="number"
                  min={1}
                  max={31}
                  step={1}
                  value={form.dayOfMonth}
                  onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })}
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-neutral-600">
                <input
                  type="checkbox"
                  checked={form.rollForwardOnWeekend}
                  onChange={(e) => setForm({ ...form, rollForwardOnWeekend: e.target.checked })}
                />
                Roll forward to next working day if it falls on a weekend
              </label>
            </>
          )}

          {form.scheduleType === 'due_month' && (
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Due month
              <select
                value={form.dueMonth}
                onChange={(e) => setForm({ ...form, dueMonth: e.target.value })}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          {form.scheduleType !== '' && (
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              Notes (optional)
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>
          )}

          {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

          <div className="flex gap-1.5">
            <button
              onClick={() => input && saveMutation.mutate(input)}
              disabled={!input || saveMutation.isPending}
              className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save schedule'}
            </button>
            <button
              onClick={() => setMode('view')}
              className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
