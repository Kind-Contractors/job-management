import type { Contact } from '../../domain/types';
import NewContactForm from '../contacts/NewContactForm';

interface BuildingAddContactFormProps {
  /** The building's client: the new contact belongs to it (contacts are client-level, shared by all its buildings). */
  clientId: string;
  clientName: string;
  buildingId: string;
  /** The client's current contacts (for the duplicate-email check and the primary-contact note). */
  contacts: Pick<Contact, 'id' | 'name' | 'email' | 'isPrimary'>[];
  onClose: () => void;
  /** The saved contact (unlinked: the Building File then offers to link it to its Xero contact). */
  onCreated: (contact: Contact) => void;
}

/**
 * "Add contact" on the Building File: the shared new-contact form (the same fields, checks and save as All Live Jobs) for the
 * building's client. Nothing is linked to or created in Xero - linking stays the separate, explicit "Link to Xero contact" step.
 * Shown as a dialog over the page. Closing discards what was typed, so it closes only deliberately (Cancel, the close button or
 * Escape) - never by a click outside it.
 */
export default function BuildingAddContactForm({ clientId, clientName, buildingId, contacts, onClose, onCreated }: BuildingAddContactFormProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      // A click on the backdrop does nothing - and keeps focus in the dialog, so Escape still closes it afterwards.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        data-testid="add-contact-form"
        role="dialog"
        aria-modal="true"
        aria-label={`Add a contact for ${clientName || 'this client'}`}
        tabIndex={-1}
        // Focus starts on the dialog itself (the shared form is not changed for this), so Escape works straight away.
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        className="relative max-h-[90vh] w-[min(480px,95vw)] overflow-y-auto border border-neutral-300 bg-white p-4 outline-none"
      >
      <button onClick={onClose} aria-label="Close" className="absolute top-2 right-2 cursor-pointer px-2 py-1 text-[15px] leading-none text-neutral-600 hover:bg-neutral-100">
        ×
      </button>
      <NewContactForm
        clientId={clientId}
        title={`New contact for ${clientName || 'this client'}`}
        contacts={contacts}
        // Contacts are read here (['contacts', clientId]), on every job of the client (['jobRows'], ['historicalJobRows']: recipient
        // and report pickers) and on this building's History (a "Contact added" entry).
        refreshKeys={[['contacts', clientId], ['jobRows'], ['historicalJobRows'], ['buildingHistory', buildingId]]}
        onCancel={onClose}
        onCreated={onCreated}
      />
      </div>
    </div>
  );
}
