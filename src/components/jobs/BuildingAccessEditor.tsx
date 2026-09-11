import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BuildingAccessInfo } from '../../domain/types';
import { upsertBuildingAccess, type BuildingAccessEditFields } from '../../repository/buildingsRepository';

interface FormState {
  keySafeCode: string;
  keyholderName: string;
  keyholderPhone: string;
  parkingNotes: string;
  accessNotes: string;
}

function formFromAccess(access: BuildingAccessInfo | null): FormState {
  return {
    keySafeCode: access?.keySafeCode ?? '',
    keyholderName: access?.keyholderName ?? '',
    keyholderPhone: access?.keyholderPhone ?? '',
    parkingNotes: access?.parkingNotes ?? '',
    accessNotes: access?.accessNotes ?? '',
  };
}

function toInput(form: FormState): BuildingAccessEditFields {
  return {
    keySafeCode: form.keySafeCode.trim() || null,
    keyholderName: form.keyholderName.trim() || null,
    keyholderPhone: form.keyholderPhone.trim() || null,
    parkingNotes: form.parkingNotes.trim() || null,
    accessNotes: form.accessNotes.trim() || null,
  };
}

interface BuildingAccessEditorProps {
  buildingId: string;
  access: BuildingAccessInfo | null;
  onDone: () => void;
}

/**
 * Edits building_access — deliberately its own component, never merged into
 * BuildingEditor.tsx, so it can only ever be rendered by BuildingFilePage.tsx
 * from inside the already-reveal-gated "Internal only · access" panel
 * (never behind a control that's visible before that panel is revealed).
 * All fields optional; unlike BuildingEditor there is no required field.
 */
export default function BuildingAccessEditor({ buildingId, access, onDone }: BuildingAccessEditorProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => formFromAccess(access));
  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: () => upsertBuildingAccess(buildingId, toInput(form)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
      // access_notes is also denormalized onto every JobRow at this
      // building (buildingInternalAccessNote in mapJobRow.ts) — same
      // staleness reasoning as BuildingEditor.tsx's general-fields save.
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save access details.'),
  });

  return (
    <div className="mt-2 border border-neutral-300 bg-white p-2.5">
      <div className="font-heading text-[10px] font-semibold tracking-[0.12em] text-neutral-600 uppercase">Edit access details</div>
      <div className="mt-1.5 flex flex-col gap-1.5">
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Key safe code
          <input
            value={form.keySafeCode}
            onChange={(e) => setForm({ ...form, keySafeCode: e.target.value })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>
        {/* Side by side — both short fields, so pairing them uses this panel's width better than stacking each full-width. */}
        <div className="flex gap-1.5">
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
            Keyholder name
            <input
              value={form.keyholderName}
              onChange={(e) => setForm({ ...form, keyholderName: e.target.value })}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
            Keyholder phone
            <input
              value={form.keyholderPhone}
              onChange={(e) => setForm({ ...form, keyholderPhone: e.target.value })}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Parking notes
          <textarea
            value={form.parkingNotes}
            onChange={(e) => setForm({ ...form, parkingNotes: e.target.value })}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Access notes
          <textarea
            value={form.accessNotes}
            onChange={(e) => setForm({ ...form, accessNotes: e.target.value })}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        {error && <div className="text-[11px] text-missed-fg">{error}</div>}

        <div className="flex gap-1.5">
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
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
