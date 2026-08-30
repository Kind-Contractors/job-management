import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Division, FrequencyType, JobRow } from '../../domain/types';
import { updateJob, type JobEditInput } from '../../repository/jobsRepository';
import { FREQUENCY_TYPE_LABEL } from '../../repository/mapJobRow';

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

/** Builds a validated JobEditInput, or null while the form is incomplete/invalid. Never transforms a value to fit — a 'fixed' job with no valid price simply can't be saved. */
function toInput(form: FormState): JobEditInput | null {
  const jobSummary = form.jobSummary.trim();
  if (!jobSummary) return null;

  let pricePerVisit: number | null = null;
  if (form.pricingType === 'fixed') {
    const parsed = Number(form.pricePerVisit);
    if (!form.pricePerVisit || !Number.isFinite(parsed) || parsed <= 0) return null;
    pricePerVisit = parsed;
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

  const saveMutation = useMutation({
    mutationFn: (input: JobEditInput) => updateJob(job.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save job.'),
  });

  const input = toInput(form);

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
