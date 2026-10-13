-- Report videos are now INCLUDED for the client by default; the manager unticks the ones the client should not see.
--
-- Until now report_videos.include_in_client_report defaulted to false ("opt-in: nothing is shared until a manager ticks it"). The
-- manager-facing change is: no report-level "Include videos" switch, every video selected by default, untick per video. A technician's
-- video is inserted by technician_attach_video, which does not name this column, so the column default is what decides - this changes it.
--
-- Purely additive and safe to re-run: it only changes the DEFAULT used by future inserts. It does NOT touch any existing row (a video
-- that is currently unticked stays unticked), so nothing already chosen by a manager changes, and no function, trigger, policy or
-- grant is altered. (The manager upload in the app also sets the value explicitly, so it never depended on this default.)
--
-- Nothing else in the database reads this default: the client-link functions check the flag per video, as before.

alter table public.report_videos alter column include_in_client_report set default true;

comment on column public.report_videos.include_in_client_report is
  'Whether the client report shows this video. True by default; a manager unticks a video to keep it from the client. The client report and the client links show a video only while this is on (and its report is approved).';
