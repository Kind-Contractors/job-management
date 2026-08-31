import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Division, FrequencyType } from '../../domain/types';
import { createJob, type JobCreateInput } from '../../repository/jobsRepository';
import { listBuildingRows } from '../../repository/buildingsRepository';
import { listTeams } from '../../repository/teamsRepository';
import { FREQUENCY_TYPE_LABEL } from '../../repository/mapJobRow';

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
  defaultTeamId: string;
}

function blankForm(presetBuildingId?: string): FormState {
  return {
    buildingId: presetBuildingId ?? '',
    jobSummary: '',
    jobNotes: '',
    division: 'General',
    pricingType: 'fixed',
    pricePerVisit: '',
    frequencyType: '',
    defaultTeamId: '',
  };
}

/** Builds a validated JobCreateInput, or null while the form is incomplete/invalid — mirrors JobEditor.tsx's toInput() exactly (same fixed-pricing/positive-price rule), plus a required building. */
function toInput(form: FormState): JobCreateInput | null {
  if (!form.buildingId) return null;

  const jobSummary = form.jobSummary.trim();
  if (!jobSummary) return null;

  let pricePerVisit: number | null = null;
  if (form.pricingType === 'fixed') {
    const parsed = Number(form.pricePerVisit);
    if (!form.pricePerVisit || !Number.isFinite(parsed) || parsed <= 0) return null;
    pricePerVisit = parsed;
  }

  return {
    buildingId: form.buildingId,
    division: form.division,
    jobSummary,
    jobNotes: form.jobNotes.trim() || null,
    pricingType: form.pricingType,
    pricePerVisit,
    frequencyType: form.frequencyType || null,
    defaultTeamId: form.defaultTeamId || null,
  };
}

interface JobCreatorProps {
  /** Preset and locked when opened from Building File — hides the building picker entirely. Editable via search when opened from All Live Jobs. */
  buildingId?: string;
  onCreated: (jobId: string) => void;
  onCancel: () => void;
}

/**
 * The one job-creation form, shared by "+ New job" (All Live Jobs) and
 * "+ Add job here" (Building File) — see the reviewed plan for why this is
 * one implementation, not two. Existing-building selection only: no new
 * building/client creation, no schedule (the existing ScheduleEditor
 * covers that immediately afterward, from the Job Inspector this returns
 * into via onCreated).
 */
export default function JobCreator({ buildingId, onCreated, onCancel }: JobCreatorProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => blankForm(buildingId));
  const [buildingQuery, setBuildingQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: buildingRows = [] } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const { data: teams = [] } = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const activeTeams = teams.filter((t) => t.isActive);

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

  const createMutation = useMutation({
    mutationFn: (input: JobCreateInput) => createJob(input),
    onSuccess: (jobId) => {
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onCreated(jobId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create job.'),
  });

  const input = toInput(form);

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
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              {buildingMatches.length > 0 && (
                <div className="max-h-48 overflow-y-auto border border-t-0 border-neutral-300">
                  {buildingMatches.map((b) => (
                    <div
                      key={b.id}
                      onClick={() => {
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
          Frequency (optional)
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

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Team (optional)
          <select
            value={form.defaultTeamId}
            onChange={(e) => setForm({ ...form, defaultTeamId: e.target.value })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          >
            <option value="">Unassigned</option>
            {activeTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

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
      </div>
    </aside>
  );
}
