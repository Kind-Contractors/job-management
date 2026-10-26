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
  onCreated: (name: string) => void;
}

/**
 * "Add contact" on the Building File: the shared new-contact form (the same fields, checks and save as All Live Jobs) for the
 * building's client. Nothing is linked to or created in Xero - linking stays the separate, explicit "Link to Xero contact" step.
 */
export default function BuildingAddContactForm({ clientId, clientName, buildingId, contacts, onClose, onCreated }: BuildingAddContactFormProps) {
  return (
    <div data-testid="add-contact-form" className="border-t border-divider px-4 py-3">
      <NewContactForm
        clientId={clientId}
        title={`New contact for ${clientName || 'this client'}`}
        contacts={contacts}
        // Contacts are read here (['contacts', clientId]), on every job of the client (['jobRows'], ['historicalJobRows']: recipient
        // and report pickers) and on this building's History (a "Contact added" entry).
        refreshKeys={[['contacts', clientId], ['jobRows'], ['historicalJobRows'], ['buildingHistory', buildingId]]}
        onCancel={onClose}
        onCreated={(contact) => onCreated(contact.name)}
      />
    </div>
  );
}
