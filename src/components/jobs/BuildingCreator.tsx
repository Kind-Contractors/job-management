import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listClients } from '../../repository/clientsRepository';
import { createBuilding, createClientAndBuilding, type BuildingCreateFields } from '../../repository/buildingsRepository';
import { listContactsForClient, createContactForClient } from '../../repository/contactsRepository';

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

  // Optional contact, added for either an existing client (a genuinely new
  // contact for them) or a brand-new client (their first). Never shown as
  // pre-filled/selected-by-default for an existing client — see
  // existingContacts below, displayed read-only so a manager sees what
  // already exists before choosing to add another.
  const [addContact, setAddContact] = useState(false);
  const [contactForm, setContactForm] = useState({ name: '', email: '', phoneNumber: '' });
  const [contactError, setContactError] = useState<string | null>(null);
  // Set only if the building/client themselves were created successfully
  // but the optional contact failed to save — BuildingsPage's onCreated
  // navigates away immediately, which would unmount this panel before the
  // manager ever saw a contact-save error, so navigation is held back
  // until this resolves.
  const [createdBuildingId, setCreatedBuildingId] = useState<string | null>(null);

  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: listClients });
  const { data: existingContacts = [] } = useQuery({
    queryKey: ['contacts', form.clientId],
    queryFn: () => listContactsForClient(form.clientId),
    enabled: form.clientMode === 'existing' && form.clientId.length > 0,
  });

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

  /**
   * Root cause of the "selection doesn't stick" bug: the toggle buttons used
   * to call setForm(blankForm()) unconditionally on every click — including
   * a click on the *already-active* tab, which silently wiped a just-picked
   * clientId (and every typed building field) back to blank with no warning.
   * Fixed by making same-mode clicks a genuine no-op, and only clearing the
   * client-identifying fields (not address/name/postcode/etc.) when the mode
   * actually changes.
   */
  const setClientMode = (nextMode: ClientMode) => {
    if (nextMode === form.clientMode) return;
    setForm({ ...form, clientMode: nextMode, clientId: '', companyName: '' });
    setClientQuery('');
  };

  const createMutation = useMutation({
    mutationFn: async (): Promise<{ buildingId: string; clientId: string }> => {
      if (form.clientMode === 'existing') {
        const buildingId = await createBuilding(form.clientId, buildingFields);
        return { buildingId, clientId: form.clientId };
      }
      return createClientAndBuilding({ companyName: form.companyName.trim(), ...buildingFields });
    },
    onSuccess: async ({ buildingId, clientId }) => {
      queryClient.invalidateQueries({ queryKey: ['buildingRows'] });
      if (form.clientMode === 'new') queryClient.invalidateQueries({ queryKey: ['clients'] });

      if (!addContact || !contactForm.name.trim()) {
        onCreated(buildingId);
        return;
      }

      // A second, separate insert rather than folding this into the
      // create_client_and_building RPC — the contact is optional and
      // non-critical (unlike the client+building pair, which genuinely
      // needs atomicity to avoid an orphaned client), so this small
      // non-atomic window is an acceptable trade-off against a schema
      // change. The building/client are already created and safe either way.
      try {
        await createContactForClient(clientId, {
          name: contactForm.name.trim(),
          email: contactForm.email.trim() || null,
          phoneNumber: contactForm.phoneNumber.trim() || null,
          // Only the client's very first contact defaults to primary — an
          // existing client with contacts already keeps whichever one (if
          // any) is primary unchanged; a manager can promote this new one
          // later via All Live Jobs' contact editor if they want to.
          isPrimary: existingContacts.length === 0,
        });
        queryClient.invalidateQueries({ queryKey: ['jobRows'] });
        onCreated(buildingId);
      } catch (err) {
        setCreatedBuildingId(buildingId);
        setContactError(err instanceof Error ? err.message : 'Failed to save the contact.');
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to create building.'),
  });

  // The building/client already exist at this point — only the optional
  // contact failed. Navigation is held back (rather than calling onCreated
  // immediately, which would unmount this panel via BuildingsPage's
  // immediate navigate()) so this is never silently lost.
  if (createdBuildingId) {
    return (
      <aside className="hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white lg:flex">
        <div className="border-b border-divider p-4">
          <h2 className="font-heading text-xl leading-tight font-semibold">Building created</h2>
        </div>
        <div className="flex flex-col gap-2 p-4">
          <div className="border border-teal-700/40 bg-teal-100 p-2.5 text-[12.5px] text-teal-700">
            The building was created successfully.
          </div>
          <div className="border border-missed bg-missed/10 p-2.5 text-[12.5px] text-missed-fg">
            The contact could not be saved: {contactError}
          </div>
          <button
            onClick={() => onCreated(createdBuildingId)}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white"
          >
            Continue to building
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="hidden w-[344px] flex-none flex-col overflow-y-auto border-l border-divider bg-white lg:flex">
      <div className="border-b border-divider p-4">
        <div className="flex items-center gap-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          New building
          <button onClick={onCancel} className="ml-auto cursor-pointer font-body text-sm text-neutral-500 hover:text-ink">
            ✕
          </button>
        </div>
        <h2 className="mt-1.5 font-heading text-xl leading-tight font-semibold">Create a building</h2>
      </div>

      <div className="flex flex-col gap-2 p-4">
        <div className="flex border border-neutral-300">
          <button
            type="button"
            onClick={() => setClientMode('existing')}
            className={`flex-1 cursor-pointer py-1.5 text-xs ${
              form.clientMode === 'existing' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            Existing client
          </button>
          <button
            type="button"
            onClick={() => setClientMode('new')}
            className={`flex-1 cursor-pointer border-l border-neutral-300 py-1.5 text-xs ${
              form.clientMode === 'new' ? 'bg-teal font-semibold text-white' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            New client
          </button>
        </div>

        {form.clientMode === 'existing' ? (
          <div className="flex flex-col gap-1 text-[11px] text-neutral-600">
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
                  aria-label="Search for an existing client"
                  value={clientQuery}
                  onChange={(e) => setClientQuery(e.target.value)}
                  placeholder="Search clients…"
                  autoComplete="off"
                  className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
                {clientMatches.length > 0 && (
                  <div className="max-h-48 overflow-y-auto border border-t-0 border-neutral-300">
                    {clientMatches.map((c) => (
                      <div
                        key={c.id}
                        onMouseDown={(e) => {
                          // See JobCreator.tsx's identical building-search
                          // list for why this is onMouseDown, not onClick.
                          e.preventDefault();
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
          </div>
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

        <div className="flex flex-col gap-1.5 border-t border-divider pt-2">
          <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Contact (optional)</div>

          {form.clientMode === 'existing' && form.clientId && existingContacts.length > 0 && (
            <div className="flex flex-col gap-1">
              {existingContacts.map((c) => (
                <div key={c.id} className="border border-neutral-300 bg-neutral-100 px-2 py-1 text-[11.5px]">
                  <span className="font-semibold text-ink">{c.name}</span>
                  <span className="text-neutral-600">
                    {' '}
                    · {[c.email, c.phoneNumber].filter(Boolean).join(' · ') || 'No email or phone on file'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!addContact ? (
            <button
              type="button"
              onClick={() => setAddContact(true)}
              className="cursor-pointer self-start border border-neutral-300 px-2.5 py-1 text-[11.5px] text-neutral-700 hover:bg-neutral-100"
            >
              + Add a contact
            </button>
          ) : (
            <div className="flex flex-col gap-1.5">
              <input
                value={contactForm.name}
                onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                placeholder="Name"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              <input
                type="email"
                value={contactForm.email}
                onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                placeholder="Email"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              <input
                value={contactForm.phoneNumber}
                onChange={(e) => setContactForm({ ...contactForm, phoneNumber: e.target.value })}
                placeholder="Phone"
                className="border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
              />
              <button
                type="button"
                onClick={() => {
                  setAddContact(false);
                  setContactForm({ name: '', email: '', phoneNumber: '' });
                }}
                className="cursor-pointer self-start text-[11px] text-neutral-500 hover:underline"
              >
                Remove
              </button>
            </div>
          )}
        </div>

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
