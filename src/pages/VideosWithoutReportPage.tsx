import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import ReportVideos from '../components/reports/ReportVideos';
import { VIDEO_PHASES, VIDEO_PHASE_LABEL } from '../lib/reportVideoRules';
import { listVisitsWithVideosNoReport, type VisitWithVideosNoReport } from '../repository/reportVideosRepository';

/** The visit was kept when its job was cancelled (cancel_job_work keeps a visit that has a video), or is itself cancelled. */
export function isRetainedOnCancelledJob(v: Pick<VisitWithVideosNoReport, 'jobLifecycleStatus' | 'visitStatus'>): boolean {
  return v.jobLifecycleStatus === 'cancelled' || v.visitStatus === 'cancelled';
}

function dateLabel(date: string | null): string {
  return date ? new Date(date).toLocaleDateString('en-GB') : 'No date set';
}

/** "Before 1 · During 2" - only the sections that have a video. */
export function phaseSummary(videos: { phase: 'before' | 'during' | 'after' }[]): string {
  return VIDEO_PHASES.filter((p) => videos.some((v) => v.phase === p))
    .map((p) => `${VIDEO_PHASE_LABEL[p]} ${videos.filter((v) => v.phase === p).length}`)
    .join(' · ');
}

export function VisitVideosCard({
  visit,
  expanded,
  actor,
  onToggle,
  onOpenBuilding,
}: {
  visit: VisitWithVideosNoReport;
  expanded: boolean;
  actor: string;
  onToggle: () => void;
  onOpenBuilding: () => void;
}) {
  const retained = isRetainedOnCancelledJob(visit);
  return (
    <div className="border border-neutral-300 bg-white p-3" data-testid="visit-with-videos">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-heading text-[15px] font-semibold">{visit.buildingName ?? 'Unknown building'}</div>
          <div className="mt-0.5 text-[12.5px] text-neutral-600">
            {visit.clientName ?? 'Unknown client'} · {visit.jobSummary ?? 'No job summary'} · Visit {dateLabel(visit.scheduledDate)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="border border-neutral-300 px-1.5 py-0.5 text-neutral-700 tabular-nums">
              {visit.videos.length} {visit.videos.length === 1 ? 'video' : 'videos'} · {phaseSummary(visit.videos)}
            </span>
            {visit.videos.some((v) => v.source === 'technician') && (
              <span className="text-neutral-500">
                from {[...new Set(visit.videos.filter((v) => v.source === 'technician').map((v) => v.uploadedByName ?? 'a technician'))].join(', ')}
              </span>
            )}
            {retained && <span className="border border-due px-1.5 py-0.5 text-due-fg">Kept after the job was cancelled</span>}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2 text-[11.5px]">
          {visit.buildingId && (
            <button onClick={onOpenBuilding} className="cursor-pointer text-teal-700 hover:underline">
              Open building file
            </button>
          )}
          <button
            onClick={onToggle}
            aria-expanded={expanded}
            className="cursor-pointer border border-neutral-300 px-2.5 py-1 text-neutral-700 hover:bg-neutral-100"
          >
            {expanded ? 'Hide videos' : 'View videos'}
          </button>
        </div>
      </div>
      {retained && (
        <div className="mt-2 text-[11.5px] text-neutral-600">
          This visit was kept when its job was cancelled because it has a video. It stays open until the technician submits a report, or the videos are removed
          below. Removing a video keeps its file; nothing else changes.
        </div>
      )}
      {expanded && (
        <div className="mt-3 border-t border-divider pt-3">
          <ReportVideos
            mode="noReport"
            reportId={null}
            visitId={visit.visitId}
            reviewStatus={null}
            reviewedAt={null}
            completed={false}
            includeVideos
            actor={actor}
          />
        </div>
      )}
    </div>
  );
}

export interface VideosWithoutReportViewProps {
  visits: VisitWithVideosNoReport[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  expanded: Set<string>;
  actor: string;
  onToggle: (visitId: string) => void;
  onOpenBuilding: (buildingId: string) => void;
}

/** The page's content for a given state. Presentational: the page below owns the query and the expand/collapse state. */
export function VideosWithoutReportView({ visits, isLoading, isError, error, onRetry, expanded, actor, onToggle, onOpenBuilding }: VideosWithoutReportViewProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="max-w-[900px] p-5">
        <h1 className="font-heading text-lg font-semibold">Videos without a report</h1>
        <div className="mt-0.5 text-xs text-neutral-600 tabular-nums">
          {visits.length} {visits.length === 1 ? 'visit' : 'visits'}
        </div>
        <div className="mt-1 text-[12.5px] text-neutral-600">
          Visits where a video has been uploaded but no report has been submitted yet. Once the report arrives it appears in Report review with its videos.
        </div>

        {isLoading ? (
          <div className="mt-4 font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
        ) : isError ? (
          <div role="alert" className="mt-4 border border-missed bg-missed/10 p-3 text-[12.5px] text-missed-fg">
            Couldn’t load these visits: {error instanceof Error ? error.message : 'something went wrong.'}{' '}
            <button onClick={onRetry} className="cursor-pointer underline">
              Try again
            </button>
          </div>
        ) : visits.length === 0 ? (
          <div className="mt-6 font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
            Nothing here — every visit with videos has a report
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {visits.map((v) => (
              <VisitVideosCard
                key={v.visitId}
                visit={v}
                expanded={expanded.has(v.visitId)}
                actor={actor}
                onToggle={() => onToggle(v.visitId)}
                onOpenBuilding={() => onOpenBuilding(v.buildingId ?? '')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function VideosWithoutReportPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const actor = session?.user.email ?? 'unknown';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data: visits = [], isLoading, isError, error, refetch } = useQuery({ queryKey: ['videosWithoutReport'], queryFn: listVisitsWithVideosNoReport });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <VideosWithoutReportView
      visits={visits}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      expanded={expanded}
      actor={actor}
      onToggle={toggle}
      onOpenBuilding={(id) => navigate(`/buildings/${id}`)}
    />
  );
}
