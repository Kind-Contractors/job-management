-- Two more job frequencies (for pricing): Bi-monthly (every two calendar months) and 6 weekly (every six weeks).
--
-- NOT APPLIED to any database when written. Apply to DEV first, and only after review. Must be applied BEFORE the frontend
-- that offers these options goes live: until then, saving a job with either value is refused by the database.
-- Additive only: two new values on the existing public.job_frequency_type enum (jobs.frequency_type). No existing value, row,
-- constraint, policy, trigger or function changes, and nothing in the database reads these values (pricing and the
-- first-due schedule shortcut live in the app). The order places each beside its neighbours for readability only; nothing
-- sorts by this enum.
-- PostgreSQL 12+ allows ADD VALUE inside a transaction, provided the new value is not used in that same transaction (it is not).

alter type public.job_frequency_type add value if not exists 'six_weekly' after 'fortnightly';
alter type public.job_frequency_type add value if not exists 'bimonthly' after 'monthly';
