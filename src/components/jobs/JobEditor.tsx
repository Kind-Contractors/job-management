import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Division, FrequencyType, JobRow } from '../../domain/types';
import { assignJobTechnician, updateJob, type JobEditInput } from '../../repository/jobsRepository';
import { listTechnicians } from '../../repository/techniciansRepository';
import { FREQUENCY_TYPE_LABEL, computeDerivedPricing } from '../../repository/mapJobRow';

const DIVISIONS: Division[] = ['General', 'Specialist'];
const FREQUENCY_TYPES = Object.keys(FREQUENCY_TYPE_LABEL) as FrequencyType[];

interface FormState {
  jobSummary: string;
  jobNotes: string;
  division: Division;
  pricingType: 'fixed' | 'variable';
  pricePerVisit: string;
  frequencyType: FrequencyType | '';
}

function formFromJob(job: JobRow): FormState {
  return {
    jobSummary: job.jobSummary === '—' ? '' : job.jobSummary,
    jobNotes: job.jobNotes ?? '',
    division: job.division,
    pricingType: job.pricePerVisit == null ? 'variable' : 'fixed',
    pricePerVisit: job.pricePerVisit != null ? String(job.pricePerVisit) : '',
    frequencyType: job.frequencyType ?? '',
  };
}

/**
 * The one place "is this job summary valid" is decided — returns the
 * trimmed value, or null if it's empty/whitespace-only. Reused by JobsGrid's
 * inline cell edit so the spreadsheet workflow can never accept a value the
 * full editor would reject, or vice versa.
 */
export function parseJobSummary(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * The one place "is this a valid fixed price-per-visit" is decided —
 * returns the parsed number, or null if it's missing/non-finite/not
 * positive. Reused by JobsGrid's inline cell edit for the exact same reason
 * as parseJobSummary above.
 */
export function parsePricePerVisit(raw: string): number | null {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Builds a validated JobEditInput, or null while the form is incomplete/invalid. Never transforms a value to fit — a 'fixed' job with no valid price simply can't be saved. */
function toInput(form: FormState): JobEditInput | null {
  const jobSummary = parseJobSummary(form.jobSummary);
  if (!jobSummary) return null;

  let pricePerVisit: number | null = null;
  if (form.pricingType === 'fixed') {
    pricePerVisit = parsePricePerVisit(form.pricePerVisit);
    if (pricePerVisit == null) return null;
  }

  return {
    jobSummary,
    jobNotes: form.jobNotes.trim() || null,
    division: form.division,
    pricingType: form.pricingType,
    pricePerVisit,
    frequencyType: form.frequencyType || null,
  };
}

interface JobEditorProps {
  job: JobRow;
  onDone: () => void;
}

export default function JobEditor({ job, onDone }: JobEditorProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(formFromJob(job));
  const [error, setError] = useState<string | null>(null);
  const [technicianError, setTechnicianError] = useState<string | null>(null);

  const { data: technicians = [] } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });
  const activeTechnicians = technicians.filter((t) => t.isActive);

  const saveMutation = useMutation({
    mutationFn: (input: JobEditInput) => updateJob(job.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save job.'),
  });

  /**
   * Saves immediately on change, same as every other place this field is
   * edited (JobsGrid's inline column, JobInspectorDrawer's own "Assigned"
   * row) — reuses assignJobTechnician() unchanged, never folded into
   * updateJob()/JobEditInput (a separate, already-established field/save
   * path, not part of this form's own batched Save button).
   */
  const assignTechnicianMutation = useMutation({
    mutationFn: (technicianId: string | null) => assignJobTechnician(job.id, technicianId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      setTechnicianError(null);
    },
    onError: (err) => setTechnicianError(err instanceof Error ? err.message : 'Failed to assign technician.'),
  });

  const input = toInput(form);

  const parsedPricePerVisit =
    form.pricingType === 'fixed' && form.pricePerVisit !== '' && Number.isFinite(Number(form.pricePerVisit))
      ? Number(form.pricePerVisit)
      : null;
  const pricingPreview = computeDerivedPricing(form.pricingType, form.frequencyType || null, parsedPricePerVisit);

  return (
    <div className="m-3.5 border border-neutral-300 p-3">
      <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Edit job</div>

      <div className="mt-2 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Job summary
          <input
            value={form.jobSummary}
            onChange={(e) => setForm({ ...form, jobSummary: e.target.value })}
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
          Frequency
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
        </label>

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
          Default technician (optional)
          <select
            value={job.defaultTechnicianId ?? ''}
            onChange={(e) => assignTechnicianMutation.mutate(e.target.value || null)}
            disabled={assignTechnicianMutation.isPending}
            className="cursor-pointer border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            <option value="">Unassigned</option>
            {activeTechnicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {assignTechnicianMutation.isPending && <span className="text-[11px] text-neutral-500">Saving…</span>}
          {technicianError && <span className="text-[11px] text-missed-fg">{technicianError}</span>}
        </label>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

        <div className="flex gap-1.5">
          <button
            onClick={() => input && saveMutation.mutate(input)}
            disabled={!input || saveMutation.isPending}
            className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onDone} className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
