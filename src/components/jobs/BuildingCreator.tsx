import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listClients } from '../../repository/clientsRepository';
import { createBuilding, createClientAndBuilding, type BuildingCreateFields } from '../../repository/buildingsRepository';

type ClientMode = 'existing' | 'new';

interface FormState {
  clientMode: ClientMode;
  clientId: string;
  companyName: string;
  address: string;
  name: string;
  postcode: string;
  invoiceDetails: string;
  siteInstructions: string;
}

function blankForm(): FormState {
  return {
    clientMode: 'existing',
    clientId: '',
    companyName: '',
    address: '',
    name: '',
    postcode: '',
    invoiceDetails: '',
    siteInstructions: '',
  };
}

interface BuildingCreatorProps {
  onCreated: (buildingId: string) => void;
  onCancel: () => void;
}

/**
 * Creates a building for an existing client (plain insert), or a brand-new
 * client + its first building together (the atomic create_client_and_building
 * RPC — see buildingsRepository.ts for why this one case needs atomicity and
 * the existing-client case doesn't). Never shows a client field on a job —
 * JobCreator.tsx stays untouched; this is the only place a manager ever
 * chooses/creates a client.
 */
export default function BuildingCreator({ onCreated, onCancel }: BuildingCreatorProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(blankForm);
  const [clientQuery, setClientQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: listClients });

  const selectedClient = clients.find((c) => c.id === form.clientId);
  const clientMatches = useMemo(() => {
    if (form.clientId) return [];
    const q = clientQuery.trim().toLowerCase();
    if (!q) return [];
    return clients.filter((c) => c.companyName.toLowerCase().includes(q)).slice(0, 20);
  }, [clients, clientQuery, form.clientId]);

  const buildingFields: BuildingCreateFields = {
    address: form.address.trim(),
    name: form.name.trim() || null,
    postcode: form.postcode.trim() || null,
    invoiceDetails: form.invoiceDetails.trim() || null,
    siteInstructions: form.siteInstructions.trim() || null,
  };

  const isValid =
    buildingFields.address.length > 0 &&
    (form.clientMode === 'existing' ? form.clientId.length > 0 : form.companyName.trim().length > 0);

  const createMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      if (form.clientMode === 'existing') {
        return createBuilding(form.clientId, buildingFields);
      }
      const { buildingId } = await createClientAndBuilding({ companyName: form.companyName.trim(), ...buildingFields });
      return buildingId;
    },
    onSuccess: (buildingId) => {
      queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
      if (form.clientMode === 'new') queryClient.invalidateQueries({ queryKey: ['clients'] });
      onCreated(buildingId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create building.'),
  });

  return (
    <aside className="hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white lg:flex">
      <div className="border-b border-divider p-4">
        <div className="flex items-center gap-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          New building
          <button onClick={onCancel} className="ml-auto font-body text-sm text-neutral-500 hover:text-ink">
            ✕
          </button>
        </div>
        <h2 className="mt-1.5 font-heading text-xl leading-tight font-semibold">Create a building</h2>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <div className="flex border border-neutral-300">
          <button
            type="button"
            onClick={() => setForm({ ...blankForm(), clientMode: 'existing' })}
            className={`flex-1 cursor-pointer py-1.5 text-xs ${
              form.clientMode === 'existing' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            Existing client
          </button>
          <button
            type="button"
            onClick={() => setForm({ ...blankForm(), clientMode: 'new' })}
            className={`flex-1 cursor-pointer border-l border-neutral-300 py-1.5 text-xs ${
              form.clientMode === 'new' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            New client
          </button>
        </div>

        {form.clientMode === 'existing' ? (
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            Client
            {selectedClient ? (
              <div className="flex items-center gap-2 border border-neutral-300 px-2 py-1.5 text-[12.5px] text-ink">
                <span className="flex-1 truncate">{selectedClient.companyName}</span>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, clientId: '' })}
                  className="cursor-pointer text-[11px] text-teal-700 hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  value={clientQuery}
                  onChange={(e) => setClientQuery(e.target.value)}
                  placeholder="Search clients…"
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
                {clientMatches.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border border-t-0 border-neutral-300">
                    {clientMatches.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => {
                          setForm({ ...form, clientId: c.id });
                          setClientQuery('');
                        }}
                        className="cursor-pointer border-b border-divider px-2 py-1.5 text-[12px] last:border-b-0 hover:bg-neutral-100"
                      >
                        {c.companyName}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
            New client's company name
            <input
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              placeholder="e.g. Acme Property Group"
              className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Address
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Building name (optional)
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Falls back to the address if left blank"
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Postcode (optional)
          <input
            value={form.postcode}
            onChange={(e) => setForm({ ...form, postcode: e.target.value })}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Invoice details (optional)
          <textarea
            value={form.invoiceDetails}
            onChange={(e) => setForm({ ...form, invoiceDetails: e.target.value })}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
          Site instructions (optional)
          <textarea
            value={form.siteInstructions}
            onChange={(e) => setForm({ ...form, siteInstructions: e.target.value })}
            rows={2}
            className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
          />
        </label>

        {error && <div className="text-[11.5px] text-missed-fg">{error}</div>}

        <div className="flex gap-1.5">
          <button
            onClick={() => isValid && createMutation.mutate()}
            disabled={!isValid || createMutation.isPending}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {createMutation.isPending ? 'Creating…' : 'Create building'}
          </button>
          <button onClick={onCancel} className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600">
            Cancel
          </button>
        </div>
      </div>
    </aside>
  );
}
