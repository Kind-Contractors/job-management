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
import { ACCOUNTS_ONLY_BADGE, MAIN_CONTACT_BADGE } from '../contacts/contactBadgeStyles';

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

  if (contactsLoading) return <div className="rounded-md border border-neutral-300 bg-white px-[18px] py-4 text-[13px] text-neutral-500">Loading contacts…</div>;
  if (contactsError) return <div className="rounded-md border border-missed bg-missed/10 px-[18px] py-4 text-[13px] text-missed-fg">Couldn&apos;t load contacts.</div>;

  const ghostButton = 'h-[34px] cursor-pointer rounded-md border border-neutral-300 bg-white px-3 text-[13px] hover:bg-neutral-100';

  return (
    <div data-testid="contacts-and-defaults" className="flex flex-wrap items-start gap-5 text-[14px] text-ink">
      {/* ===== Client contacts (shared by every building of the client) ===== */}
      <section data-testid="manage-contacts" className="min-w-0 flex-[999_1_480px] rounded-md border border-neutral-300 bg-white">
        <div className="flex items-start gap-3 border-b border-neutral-200 px-[18px] py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-bold">
              Client contacts <span className="font-medium text-neutral-600">· {contacts.length}</span>
            </h2>
            <p className="mt-1 flex items-center gap-1.5 text-[13px] text-neutral-600">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
                <path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
              </svg>
              <span>
                Contacts belong to <span className="font-semibold">{clientName}</span> and are shared by{' '}
                {buildingCount > 1 ? `all ${buildingCount} of its buildings` : 'its buildings'}. Edits apply everywhere.
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAddingContact(true);
              setNotice(null);
            }}
            className="flex h-[38px] flex-none cursor-pointer items-center gap-1.5 rounded-md bg-teal px-3.5 text-[13px] font-semibold text-white hover:bg-teal-700"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add contact
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-neutral-200 px-[18px] py-3">
          {contacts.length > 3 && (
            <label className="flex h-[38px] min-w-0 flex-[1_1_240px] items-center gap-2 rounded-md border border-neutral-300 px-2.5 focus-within:border-teal">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="flex-none text-neutral-500">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name, email or phone"
                aria-label="Filter contacts"
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none"
              />
            </label>
          )}
          <div className="flex flex-wrap gap-3.5 text-[12px] text-neutral-600">
            <span className="inline-flex items-center gap-1.5">
              <span className="rounded-[3px] bg-teal px-[5px] py-px text-[10px] font-bold tracking-[0.06em] text-white">MAIN</span>
              Gets job reports
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="rounded-[3px] border border-teal px-[5px] text-[10px] font-bold tracking-[0.06em] text-teal">ACCOUNTS</span>
              Invoices only, never job reports
            </span>
          </div>
        </div>

        {notice && (
          <div role="status" className="border-b border-neutral-200 bg-teal-100 px-[18px] py-2.5 text-[13px] text-teal-700">
            {notice}
          </div>
        )}
        {contacts.length === 0 ? (
          <div className="px-[18px] py-4 text-[13px] text-neutral-500">No contacts recorded for {clientName} yet.</div>
        ) : shown.length === 0 ? (
          <div className="px-[18px] py-4 text-[13px] text-neutral-500">
            No contact matches &ldquo;{filter.trim()}&rdquo;.{' '}
            <button type="button" onClick={() => setFilter('')} className="cursor-pointer text-teal-700 underline">
              Clear the filter
            </button>
          </div>
        ) : (
          <ScrollableList count={shown.length} label="Contacts">
            {shown.map((c) => (
              <div key={c.id} data-testid="contact-row" className="flex items-center gap-3.5 border-b border-neutral-200/70 px-[18px] py-3.5 last:border-b-0 hover:bg-neutral-100/60">
                <span
                  aria-hidden="true"
                  className={`grid h-[38px] w-[38px] flex-none place-items-center rounded-full text-[12px] font-bold ${c.isPrimary ? 'bg-teal text-white' : 'bg-neutral-200 text-teal'}`}
                >
                  {contactInitials(c.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{c.name}</span>
                    {c.isPrimary && <span className={MAIN_CONTACT_BADGE}>Main contact</span>}
                    {c.isAccountsContact && <span className={ACCOUNTS_ONLY_BADGE}>Accounts only</span>}
                  </div>
                  <div className="truncate text-[13px] text-neutral-600">{[c.email ?? 'No email', c.phoneNumber].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="flex flex-none flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      // A new edit clears the last save's notice, so a confirmation always belongs to the latest save.
                      setNotice(null);
                      setEditingId(c.id);
                    }}
                    aria-label={`Edit ${c.name}`}
                    className={`${ghostButton} text-ink`}
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
                    className={`${ghostButton} text-missed-fg`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </ScrollableList>
        )}
      </section>

      {/* ===== Who receives what ===== */}
      <aside className="flex max-w-[460px] min-w-0 flex-[1_1_360px] flex-col gap-4">
        <h2 className="font-heading text-[11px] font-semibold tracking-[0.14em] text-neutral-600 uppercase">Who receives what</h2>
        <ReportDefaultPanel clientId={building.clientId} clientName={building.clientName} contacts={contacts} buildingCount={buildingCount} refreshKeys={refreshKeys} />
        {/* The building's default recipient in Xero (the name on its invoices). An older contact-based default is shown there too,
            and can be replaced or cleared there. */}
        <BuildingInvoiceRecipientPanel building={building} contacts={contacts} />
      </aside>

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
