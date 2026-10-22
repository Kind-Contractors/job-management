import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Division, FrequencyType } from '../../domain/types';
import { createJob, type JobCreateInput } from '../../repository/jobsRepository';
import { scheduleFromInput, upsertSchedule } from '../../repository/schedulesRepository';
import {
  buildFirstDueSchedule,
  firstDuePatternOptions,
  isMonthBasedFrequency,
  isWeekBasedFrequency,
  type FirstDuePattern,
} from '../../lib/firstDueSchedule';
import { describeSchedule } from '../../lib/scheduleFormat';
import { listBuildingRows } from '../../repository/buildingsRepository';
import { listTechnicians } from '../../repository/techniciansRepository';
import { FREQUENCY_TYPE_LABEL, computeDerivedPricing } from '../../repository/mapJobRow';
import { parseJobSummary, parsePricePerVisit } from './JobEditor';

const DIVISIONS: Division[] = ['General', 'Specialist'];
const FREQUENCY_TYPES = Object.keys(FREQUENCY_TYPE_LABEL) as FrequencyType[];

interface FormState {
  buildingId: string;
  jobSummary: string;
  jobNotes: string;
  division: Division;
  pricingType: 'fixed' | 'variable';
  pricePerVisit: string;
  frequencyType: FrequencyType | '';
  defaultTechnicianId: string;
  /** 'YYYY-MM-DD' or '' — blank means "create the job with no schedule", exactly as this form always did. */
  firstDueDate: string;
  firstDuePattern: FirstDuePattern;
  rollForwardOnWeekend: boolean;
}

function blankForm(presetBuildingId?: string, defaultFrequencyType?: FrequencyType): FormState {
  return {
    buildingId: presetBuildingId ?? '',
    jobSummary: '',
    jobNotes: '',
    division: 'General',
    pricingType: 'fixed',
    pricePerVisit: '',
    frequencyType: defaultFrequencyType ?? '',
    defaultTechnicianId: '',
    firstDueDate: '',
    firstDuePattern: 'fixed_date',
    rollForwardOnWeekend: true,
  };
}

/** Builds a validated JobCreateInput, or null while the form is incomplete/invalid — mirrors JobEditor.tsx's toInput() exactly (same fixed-pricing/positive-price rule), plus a required building. */
function toInput(form: FormState): JobCreateInput | null {
  if (!form.buildingId) return null;

  const jobSummary = parseJobSummary(form.jobSummary);
  if (!jobSummary) return null;

  let pricePerVisit: number | null = null;
  if (form.pricingType === 'fixed') {
    pricePerVisit = parsePricePerVisit(form.pricePerVisit);
    if (pricePerVisit == null) return null;
  }

  return {
    buildingId: form.buildingId,
    division: form.division,
    jobSummary,
    jobNotes: form.jobNotes.trim() || null,
    pricingType: form.pricingType,
    pricePerVisit,
    frequencyType: form.frequencyType || null,
    defaultTechnicianId: form.defaultTechnicianId || null,
  };
}

interface JobCreatorProps {
  /** Preset and locked when opened from Building File or Schedule — hides the building picker entirely. Editable via search when opened from All Live Jobs. */
  buildingId?: string;
  /** Preselects the Frequency field (still changeable) — used by Schedule's "+ Add new job for this building" flow to default to 'one_off' for the one-off jobs it exists for, without hard-coding that assumption into this shared form for its other callers. */
  defaultFrequencyType?: FrequencyType;
  onCreated: (jobId: string) => void;
  onCancel: () => void;
}

/**
 * The one job-creation form, shared by "+ New job" (All Live Jobs),
 * "+ Add job here" (Building File), and "+ Add new job for this building"
 * (Schedule's booking drawer) — see the reviewed plan for why this is one
 * implementation, not several. Existing-building selection only: no new
 * building/client creation, no schedule (the existing ScheduleEditor
 * covers that immediately afterward, from the Job Inspector this returns
 * into via onCreated — except from Schedule, which continues straight into
 * booking a visit instead).
 */
export default function JobCreator({ buildingId, defaultFrequencyType, onCreated, onCancel }: JobCreatorProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => blankForm(buildingId, defaultFrequencyType));
  const [buildingQuery, setBuildingQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Set only when the job was created but its schedule write failed — the job exists and must not be lost. */
  const [scheduleFailure, setScheduleFailure] = useState<{ jobId: string; message: string } | null>(null);

  const { data: buildingRows = [] } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const { data: technicians = [] } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });
  const activeTechnicians = technicians.filter((t) => t.isActive);

  const presetBuilding = buildingId ? buildingRows.find((b) => b.id === buildingId) : undefined;
  const selectedBuilding = buildingRows.find((b) => b.id === form.buildingId);

  const buildingMatches = useMemo(() => {
    if (buildingId) return [];
    const q = buildingQuery.trim().toLowerCase();
    if (!q) return [];
    return buildingRows
      .filter((b) => `${b.buildingName} ${b.address} ${b.postcode} ${b.clientName}`.toLowerCase().includes(q))
      .slice(0, 20);
  }, [buildingRows, buildingQuery, buildingId]);

  // The schedule the First due date means under the chosen pattern, or null for "no schedule" — a blank date, a
  // non-recurring frequency, or a week-based one. Null is always the form's original behaviour.
  const scheduleInput = buildFirstDueSchedule({
    frequencyType: form.frequencyType || null,
    firstDueISO: form.firstDueDate,
    pattern: form.firstDuePattern,
    rollForwardOnWeekend: form.rollForwardOnWeekend,
  });

  const createMutation = useMutation({
    // Two writes, deliberately sequential and deliberately not atomic: `jobs` and `schedules` are separate rows
    // and the job is the one that must exist. If the schedule write fails the job is still real, so the failure
    // is reported with a way into the job rather than swallowed or rolled back behind the manager's back.
    mutationFn: async (input: JobCreateInput) => {
      const jobId = await createJob(input);
      if (scheduleInput == null) return { jobId, scheduleError: null };
      try {
        await upsertSchedule(jobId, scheduleInput);
        return { jobId, scheduleError: null };
      } catch (err) {
        return { jobId, scheduleError: err instanceof Error ? err.message : 'Failed to save the schedule.' };
      }
    },
    onSuccess: ({ jobId, scheduleError }) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      if (scheduleError != null) {
        setScheduleFailure({ jobId, message: scheduleError });
        return;
      }
      onCreated(jobId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create job.'),
  });

  const input = toInput(form);
  const patternOptions = firstDuePatternOptions(form.firstDueDate);
  const monthBased = isMonthBasedFrequency(form.frequencyType || null);
  const weekBased = isWeekBasedFrequency(form.frequencyType || null);
  // Said before pressing Create, not after: a recurring job with no schedule never becomes due by itself.
  const recurringWithoutSchedule = (monthBased && scheduleInput == null) || weekBased;

  const parsedPricePerVisit =
    form.pricingType === 'fixed' && form.pricePerVisit !== '' && Number.isFinite(Number(form.pricePerVisit))
      ? Number(form.pricePerVisit)
      : null;
  const pricingPreview = computeDerivedPricing(form.pricingType, form.frequencyType || null, parsedPricePerVisit);

  return (
    <aside className="hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white lg:flex">
      <div className="border-b border-divider p-4">
        <div className="flex items-center gap-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          New job
          <button onClick={onCancel} className="ml-auto cursor-pointer font-body text-sm text-neutral-500 hover:text-ink">
            ✕
          </button>
        </div>
        <h2 className="mt-1.5 font-heading text-xl leading-tight font-semibold">Create a job</h2>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Building
          {presetBuilding ? (
            <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[12.5px] text-ink">
              {presetBuilding.buildingName} · {presetBuilding.clientName}
            </div>
          ) : selectedBuilding ? (
            <div className="flex items-center gap-2 border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink">
              <span className="flex-1 truncate">
                {selectedBuilding.buildingName} · {selectedBuilding.clientName}
              </span>
              <button
                type="button"
                onClick={() => setForm({ ...form, buildingId: '' })}
                className="cursor-pointer text-[11px] text-teal-700 hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                value={buildingQuery}
                onChange={(e) => setBuildingQuery(e.target.value)}
                placeholder="Search buildings, clients, postcodes…"
                autoComplete="off"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              {buildingMatches.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-t-0 border-neutral-300">
                  {buildingMatches.map((b) => (
                    <div
                      key={b.id}
                      onMouseDown={(e) => {
                        // mousedown, not click: fires before any focus/blur
                        // side effect the browser or a parent might trigger
                        // between press and release, so the selection can
                        // never be lost to a race with that. preventDefault
                        // stops the browser from shifting focus away from
                        // this element first.
                        e.preventDefault();
                        setForm({ ...form, buildingId: b.id });
                        setBuildingQuery('');
                      }}
                      className="cursor-pointer border-b border-divider px-2 py-1.5 text-[12px] last:border-b-0 hover:bg-neutral-100"
                    >
                      <div className="font-semibold">{b.buildingName}</div>
                      <div className="text-neutral-500">
                        {b.clientName} · {b.postcode}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Job summary
          <input
            value={form.jobSummary}
            onChange={(e) => setForm({ ...form, jobSummary: e.target.value })}
            placeholder="e.g. Window cleaning"
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Notes (optional)
          <textarea
            value={form.jobNotes}
            onChange={(e) => setForm({ ...form, jobNotes: e.target.value })}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Division
          <select
            value={form.division}
            onChange={(e) => setForm({ ...form, division: e.target.value as Division })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          >
            {DIVISIONS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Frequency (for pricing)
          <select
            value={form.frequencyType}
            onChange={(e) => setForm({ ...form, frequencyType: e.target.value as FrequencyType | '' })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          >
            <option value="">Not set</option>
            {FREQUENCY_TYPES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_TYPE_LABEL[f]}
              </option>
            ))}
          </select>
          <span className="text-neutral-500">
            Used for the monthly and yearly totals. When the work actually falls is set below.
          </span>
        </label>

        {/* The recurrence shortcut. A date alone cannot say WHICH of the Master Reference §3.3 patterns is meant -
            18 Nov 2026 is the 18th, the 3rd Wednesday and "some time in November" at once, and those diverge as
            soon as the cycle advances - so the pattern is always chosen, never inferred. See firstDueSchedule.ts. */}
        {monthBased && (
          <div className="flex flex-col gap-1.5 border border-neutral-300 p-2" data-testid="recurrence-section">
            <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
              When is it due?
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
              First due date (optional)
              <input
                type="date"
                value={form.firstDueDate}
                onChange={(e) => setForm({ ...form, firstDueDate: e.target.value })}
                aria-label="First due date"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>

            {patternOptions && (
              <fieldset className="flex flex-col gap-0.5" data-testid="recurrence-pattern">
                <legend className="mb-0.5 text-[11px] text-neutral-600">How does it repeat?</legend>
                {patternOptions.map((o) => (
                  <label key={o.pattern} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink">
                    <input
                      type="radio"
                      name="firstDuePattern"
                      value={o.pattern}
                      checked={form.firstDuePattern === o.pattern}
                      onChange={() => setForm({ ...form, firstDuePattern: o.pattern })}
                    />
                    {o.label}
                  </label>
                ))}
                {form.firstDuePattern === 'fixed_date' && (
                  <label className="mt-0.5 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-neutral-600">
                    <input
                      type="checkbox"
                      checked={form.rollForwardOnWeekend}
                      onChange={(e) => setForm({ ...form, rollForwardOnWeekend: e.target.checked })}
                    />
                    Move to the next working day if it lands on a weekend
                  </label>
                )}
              </fieldset>
            )}

            {scheduleInput && (
              <div className="border-l-2 border-teal bg-teal-100 px-2 py-1 text-[11.5px] text-ink" data-testid="recurrence-preview">
                {describeSchedule(scheduleFromInput('', scheduleInput))}
              </div>
            )}
          </div>
        )}

        {/* Weekly/fortnightly/6 weekly have no whole-month step, so the Monthly Plan cannot place them (anchored or not).
            Saying so is better than writing a schedule that would read "can't tell" - see
            docs/monthly-plan-weekly-occurrences.md. */}
        {weekBased && (
          <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg" data-testid="week-based-note">
            {FREQUENCY_TYPE_LABEL[form.frequencyType as FrequencyType]} work can’t be placed on the Monthly Plan yet — it
            repeats on a cycle of weeks, not calendar months. Create the job, then book its visits from the Schedule.
          </div>
        )}

        {recurringWithoutSchedule && !weekBased && (
          <div className="border border-due bg-due/10 p-2 text-[11.5px] text-due-fg" data-testid="no-schedule-warning">
            No recurrence will be set, so this job will never become due on its own and won’t appear on the Monthly
            Plan. Add a first due date above, or set a schedule on the job afterwards.
          </div>
        )}

        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
            Pricing
            <select
              value={form.pricingType}
              onChange={(e) => {
                const pricingType = e.target.value as 'fixed' | 'variable';
                setForm({ ...form, pricingType, pricePerVisit: pricingType === 'variable' ? '' : form.pricePerVisit });
              }}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            >
              <option value="fixed">Fixed</option>
              <option value="variable">Variable</option>
            </select>
          </label>
          {form.pricingType === 'fixed' && (
            <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
              Price per visit
              <input
                type="number"
                step="0.01"
                min={0}
                value={form.pricePerVisit}
                onChange={(e) => setForm({ ...form, pricePerVisit: e.target.value })}
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
            </label>
          )}
        </div>

        <div className="text-[11px] text-neutral-500">
          {pricingPreview.yearlyValue != null
            ? `≈ £${pricingPreview.monthlyValue!.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/month · £${pricingPreview.yearlyValue.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/year`
            : form.pricingType === 'variable'
              ? 'Variable pricing — no fixed monthly/yearly total.'
              : 'Set a frequency to calculate monthly/yearly totals.'}
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Technician (optional)
          <select
            value={form.defaultTechnicianId}
            onChange={(e) => setForm({ ...form, defaultTechnicianId: e.target.value })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          >
            <option value="">Unassigned</option>
            {activeTechnicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

        {/* The job was created and the schedule was not. Navigation is held back (rather than calling onCreated
            silently) so the half-done state is stated plainly and the manager lands where they can finish it —
            the same reasoning as BuildingCreator's optional-contact failure. */}
        {scheduleFailure ? (
          <div className="flex flex-col gap-1.5 border border-missed bg-missed/10 p-2" data-testid="schedule-failure">
            <div className="text-[11.5px] text-missed-fg">
              The job was created, but its schedule could not be saved: {scheduleFailure.message} The job has no
              recurrence yet, so it won’t appear on the Monthly Plan until one is set.
            </div>
            <button
              onClick={() => onCreated(scheduleFailure.jobId)}
              className="cursor-pointer self-start bg-teal px-3 py-1.5 text-xs font-semibold text-white"
            >
              Open the job to set its schedule
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <button
              onClick={() => input && createMutation.mutate(input)}
              disabled={!input || createMutation.isPending}
              className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createMutation.isPending ? 'Creating…' : 'Create job'}
            </button>
            <button onClick={onCancel} className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600">
              Cancel
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
