import type { StatusPresentation } from '../../lib/statusPresentation';

/**
 * The one status-chip renderer in the app — dot + uppercase label, colored
 * per the shared restrained palette. Takes a resolved StatusPresentation
 * directly (not a raw JobStatus) so the same chip shape is reusable for
 * visit statuses and report review statuses too, via
 * getVisitStatusPresentation()/getReportReviewStatusPresentation()
 * (statusPresentation.ts) — never a second chip implementation.
 */
export default function StatusPill({ presentation }: { presentation: StatusPresentation }) {
  return (
    <div className={`flex items-center gap-1.5 font-heading text-[11px] font-semibold tracking-[0.07em] uppercase ${presentation.fg}`}>
      <i className={`block h-1.5 w-1.5 border ${presentation.dot} ${presentation.border}`} />
      {presentation.label}
    </div>
  );
}
