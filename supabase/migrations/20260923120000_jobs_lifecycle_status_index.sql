-- Index for jobs.lifecycle_status — this column has no index anywhere in
-- the schema, despite being filtered on every single app load:
-- listJobRows() (.eq('lifecycle_status', 'active'), the shared query behind
-- All Live Jobs / Report Review / Ready for Accounts / Ready for Client /
-- Building File's job list) and listHistoricalJobRows()
-- (.in('lifecycle_status', HISTORICAL_LIFECYCLE_STATUSES), the Historical/
-- Lost Jobs view) — see src/repository/jobsRepository.ts.
--
-- Pure read-optimization: does not alter, insert, or backfill any row.
create index if not exists jobs_lifecycle_status_idx on public.jobs (lifecycle_status);
