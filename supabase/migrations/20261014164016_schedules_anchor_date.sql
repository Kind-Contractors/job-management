-- A recurrence can now say WHICH cycle it is on, not just how often it repeats.
--
-- Applied to DEV on 2026-10-14 (recorded as version 20261014164016). NOT applied to production.
--
-- Why
-- ---
-- `schedules` stores how often a job repeats (interval_unit/interval_count) and what day it lands on
-- (weekday + week_ordinal, or day_of_month), but never WHICH month the cycle is phased against. For a
-- literally-monthly job that does not matter - every month is in the cycle. For anything longer it is the
-- whole question: "third Wednesday every quarter" is Jan/Apr/Jul/Oct for one job and Feb/May/Aug/Nov for
-- the next, and nothing stored could tell them apart. So src/lib/scheduleFormat.ts refused to answer at
-- all (`monthsDueInYear`, `suggestDateInMonth` and `suggestNextDate` all return null outside
-- `intervalUnit === 'month' && intervalCount === 1`), and its own comment said not to extend that
-- "without a schema change that adds a real anchor field". This is that field.
--
-- What it is
-- ----------
-- One real date the job was genuinely due on. It supplies the cycle PHASE only - never the day:
--   * fixed_weekday still takes its day from week_ordinal + weekday;
--   * fixed_date still takes its day from day_of_month;
--   * due_month has never stored a day, so there it also supplies the suggested day-of-month when booking.
-- A month is in cycle when the whole months between it and the anchor divide exactly by the interval. The
-- test is a true modulo, so the pattern reads correctly BEFORE the anchor as well as after: the anchor is
-- not a start date, and `jobs.service_ends_on` remains the only end boundary.
--
-- Null means "not recorded". Every derivation then falls back to exactly its pre-anchor behaviour and
-- reports "not determinable" rather than guessing, so every existing row behaves as it did before.
--
-- NOTE: anchor_date is never inferred from visit history. A manager types it, or it stays null. Guessing
-- a cycle from what happened to be booked would invent a schedule the data does not support (see the
-- header comments in src/lib/monthMatrix.ts and src/repository/schedulesRepository.ts).

alter table public.schedules add column if not exists anchor_date date;

comment on column public.schedules.anchor_date is
  'A real, manager-entered date this recurrence is counted FROM - one date the job was genuinely due on. It supplies the cycle PHASE only (which months are in cycle, for any interval), never the day: fixed_weekday still takes its day from week_ordinal/weekday and fixed_date from day_of_month. For due_month it additionally supplies the suggested day-of-month when booking. Null means not recorded: every derivation falls back to its pre-anchor behaviour and reports "not determinable" rather than guessing.';

-- An ad-hoc job has no cycle at all, so it can never have a phase. This is a SEPARATE, NEW constraint:
-- schedules_type_consistency_check is a whitelist of the columns it names (it does not mention `notes` or
-- `roll_forward_on_weekend` either), so a column it never mentions is invisible to it. It is deliberately
-- left untouched - dropping and recreating it would revalidate the whole table and open a window in which
-- inconsistent rows could be inserted, for no gain.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schedules_anchor_date_not_adhoc_check') then
    alter table public.schedules
      add constraint schedules_anchor_date_not_adhoc_check
      check (schedule_type <> 'ad_hoc' or anchor_date is null);
  end if;
end
$$;
