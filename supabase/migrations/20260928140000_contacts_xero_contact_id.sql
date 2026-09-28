-- Lets an individual client contact (not just the client as a whole) be
-- mapped to its own Xero Contact, so a manager can choose which specific
-- person an invoice's Xero Contact — and therefore Xero's own automatic
-- invoice email — resolves to, instead of always using the one
-- client-level Xero Contact.
--
-- Mirrors clients.xero_contact_id exactly (same type, no FK — it's an
-- external Xero identifier, not a local relationship). Nullable, no
-- backfill: existing contacts simply have no Xero Contact yet until the
-- next invoice sent to them resolves/creates one.
alter table public.contacts add column xero_contact_id text;

comment on column public.contacts.xero_contact_id is
  'Set once this contact is matched or created as its own Xero Contact, so '
  'an invoice can be addressed to this specific person rather than only '
  'the client-level Xero Contact (clients.xero_contact_id). Once set, this '
  'is authoritative and is never re-resolved by name search.';
