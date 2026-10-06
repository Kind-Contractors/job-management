-- Optional time range on a visit (job booking), the same two optional values activities have.
--
-- Purely additive: every existing visit gets NULL/NULL, which means "no time" and behaves exactly as
-- before. A visit's time is display-only and NEVER decides its position in the day (that is sort_order).
-- No existing function, trigger or policy is changed; none of them reads these columns.
alter table public.visits
  add column start_time time without time zone,
  add column end_time time without time zone;

-- No time, a start only, or a start with a later end on the same day. An end without a start is meaningless.
alter table public.visits
  add constraint visits_time_range_check check (end_time is null or (start_time is not null and end_time > start_time));

comment on column public.visits.start_time is 'Optional local wall-clock start time on scheduled_date. Display only; never used for ordering (see sort_order).';
comment on column public.visits.end_time is 'Optional local wall-clock end time (same day, after start_time). Requires start_time.';
