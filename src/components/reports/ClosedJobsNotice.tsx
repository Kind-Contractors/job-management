import { CLOSED_JOBS_ERROR_TEXT } from '../../lib/queueJobs';

/** Shown above a report queue when report work on cancelled/closed jobs could not be loaded - so the list is never silently incomplete. */
export default function ClosedJobsNotice({ show, onRetry }: { show: boolean; onRetry: () => void }) {
  if (!show) return null;
  return (
    <div role="alert" className="mx-3.5 mt-2.5 border border-due bg-due/10 px-2.5 py-2 text-[12px] text-due-fg">
      {CLOSED_JOBS_ERROR_TEXT}{' '}
      <button type="button" onClick={onRetry} className="cursor-pointer underline">
        Try again
      </button>
    </div>
  );
}
