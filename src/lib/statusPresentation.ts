import type { JobStatus } from '../domain/types';

export interface StatusPresentation {
  label: string;
  /** Text color (Tailwind class). */
  fg: string;
  /** Status dot fill (Tailwind class). */
  dot: string;
  /** Dot border, for the "not due" hollow-dot look. */
  border: string;
}

/**
 * Only a handful of colors carry meaning (the approved design's own rule —
 * see CLAUDE.md section 4): brand teal for "normal/active", and the three
 * functional tones (due/missed/done) for everything else. Never introduce a
 * new hue for a new status without updating that rule deliberately.
 */
const PRESENTATIONS: Record<JobStatus, StatusPresentation> = {
  booked: { label: 'Booked', fg: 'text-teal-700', dot: 'bg-teal', border: 'border-teal' },
  needs_booking: { label: 'Needs booking', fg: 'text-due-fg', dot: 'bg-due', border: 'border-due' },
  not_due: { label: 'Not due yet', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400' },
  review: { label: 'Report to review', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700' },
  onsite: { label: 'On site now', fg: 'text-teal-700', dot: 'bg-teal-700', border: 'border-teal-700' },
  missed: { label: 'Missed', fg: 'text-missed-fg', dot: 'bg-missed', border: 'border-missed' },
  ask: { label: 'No schedule', fg: 'text-neutral-600', dot: 'bg-transparent', border: 'border-neutral-400' },
};

export function getStatusPresentation(status: JobStatus): StatusPresentation {
  return PRESENTATIONS[status];
}

export function dueColorClass(status: JobStatus, softDate: boolean): string {
  if (status === 'missed') return 'text-missed-fg';
  if (softDate) return 'text-due-fg';
  return 'text-ink';
}
