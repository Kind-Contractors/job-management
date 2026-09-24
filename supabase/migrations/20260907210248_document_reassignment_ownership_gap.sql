-- Documentation only — no behavior change. Records a known architectural
-- gap found in the Phase 1-3 technician-flow audit (2026-09-07), so it isn't
-- rediscovered or silently reintroduced when an existing-visit reassignment
-- feature is eventually built.
--
-- Ownership in every technician-facing RPC/Storage policy is CURRENT-
-- assignment-only (visits.technician_id at query time) — there is no
-- reassignment history. Today this is safe: no Manager UI reassigns an
-- already-created visit's technician (only initial booking and the job-level
-- default_technician_id can be set). If that ever changes, report/photo
-- ownership across reassignment must be explicitly redesigned first —
-- otherwise, reassigning a visit after a report already exists would let the
-- newly assigned technician read the previous technician's submitted report
-- content and photos through this same ownership check (technician B would
-- inherit technician A's work, not just the go-forward assignment).

comment on function public.technician_visit_detail(uuid) is
  'Ownership check is CURRENT visits.technician_id only, no reassignment history. '
  'If an existing-visit reassignment feature is built, redesign report/photo '
  'ownership across reassignment first — otherwise a newly assigned '
  'technician can read the previous technician''s already-submitted report '
  'and photos for the same visit. See Phase 1-3 audit, 2026-09-07.';

comment on function public.technician_submit_report(uuid, text, text, text, timestamptz, timestamptz, jsonb) is
  'Ownership check is CURRENT visits.technician_id only, no reassignment '
  'history. Same caveat as technician_visit_detail() — see that function''s '
  'comment and the Phase 1-3 audit, 2026-09-07.';

comment on policy technician_own_visit_photos_select on storage.objects is
  'Ownership check is CURRENT visits.technician_id only, no reassignment '
  'history — a newly assigned technician can read a previous technician''s '
  'already-uploaded photos for the same visit. See the Phase 1-3 audit, '
  '2026-09-07, and technician_visit_detail()''s matching comment.';

comment on policy technician_own_visit_photos_insert on storage.objects is
  'Same reassignment-ownership caveat as technician_own_visit_photos_select — see its comment.';
