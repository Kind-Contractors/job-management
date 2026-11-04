-- One more job frequency (for pricing): Four-monthly - every four calendar months, 3 visits a year.
--
-- NOT APPLIED to production when written. Apply to DEV first, and only after review. Must be applied BEFORE the frontend
-- that offers this option goes live: until then, saving a job with this value is refused by the database.
-- Additive only: one new value on the existing public.job_frequency_type enum (jobs.frequency_type). No existing value, row,
-- constraint, policy, trigger or function changes, and nothing in the database reads these values (pricing and the
-- first-due schedule shortcut live in the app). Placed beside bi-monthly for readability only; nothing sorts by this enum.
-- Existing jobs are NOT reclassified (legacy "Four-Monthly" text in frequency_raw is left exactly as it is).
-- PostgreSQL 12+ allows ADD VALUE inside a transaction, provided the new value is not used in that same transaction (it is not).

alter type public.job_frequency_type add value if not exists 'four_monthly' after 'bimonthly';
