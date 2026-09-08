import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getVisitDetail, listTodayVisits } from './api';

interface CompletedNavState {
  photoCount?: number;
  onSiteStart?: string;
  onSiteEnd?: string;
}

const timeFormatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function CompletedPage() {
  const navigate = useNavigate();
  const { visitId } = useParams<{ visitId: string }>();
  const location = useLocation();
  const state = (location.state as CompletedNavState | null) ?? {};

  // The actual source of truth for "was this really completed" — never just
  // the presence of this route or the navigation state (which a direct
  // reload/URL visit wouldn't have anyway). Reuses the same technician-safe
  // RPC every other screen already calls; no new/broader data access.
  const {
    data: visit,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['technician', 'visitDetail', visitId],
    queryFn: () => getVisitDetail(visitId!),
    enabled: !!visitId,
  });

  // Best-effort only, exactly like Job File's own "Stop N" — renders correctly with or without it.
  const { data: todayVisits } = useQuery({ queryKey: ['technician', 'todayVisits'], queryFn: listTodayVisits });
  const nextStop = todayVisits?.find((v) => v.visitId !== visitId && v.status !== 'completed' && !v.reportSubmitted);

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
      </div>
    );
  }

  if (isError || !visit || !visit.reportId) {
    // Never shows a false "completed / sent to the office" confirmation —
    // this is the honest state whenever no report actually exists for this
    // visit yet, regardless of how this screen was reached.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="p-4">
          <div className="border border-neutral-300 bg-white px-5 py-10 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              This visit hasn't been completed yet
            </div>
            <div className="mt-1.5 text-[13px] text-neutral-600">No report has been submitted for this visit.</div>
            <button
              onClick={() => navigate(visitId ? `/technician/visits/${visitId}` : '/technician')}
              className="mt-3 cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
            >
              Back to job file
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-teal-700/40 bg-teal-100 px-4 py-3">
        <h1 className="font-heading text-lg font-semibold text-teal-700">Job completed</h1>
        <div className="text-[12.5px] text-teal-700">Sent to the office</div>
      </div>

      <div className="flex-1 bg-white px-4 py-4">
        {(state.photoCount != null || state.onSiteStart) && (
          <div className="mb-4 grid grid-cols-2 gap-3 border border-neutral-300 p-3">
            {state.photoCount != null && (
              <div>
                <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Photos</div>
                <div className="text-lg font-semibold text-ink tabular-nums">{state.photoCount}</div>
              </div>
            )}
            {state.onSiteStart && state.onSiteEnd && (
              <div>
                <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">On site</div>
                <div className="text-lg font-semibold text-ink tabular-nums">
                  {timeFormatter.format(new Date(state.onSiteStart))} – {timeFormatter.format(new Date(state.onSiteEnd))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="text-[13.5px] leading-relaxed text-neutral-700">
          The office will check this report before anything goes to the client. Nothing else for you to do here.
        </div>
      </div>

      <div className="p-4">
        {nextStop ? (
          <button
            onClick={() => navigate(`/technician/visits/${nextStop.visitId}`)}
            className="w-full cursor-pointer bg-teal px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Next stop — {nextStop.buildingName ?? nextStop.buildingAddress}
          </button>
        ) : (
          <button
            onClick={() => navigate('/technician')}
            className="w-full cursor-pointer bg-teal px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Back to your day
          </button>
        )}
      </div>
    </div>
  );
}
