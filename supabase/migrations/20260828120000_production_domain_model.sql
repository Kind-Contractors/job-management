-- Production Domain Model — Job Management System
--
-- Implements the 11-table schema approved in
-- docs/production-domain-model-proposal.md (rounds 1-3, Q1-Q8 incorporated).
--
-- THIS FILE HAS NOT BEEN APPLIED. It is written for review only, per the
-- explicit instruction not to modify Supabase until approved.
--
-- Scope:
--   - Extends public.clients (no column changes), public.buildings
--     (adds name, postcode; migrates key_access_notes out then drops it),
--     and public.jobs (adds pricing/frequency/lifecycle/recontact columns).
--   - Creates 8 new tables: contacts, teams, building_access, schedules,
--     visits, reports, photos, activity_events.
--   - Enables RLS on all 8 new tables with ZERO policies (locked down by
--     default — see proposal §7/Q8). No production data is exposed by
--     this migration; these tables are unreachable via the anon/
--     authenticated Supabase client keys until policies are designed.
--   - The only data movement is copying the existing (currently empty)
--     public.buildings.key_access_notes values into
--     public.building_access.access_notes verbatim, per the explicit
--     migration sequence requested (create → copy → drop). No business
--     data is imported or backfilled beyond that copy.
--   - Does not touch staging_gen_details / staging_spec_details /
--     staging_contractx / staging_gen_schedule, or anything in the
--     Data Manager repository.
--
-- Idempotency: every CREATE is guarded (IF NOT EXISTS, or a DO block
-- checking pg_type/pg_constraint where Postgres has no IF NOT EXISTS
-- form) so this file can be safely re-run.

-- =============================================================================
-- 1. Enum types (explicit, distinct names per proposal §9.1 — event_type on
--    activity_events is deliberately plain text, not an enum; see §9.1).
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_pricing_type') THEN
    CREATE TYPE public.job_pricing_type AS ENUM ('fixed', 'variable');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_frequency_type') THEN
    CREATE TYPE public.job_frequency_type AS ENUM (
      'weekly', 'fortnightly', 'monthly', 'quarterly', 'biannual', 'annual',
      'ask_adhoc', 'one_off'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_lifecycle_status') THEN
    -- 'on_hold' added per proposal §9.2 (evidenced by legacy status_notes
    -- content such as "on hold until July" / "funding issues").
    CREATE TYPE public.job_lifecycle_status AS ENUM (
      'active', 'on_hold', 'completed', 'lost', 'cancelled'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_type') THEN
    CREATE TYPE public.schedule_type AS ENUM (
      'fixed_weekday', 'fixed_date', 'due_month', 'ad_hoc'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_interval_unit') THEN
    CREATE TYPE public.schedule_interval_unit AS ENUM ('week', 'month', 'quarter', 'year');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_weekday') THEN
    CREATE TYPE public.schedule_weekday AS ENUM ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_week_ordinal') THEN
    CREATE TYPE public.schedule_week_ordinal AS ENUM ('1st', '2nd', '3rd', '4th', 'last');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'visit_status') THEN
    -- Deliberately no 'in_progress'/'onsite' value — see proposal §9.2:
    -- nothing in production can reliably populate a live check-in state yet.
    CREATE TYPE public.visit_status AS ENUM ('due', 'booked', 'completed', 'missed', 'cancelled');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_review_status') THEN
    CREATE TYPE public.report_review_status AS ENUM (
      'awaiting_review', 'approved', 'returned_for_correction'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'photo_phase') THEN
    CREATE TYPE public.photo_phase AS ENUM ('before', 'during', 'after');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'photo_upload_status') THEN
    CREATE TYPE public.photo_upload_status AS ENUM ('pending', 'uploaded', 'failed');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_entity_type') THEN
    CREATE TYPE public.activity_entity_type AS ENUM ('building', 'job', 'visit', 'report');
  END IF;
END $$;

-- =============================================================================
-- 2. teams — created before jobs/visits since both reference it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.teams IS
  'The assignable unit of work — one shape for group teams and solo specialist '
  'resources (Q7). See docs/production-domain-model-proposal.md section 2.7.';

-- Case-insensitive uniqueness so "Team 1" cannot be accidentally duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_key ON public.teams ((lower(name)));

-- =============================================================================
-- 3. contacts
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients (id) ON DELETE RESTRICT,
  name text NOT NULL,
  role text,
  email text,
  phone_number text,
  is_primary boolean NOT NULL DEFAULT false,
  is_accounts_contact boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.contacts IS
  'Named people at a client — a client can have multiple contacts. '
  'See docs/production-domain-model-proposal.md section 2.2.';

CREATE INDEX IF NOT EXISTS contacts_client_id_idx ON public.contacts (client_id);

-- At most one primary contact per client.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_one_primary_per_client_idx
  ON public.contacts (client_id) WHERE is_primary;

-- =============================================================================
-- 4. buildings — extend existing table (add columns only in this section;
--    key_access_notes is migrated out and dropped in section 5, after
--    building_access exists and has been populated).
-- =============================================================================

ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS postcode text;

-- No new index needed here: public.buildings already has idx_buildings_client_id
-- on (client_id) — confirmed against the live schema during pre-flight review.

-- =============================================================================
-- 5. building_access — new table, 1:1 with buildings. Internal-only access
--    information, structurally separated from anything client-facing
--    (requirement #11). Migration sequence per Q3: create -> copy -> drop.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.building_access (
  building_id uuid PRIMARY KEY REFERENCES public.buildings (id) ON DELETE RESTRICT,
  key_safe_code text,
  keyholder_name text,
  keyholder_phone text,
  parking_notes text,
  access_notes text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.building_access IS
  'Internal-only site access information (key safe, keyholder, parking). '
  'Never selected by anything client-facing. '
  'See docs/production-domain-model-proposal.md section 2.4.';

-- Steps 2 and 3 of the Q3 sequence: copy key_access_notes verbatim into
-- access_notes, then drop the old column — guarded by checking the column
-- still exists first, so re-running this migration after it has already
-- succeeded once (when key_access_notes no longer exists) skips cleanly
-- instead of failing on a reference to a dropped column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'buildings' AND column_name = 'key_access_notes'
  ) THEN
    INSERT INTO public.building_access (building_id, access_notes)
    SELECT id, key_access_notes
    FROM public.buildings
    WHERE key_access_notes IS NOT NULL
    ON CONFLICT (building_id) DO NOTHING;

    ALTER TABLE public.buildings DROP COLUMN key_access_notes;
  END IF;
END $$;

-- =============================================================================
-- 6. jobs — extend existing table. building_id/job_type/job_summary/etc.
--    are unchanged; this only adds the new pricing/frequency/lifecycle/
--    recontact columns. jobs currently has 0 rows, so frequency_type can be
--    added NOT NULL with no default (see accompanying report note).
-- =============================================================================

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS pricing_type public.job_pricing_type NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS price_per_visit numeric(10, 2),
  ADD COLUMN IF NOT EXISTS frequency_type public.job_frequency_type NOT NULL,
  ADD COLUMN IF NOT EXISTS lifecycle_status public.job_lifecycle_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS lost_reason text,
  ADD COLUMN IF NOT EXISTS default_team_id uuid REFERENCES public.teams (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS recontact_due_at date,
  ADD COLUMN IF NOT EXISTS recontact_notes text,
  ADD COLUMN IF NOT EXISTS recontact_interval_months smallint;

-- Fixed-pricing jobs must have a price; variable-pricing jobs must not
-- (there's no single number — see visits.price_charged instead).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_pricing_consistency_check') THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_pricing_consistency_check
      CHECK (
        (pricing_type = 'fixed' AND price_per_visit IS NOT NULL)
        OR (pricing_type = 'variable' AND price_per_visit IS NULL)
      );
  END IF;
END $$;

-- No new index needed for building_id: public.jobs already has
-- idx_jobs_building_id — confirmed against the live schema during pre-flight
-- review. default_team_id is a genuinely new column, so it needs one.
CREATE INDEX IF NOT EXISTS jobs_default_team_id_idx ON public.jobs (default_team_id);

-- =============================================================================
-- 7. schedules — new table, 1:1 with jobs. Structured recurrence, replacing
--    the mock schedulePattern string. Typed columns, not a JSONB rule.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.schedules (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id) ON DELETE RESTRICT,
  schedule_type public.schedule_type NOT NULL,
  interval_unit public.schedule_interval_unit,
  interval_count smallint,
  weekday public.schedule_weekday,
  week_ordinal public.schedule_week_ordinal,
  day_of_month smallint,
  roll_forward_on_weekend boolean NOT NULL DEFAULT true,
  due_month smallint,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.schedules IS
  'Structured scheduling per job: fixed weekday, fixed date, due month/date '
  'unknown, or ad-hoc (requirement #8). '
  'See docs/production-domain-model-proposal.md section 2.6.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedules_day_of_month_range_check') THEN
    ALTER TABLE public.schedules
      ADD CONSTRAINT schedules_day_of_month_range_check
      CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedules_due_month_range_check') THEN
    ALTER TABLE public.schedules
      ADD CONSTRAINT schedules_due_month_range_check
      CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12);
  END IF;
END $$;

-- Only the columns that apply to a given schedule_type may be populated —
-- see proposal §9.1.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedules_type_consistency_check') THEN
    ALTER TABLE public.schedules
      ADD CONSTRAINT schedules_type_consistency_check
      CHECK (
        (
          schedule_type = 'ad_hoc'
          AND interval_unit IS NULL AND interval_count IS NULL
          AND weekday IS NULL AND week_ordinal IS NULL
          AND day_of_month IS NULL AND due_month IS NULL
        ) OR (
          schedule_type = 'fixed_weekday'
          AND interval_unit IS NOT NULL AND interval_count IS NOT NULL
          AND weekday IS NOT NULL AND week_ordinal IS NOT NULL
          AND day_of_month IS NULL AND due_month IS NULL
        ) OR (
          schedule_type = 'fixed_date'
          AND interval_unit IS NOT NULL AND interval_count IS NOT NULL
          AND day_of_month IS NOT NULL
          AND weekday IS NULL AND week_ordinal IS NULL AND due_month IS NULL
        ) OR (
          schedule_type = 'due_month'
          AND interval_unit IS NOT NULL AND interval_count IS NOT NULL
          AND due_month IS NOT NULL
          AND weekday IS NULL AND week_ordinal IS NULL AND day_of_month IS NULL
        )
      );
  END IF;
END $$;

-- =============================================================================
-- 8. visits — new table. The actual due/booked/completed/missed occurrence.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs (id) ON DELETE RESTRICT,
  team_id uuid REFERENCES public.teams (id) ON DELETE RESTRICT,
  scheduled_date date,
  status public.visit_status NOT NULL DEFAULT 'due',
  price_charged numeric(10, 2),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.visits IS
  'A dated occurrence of work at a job. price_charged is nullable at '
  'booking but required before status can reach completed, for every job '
  'regardless of pricing_type — this is what preserves price history '
  '(see proposal section 3.1) without a separate history table.'
  ' See docs/production-domain-model-proposal.md section 2.8.';

CREATE INDEX IF NOT EXISTS visits_team_id_idx ON public.visits (team_id);

-- Plain lookup index only, not a uniqueness constraint: no confirmed
-- requirement establishes that a job can never have two visits on the same
-- date (e.g. an emergency callout alongside a routine visit isn't ruled
-- out), so this must not silently block that. Revisit as UNIQUE only if
-- that business rule is explicitly confirmed later. This composite index
-- also covers plain job_id-only lookups via its leftmost column, so no
-- separate single-column job_id index is needed alongside it.
CREATE INDEX IF NOT EXISTS visits_job_scheduled_date_idx
  ON public.visits (job_id, scheduled_date);

-- price_charged nullable when created/booked; required (with completed_at)
-- once a visit reaches 'completed' — the refinement requested this round.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_completion_requires_charge_check') THEN
    ALTER TABLE public.visits
      ADD CONSTRAINT visits_completion_requires_charge_check
      CHECK (
        status != 'completed'
        OR (price_charged IS NOT NULL AND completed_at IS NOT NULL)
      );
  END IF;
END $$;

-- =============================================================================
-- 9. reports — new table, one per visit (Q4). Review/approval gate +
--    independent client/accounts sending state (requirements #12, #13).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL UNIQUE REFERENCES public.visits (id) ON DELETE RESTRICT,
  submitted_by text NOT NULL,
  submitted_at timestamptz NOT NULL,
  on_site_start timestamptz,
  on_site_end timestamptz,
  work_carried_out text,
  technician_notes text,
  issues text,
  review_status public.report_review_status NOT NULL DEFAULT 'awaiting_review',
  reviewed_by text,
  reviewed_at timestamptz,
  return_reason text,
  include_photos boolean NOT NULL DEFAULT true,
  include_notes boolean NOT NULL DEFAULT true,
  include_issues boolean NOT NULL DEFAULT true,
  include_price boolean NOT NULL DEFAULT false,
  sent_to_client_at timestamptz,
  sent_to_client_by text,
  sent_to_accounts_at timestamptz,
  sent_to_accounts_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reports IS
  'Evidence from a visit: the manager review/approval gate, and the '
  'independent client/accounts sending state. One row per visit (Q4) — '
  'a returned report is corrected and resubmitted in place. '
  'See docs/production-domain-model-proposal.md section 2.9.';

-- Requirement #12, enforced at the database level, not just in application
-- logic: neither send timestamp may be set unless the report is approved.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_sending_requires_approval_check') THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_sending_requires_approval_check
      CHECK (
        (sent_to_client_at IS NULL AND sent_to_accounts_at IS NULL)
        OR review_status = 'approved'
      );
  END IF;
END $$;

-- _at/_by pairing consistency.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_reviewed_pair_check') THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_reviewed_pair_check
      CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_sent_client_pair_check') THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_sent_client_pair_check
      CHECK ((sent_to_client_by IS NULL) = (sent_to_client_at IS NULL));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_sent_accounts_pair_check') THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_sent_accounts_pair_check
      CHECK ((sent_to_accounts_by IS NULL) = (sent_to_accounts_at IS NULL));
  END IF;
END $$;

-- A returned report must say why — the technician has to act on it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_return_reason_check') THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_return_reason_check
      CHECK (review_status != 'returned_for_correction' OR return_reason IS NOT NULL);
  END IF;
END $$;

-- =============================================================================
-- 10. photos — new table. Report evidence, phased and upload-tracked.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.reports (id) ON DELETE RESTRICT,
  phase public.photo_phase NOT NULL,
  storage_path text NOT NULL,
  upload_status public.photo_upload_status NOT NULL DEFAULT 'pending',
  taken_at timestamptz,
  uploaded_at timestamptz
);

COMMENT ON TABLE public.photos IS
  'Report evidence, phased before/during/after, with per-photo upload '
  'status. See docs/production-domain-model-proposal.md section 2.10.';

CREATE INDEX IF NOT EXISTS photos_report_id_idx ON public.photos (report_id);

-- =============================================================================
-- 11. activity_events — new table. One narrative history feed for
--     building/job/visit/report (requirement history; proposal section 3.1).
--     entity_id is deliberately not a real foreign key (polymorphic across
--     four possible target tables) — see proposal section 3.D.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type public.activity_entity_type NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  detail text,
  occurred_at timestamptz NOT NULL,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.activity_events IS
  'Narrative "everything that happened here" history feed for buildings, '
  'jobs, visits and reports. Not used for price history (see visits.price_charged) '
  'or for anything requiring structured, queryable reconstruction — narrative '
  'only. event_type is plain text, not an enum, since new event kinds should '
  'not require a schema migration. '
  'See docs/production-domain-model-proposal.md section 2.11 and 3.1.';

CREATE INDEX IF NOT EXISTS activity_events_entity_idx
  ON public.activity_events (entity_type, entity_id);

-- =============================================================================
-- 12. Row Level Security — enabled on every new table, with ZERO policies.
--     Per Q8/proposal section 7: this locks these tables down completely for
--     the anon/authenticated Supabase client roles (only the service_role
--     key bypasses RLS) until real policies are designed. This migration
--     does NOT touch RLS on the existing clients/buildings/jobs tables —
--     that is a separately known, already-flagged issue, not addressed here.
-- =============================================================================

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.building_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 13. updated_at maintenance — applied only to new tables that have an
--     updated_at column. Existing clients/buildings/jobs are left exactly
--     as they already are; whatever (if anything) already maintains their
--     updated_at column is untouched by this migration.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.jms_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jms_set_updated_at ON public.teams;
CREATE TRIGGER jms_set_updated_at BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.jms_set_updated_at();

DROP TRIGGER IF EXISTS jms_set_updated_at ON public.contacts;
CREATE TRIGGER jms_set_updated_at BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.jms_set_updated_at();

DROP TRIGGER IF EXISTS jms_set_updated_at ON public.building_access;
CREATE TRIGGER jms_set_updated_at BEFORE UPDATE ON public.building_access
  FOR EACH ROW EXECUTE FUNCTION public.jms_set_updated_at();

DROP TRIGGER IF EXISTS jms_set_updated_at ON public.schedules;
CREATE TRIGGER jms_set_updated_at BEFORE UPDATE ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION public.jms_set_updated_at();

DROP TRIGGER IF EXISTS jms_set_updated_at ON public.visits;
CREATE TRIGGER jms_set_updated_at BEFORE UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.jms_set_updated_at();

DROP TRIGGER IF EXISTS jms_set_updated_at ON public.reports;
CREATE TRIGGER jms_set_updated_at BEFORE UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.jms_set_updated_at();
