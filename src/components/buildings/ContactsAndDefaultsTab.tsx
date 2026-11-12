import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BuildingRow, Contact } from '../../domain/types';
import { contactInitials } from '../../lib/contactDisplay';
import BuildingAddContactForm from './BuildingAddContactForm';
import ReportDefaultPanel from './ReportDefaultPanel';
import ScrollableList from '../shared/ScrollableList';
import EditContactForm from '../contacts/EditContactForm';
import DeleteContactDialog from '../contacts/DeleteContactDialog';
import BuildingInvoiceRecipientPanel from './BuildingInvoiceRecipientPanel';

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
 *     delete.
 *   - Job reports: the client's main contact (contacts.is_primary), client-wide.
 *   - Invoices: this building's default recipient in Xero - the Xero contact named on its invoices, chosen for this building only
 *     (BuildingInvoiceRecipientPanel, set and checked by the server). People are not linked to Xero contacts here any more: an
 *     invoice is addressed to a Xero contact chosen by name, never through a person. Links people already have are kept in the
 *     database (an older contact-based default still relies on its person's link until it is replaced), but not shown or changed.
 * Every write is an existing repository call or xero-link-contact action with its own checks. Nothing here creates or changes
 * a contact in Xero, and nothing creates, sends or emails an invoice or a report.
 */
export default function ContactsAndDefaultsTab({ building, contacts, contactsLoading, contactsError, buildingCount }: ContactsAndDefaultsTabProps) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  // The contact whose Delete was pressed: the dialog checks what depends on it before anything can be deleted.
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const clientName = building.clientName || 'this client';
  const refreshKeys = [['contacts', building.clientId], ['jobRows'], ['historicalJobRows'], ['buildingHistory', building.id]];

  const q = filter.trim().toLowerCase();
  const shown = q ? contacts.filter((c) => `${c.name} ${c.email ?? ''} ${c.phoneNumber ?? ''}`.toLowerCase().includes(q)) : contacts;
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
              <button
                type="button"
                onClick={() => {
                  setAddingContact(true);
                  setNotice(null);
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
              <ScrollableList count={shown.length} label="Contacts">
              {shown.map((c) => {
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
                      </div>
                      <div className="flex flex-none flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            // A new edit clears the last save's notice, so a confirmation always belongs to the latest save.
                            setNotice(null);
                            setEditingId(c.id);
                          }}
                          aria-label={`Edit ${c.name}`}
                          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 hover:bg-neutral-100"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setNotice(null);
                            setDeleting({ id: c.id, name: c.name });
                          }}
                          aria-label={`Delete ${c.name}`}
                          className="cursor-pointer border border-neutral-300 px-2 py-1 text-[11px] text-missed-fg hover:bg-neutral-100"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              </ScrollableList>
            )}
          </div>

        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="font-heading text-[10.5px] font-semibold tracking-[0.13em] text-neutral-700 uppercase">Default recipients</div>
          <ReportDefaultPanel clientId={building.clientId} clientName={building.clientName} contacts={contacts} buildingCount={buildingCount} refreshKeys={refreshKeys} />
          {/* The building's default recipient in Xero (the name on its invoices). An older contact-based default is shown there too,
              and can be replaced or cleared there. */}
          <BuildingInvoiceRecipientPanel building={building} contacts={contacts} />
        </div>
      </div>

      {deleting && (
        <DeleteContactDialog
          contactId={deleting.id}
          contactName={deleting.name}
          clientId={building.clientId}
          clientName={building.clientName}
          onClose={() => setDeleting(null)}
          onDeleted={(name) => {
            setDeleting(null);
            if (editingId === deleting.id) setEditingId(null);
            // The contact lists, the job rows (their contacts), the buildings (defaults) and this building's history.
            for (const queryKey of [...refreshKeys, ['buildingRows']]) void queryClient.invalidateQueries({ queryKey });
            setNotice(`${name} was deleted.`);
          }}
        />
      )}

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
          onClose={() => setAddingContact(false)}
          onCreated={(contact) => {
            setAddingContact(false);
            setNotice(`Contact added: ${contact.name}.`);
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
