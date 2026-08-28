import type { JobStatus } from '../../domain/types';
import { getStatusPresentation } from '../../lib/statusPresentation';

export default function StatusPill({ status }: { status: JobStatus }) {
  const p = getStatusPresentation(status);
  return (
    <div className={`flex items-center gap-1.5 font-heading text-[11px] font-semibold tracking-[0.07em] uppercase ${p.fg}`}>
      <i className={`block h-1.5 w-1.5 border ${p.dot} ${p.border}`} />
      {p.label}
    </div>
  );
}
