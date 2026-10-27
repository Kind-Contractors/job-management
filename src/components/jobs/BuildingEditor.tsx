import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BuildingRow } from '../../domain/types';
import { updateBuilding, type BuildingEditFields } from '../../repository/buildingsRepository';

interface FormState {
  name: string;
  address: string;
  postcode: string;
  invoiceDetails: string;
  siteInstructions: string;
}

function formFromBuilding(building: BuildingRow): FormState {
  return {
    // The raw name, not buildingName — prefilling with the fallback display
    // string would silently turn "no name set" into a real stored name the
    // moment this form is saved.
    name: building.name ?? '',
    address: building.address,
    postcode: building.postcode,
    invoiceDetails: building.invoiceDetails,
    siteInstructions: building.siteInstructions,
  };
}

/** Builds a validated BuildingEditFields, or null while the form is incomplete/invalid. Address must stay non-empty — the database requires it. */
function toInput(form: FormState): BuildingEditFields | null {
  const address = form.address.trim();
  if (!address) return null;

  return {
    name: form.name.trim() || null,
    address,
    postcode: form.postcode.trim() || null,
    invoiceDetails: form.invoiceDetails.trim() || null,
    siteInstructions: form.siteInstructions.trim() || null,
  };
}

interface BuildingEditorProps {
  building: BuildingRow;
  onDone: () => void;
}

/** General building details editor, opened from the Building File header — mirrors JobEditor.tsx's shape exactly. Never touches client_id or building_access (see BuildingAccessEditor.tsx for the latter, kept behind its own reveal-gate). */
export default function BuildingEditor({ building, onDone }: BuildingEditorProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => formFromBuilding(building));
  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: (input: BuildingEditFields) => updateBuilding(building.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
      // Name/address/postcode/invoice details are also denormalized onto
      // every JobRow at this building (buildingName/postcode/
      // clientInvoiceAddress in mapJobRow.ts) — without this, All Live
      // Jobs/Schedule/Job Inspector would keep showing the old values until
      // something unrelated happened to refetch jobs.
      queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save building.'),
  });

  const input = toInput(form);

  // Closing discards unsaved changes, so it is done only deliberately (Cancel, the close button or Escape) - never by a click
  // outside the dialog - and not while a save is in flight.
  const close = () => {
    if (!saveMutation.isPending) onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" data-testid="building-editor-dialog"
      // A click on the backdrop does nothing - and keeps focus in the dialog, so Escape still closes it afterwards.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit building: ${building.buildingName}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        className="flex max-h-[90vh] w-[min(640px,95vw)] flex-col border border-neutral-300 bg-white"
      >
      <div className="flex flex-none items-center gap-2 border-b border-divider px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Edit building</div>
          <div className="truncate text-[13px] font-semibold text-ink">{building.buildingName}</div>
        </div>
        <button onClick={close} aria-label="Close" className="flex-none cursor-pointer px-2 py-1 text-[15px] leading-none text-neutral-600 hover:bg-neutral-100">
          ×
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4">
        {/* Side by side — both are short fields; stacked full-width (in a form with no width cap) left a lot of empty space to the right of each one. */}
        <div className="flex gap-2">
          <label className="flex flex-[2] flex-col gap-1 text-[11px] text-neutral-600">
            Building name (optional)
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Falls back to the address if left blank"
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-[11px] text-neutral-600">
            Postcode (optional)
            <input
              value={form.postcode}
              onChange={(e) => setForm({ ...form, postcode: e.target.value })}
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Address
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Invoice details (optional)
          <textarea
            value={form.invoiceDetails}
            onChange={(e) => setForm({ ...form, invoiceDetails: e.target.value })}
            rows={3}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Site instructions (optional)
          <textarea
            value={form.siteInstructions}
            onChange={(e) => setForm({ ...form, siteInstructions: e.target.value })}
            rows={4}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

        <div className="mt-1 flex gap-1.5">
          <button
            onClick={() => input && saveMutation.mutate(input)}
            disabled={!input || saveMutation.isPending}
            className="cursor-pointer bg-teal px-2.5 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={close}
            disabled={saveMutation.isPending}
            className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
