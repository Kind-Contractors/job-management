import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BuildingRow, Contact } from '../../domain/types';
import { contactInitials } from '../../lib/contactDisplay';
import { isUsableRecipient, linkStatusLabel, localLinkStatus, VERIFY_STATE_TEXT } from '../../lib/xeroLinkStatus';
import { verifyContactLink, type XeroLinkVerification } from '../../repository/xeroLinksRepository';
import BuildingAddContactForm from './BuildingAddContactForm';
import ReportDefaultPanel from './ReportDefaultPanel';
import EditContactForm from '../contacts/EditContactForm';
import FindXeroContactPanel from '../jobs/FindXeroContactPanel';
import LinkXeroContactDialog from '../jobs/LinkXeroContactDialog';
import BuildingDefaultRecipientPanel from '../jobs/BuildingDefaultRecipientPanel';
import { refreshAfterXeroLink } from '../jobs/UnlinkedRecipientsList';

interface ContactsAndDefaultsTabProps {
  building: BuildingRow;
  contacts: Contact[];
  contactsLoading: boolean;
  contactsError: boolean;
  /** How many buildings this client has: its contacts and main contact are shared by all of them. */
  buildingCount: number;
}

/**
 * The Building File's Contacts & Defaults tab: the one place contacts and recipient defaults are managed.
 *   - Contacts belong to the CLIENT (shared by all its buildings): add, edit (name, email, phone, main contact, accounts-only),
 *     link to / change the link to an existing Xero contact (the shared dialog, or the search-first panel), verify a link.
 *   - Job reports: the client's main contact (contacts.is_primary), client-wide.
 *   - Invoices: this building's default recipient (buildings.default_invoice_*), set and checked by the server.
 * Every write is an existing repository call or xero-link-contact action with its own checks. Nothing here creates or changes
 * a contact in Xero, and nothing creates, sends or emails an invoice or a report.
 */
export default function ContactsAndDefaultsTab({ building, contacts, contactsLoading, contactsError, buildingCount }: ContactsAndDefaultsTabProps) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  // "+ Add contact" pressed from the Find-in-Xero panel: the contact then added is offered there to confirm its link.
  const [addingForXero, setAddingForXero] = useState(false);
  const [xeroNewContactId, setXeroNewContactId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [linkingContact, setLinkingContact] = useState<Contact | null>(null);
  const [verifications, setVerifications] = useState<Record<string, XeroLinkVerification>>({});
  const [verifyError, setVerifyError] = useState<{ id: string; message: string } | null>(null);

  const clientName = building.clientName || 'this client';
  const refreshKeys = [['contacts', building.clientId], ['jobRows'], ['historicalJobRows'], ['buildingHistory', building.id]];

  const verifyMutation = useMutation({
    mutationFn: (id: string) => verifyContactLink(id),
    onMutate: () => setVerifyError(null),
    onSuccess: (v, id) => setVerifications((all) => ({ ...all, [id]: v })),
    onError: (err, id) => setVerifyError({ id, message: err instanceof Error ? err.message : 'The link could not be verified.' }),
  });

  const q = filter.trim().toLowerCase();
  const shown = q ? contacts.filter((c) => `${c.name} ${c.email ?? ''} ${c.phoneNumber ?? ''}`.toLowerCase().includes(q)) : contacts;
  const linkedCount = contacts.filter(isUsableRecipient).length;
  const justAdded = justAddedId ? contacts.find((c) => c.id === justAddedId) : undefined;
  // The contact being edited, as the (refreshed) list holds it; the dialog closes if it is no longer there.
  const editingContact = editingId ? (contacts.find((c) => c.id === editingId) ?? null) : null;

  if (contactsLoading) return <div className="border border-neutral-300 bg-white px-4 py-3 text-[12.5px] text-neutral-500">Loading contacts…</div>;
  if (contactsError) return <div className="border border-missed bg-missed/10 px-4 py-3 text-[12.5px] text-missed-fg">Couldn&apos;t load contacts.</div>;

  return (
    <div data-testid="contacts-and-defaults" className="flex flex-col gap-4">
      <div className="border border-teal-700/40 bg-teal-100 px-4 py-2.5 text-[12.5px] text-teal-700">
        Contacts belong to <span className="font-semibold">{clientName}</span> and are shared by{' '}
        {buildingCount > 1 ? `all ${buildingCount} of its buildings` : 'its buildings'}: a change here applies to every one of them.
        The invoice default below is for this building only.
      </div>

      <div className="grid grid-cols-[minmax(0,3fr)_minmax(360px,2fr)] items-start gap-5">
        <div className="flex min-w-0 flex-col gap-4">
          <div data-testid="manage-contacts" className="border border-neutral-300 bg-white">
            <div className="flex items-center gap-2 border-b border-neutral-300 px-4 py-2.5">
              <span className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">
                Manage contacts · {contacts.length}
              </span>
              <span className="text-[11px] text-neutral-500">{linkedCount} linked to Xero</span>
              <button
                type="button"
                onClick={() => {
                  setAddingContact(true);
                  setAddingForXero(false);
                  setNotice(null);
                  setJustAddedId(null);
                }}
                className="ml-auto cursor-pointer text-[11.5px] font-semibold text-teal-700 hover:underline"
              >
                + Add contact
              </button>
            </div>
            {contacts.length > 3 && (
              <div className="border-b border-divider px-4 py-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by name, email or phone"
                  aria-label="Filter contacts"
                  className="w-full border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                />
              </div>
            )}
            {notice && (
              <div role="status" className="border-b border-divider bg-teal-100 px-4 py-2 text-[12px] text-teal-700">
                {notice}
                {justAdded &&
                  (isUsableRecipient(justAdded) ? (
                    <> {linkStatusLabel(justAdded)}.</>
                  ) : (
                    <>
                      {' '}
                      To invoice it, link it to its existing Xero contact.{' '}
                      <button type="button" onClick={() => setLinkingContact(justAdded)} className="cursor-pointer font-semibold underline">
                        Link to Xero contact now
                      </button>
                    </>
                  ))}
              </div>
            )}
            {contacts.length === 0 ? (
              <div className="px-4 py-3 text-[12.5px] text-neutral-500">No contacts recorded for {clientName} yet.</div>
            ) : shown.length === 0 ? (
              <div className="px-4 py-3 text-[12.5px] text-neutral-500">
                No contact matches &ldquo;{filter.trim()}&rdquo;.{' '}
                <button type="button" onClick={() => setFilter('')} className="cursor-pointer text-teal-700 underline">
                  Clear the filter
                </button>
              </div>
            ) : (
              shown.map((c) => {
                const status = localLinkStatus(c);
                const verification = verifications[c.id];
                return (
                  <div key={c.id} data-testid="contact-row" className="border-b border-divider px-4 py-2.5 text-[12.5px] last:border-b-0">
                    <div className="flex items-start gap-3">
                      <span aria-hidden="true" className="grid h-8 w-8 flex-none place-items-center bg-neutral-200 font-heading text-[11px] font-semibold text-teal-700">
                        {contactInitials(c.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          <span className="font-semibold text-ink">{c.name}</span>
                          {c.isPrimary && (
                            <span className="border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
                              Main contact
                            </span>
                          )}
                          {c.isAccountsContact && (
                            <span className="border border-teal-700 bg-teal-100 px-1 py-0.5 font-heading text-[9.5px] font-semibold tracking-[0.06em] text-teal-700 uppercase">
                              Accounts only
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11.5px] text-neutral-600">
                          {[c.email ?? 'No email', c.phoneNumber].filter(Boolean).join(' · ')}
                        </div>
                        <div className={`text-[11px] ${status === 'linked' ? 'text-teal-700' : 'text-due-fg'}`}>
                          {status === 'linked' ? '✓ ' : ''}
                          {linkStatusLabel(c)}
                        </div>
                        {verification && (
                          <div className={`text-[11px] ${VERIFY_STATE_TEXT[verification.state].ok ? 'text-teal-700' : 'text-missed-fg'}`}>
                            {VERIFY_STATE_TEXT[verification.state].text}
                            {verification.nameChanged ? ' The name in Xero has changed since it was linked.' : ''}
                          </div>
                        )}
                        {verifyError?.id === c.id && <div className="text-[11px] text-missed-fg">{verifyError.message}</div>}
                      </div>
                      <div className="flex flex-none flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            // A new edit clears the last save's notice, so a confirmation always belongs to the latest save.
                            // A new edit clears the last save's notice, so a confirmation always belongs to the latest save.
                            setNotice(null);
                            setJustAddedId(null);
                            setEditingId(c.id);
                          }}
                          aria-label={`Edit ${c.name}`}
                          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setLinkingContact(c)}
                          aria-label={`${status === 'not_linked' ? 'Link' : 'Change the Xero link of'} ${c.name}`}
                          className={[
                            'cursor-pointer px-2 py-1 text-[11px] font-semibold',
                            status === 'linked'
                              ? 'border border-neutral-300 text-teal-700 hover:bg-neutral-100'
                              : 'border border-dashed border-neutral-500 text-neutral-700 hover:bg-neutral-100',
                          ].join(' ')}
                        >
                          {status === 'linked' ? 'Change Xero link' : 'Link to Xero'}
                        </button>
                        {status !== 'not_linked' && (
                          <button
                            type="button"
                            onClick={() => verifyMutation.mutate(c.id)}
                            disabled={verifyMutation.isPending}
                            aria-label={`Verify the Xero link of ${c.name}`}
                            className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                          >
                            {verifyMutation.isPending && verifyMutation.variables === c.id ? 'Checking…' : 'Verify'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <FindXeroContactPanel
            contacts={contacts}
            buildingDefaultContactId={building.defaultRecipient?.contactId ?? null}
            newContactId={xeroNewContactId}
            disabled={false}
            onAddContact={() => {
              setAddingForXero(true);
              setAddingContact(true);
              setNotice(null);
              setJustAddedId(null);
            }}
            onLinked={({ localContactName, xeroContactName, alsoLinkedToOtherContacts }) => {
              refreshAfterXeroLink(queryClient);
              setXeroNewContactId(null);
              setJustAddedId(null);
              setNotice(
                `${localContactName} is now linked to the Xero contact ${xeroContactName}. Nothing was created in Xero.` +
                  (alsoLinkedToOtherContacts > 0
                    ? ` Note: this Xero contact is also linked to ${alsoLinkedToOtherContacts} other ${alsoLinkedToOtherContacts === 1 ? 'contact' : 'contacts'} in the app.`
                    : ''),
              );
            }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Default recipients</div>
          <ReportDefaultPanel clientId={building.clientId} clientName={building.clientName} contacts={contacts} buildingCount={buildingCount} refreshKeys={refreshKeys} />
          <BuildingDefaultRecipientPanel building={building} contacts={contacts} />
        </div>
      </div>

      {editingContact && (
        <EditContactDialog name={editingContact.name} onClose={() => setEditingId(null)}>
          <EditContactForm
            clientId={building.clientId}
            clientName={building.clientName}
            contact={editingContact}
            contacts={contacts}
            buildingCount={buildingCount}
            refreshKeys={refreshKeys}
            onCancel={() => setEditingId(null)}
            onSaved={(saved, changed) => {
              setEditingId(null);
              setJustAddedId(null);
              setNotice(changed ? `${saved.name} was updated.` : `No changes to ${saved.name}.`);
            }}
          />
        </EditContactDialog>
      )}

      {addingContact && (
        <BuildingAddContactForm
          clientId={building.clientId}
          clientName={building.clientName}
          buildingId={building.id}
          contacts={contacts}
          onClose={() => {
            setAddingContact(false);
            setAddingForXero(false);
          }}
          onCreated={(contact) => {
            setAddingContact(false);
            if (addingForXero) {
              // Back to "Find a contact in Xero": the new contact is offered there; the link is still confirmed by the manager.
              setAddingForXero(false);
              setXeroNewContactId(contact.id);
              setNotice(`Contact added: ${contact.name}. Confirm its Xero link in "Find a contact in Xero" below. Nothing is linked yet.`);
              return;
            }
            setNotice(`Contact added: ${contact.name}.`);
            setJustAddedId(contact.id);
          }}
        />
      )}

      {linkingContact && (
        // The shared link dialog (email lookup first, then a name search pre-filled with this building's name). Nothing is linked
        // until the manager chooses and confirms; replacing a link needs its own confirmation, and a contact that is any building's
        // default recipient cannot be re-linked (the server refuses until that default is cleared).
        <LinkXeroContactDialog
          localContactId={linkingContact.id}
          localContactName={linkingContact.name}
          localContactEmail={linkingContact.email}
          suggestedTerm={building.name || building.buildingName || linkingContact.name}
          currentXeroContactId={linkingContact.xeroContactId}
          onClose={() => setLinkingContact(null)}
          onLinked={() => {
            setVerifications((all) => {
              const next = { ...all };
              delete next[linkingContact.id];
              return next;
            });
            refreshAfterXeroLink(queryClient);
          }}
        />
      )}
    </div>
  );
}

/**
 * The dialog around the edit-contact form, like "+ Add contact": closed only deliberately (Cancel, the close button or Escape) -
 * never by a click on the backdrop, so nothing typed is lost - and a click on the backdrop keeps focus in the dialog.
 */
function EditContactDialog({ name, onClose, children }: { name: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        data-testid="edit-contact-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit contact: ${name}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        className="relative max-h-[90vh] w-[min(480px,95vw)] overflow-y-auto border border-neutral-300 bg-white p-4 outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 cursor-pointer px-2 py-1 text-[15px] leading-none text-neutral-600 hover:bg-neutral-100"
        >
          ×
        </button>
        <div className="mb-2.5 border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Edit contact</div>
          <h2 className="font-heading text-lg leading-tight font-semibold">{name}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}
