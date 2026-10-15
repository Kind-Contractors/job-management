// "Set a schedule", from the Monthly Plan, without leaving the month you are planning.
//
// A job priced as recurring but holding no `schedules` row can never become due, so the plan lists it as
// unplannable. Fixing that used to mean opening the whole job drawer, finding the Schedule panel and pressing
// Add schedule. This is the same job, the same form and the same save - just reached in one click.
//
// IT WRITES NOTHING OF ITS OWN. The form, its validation (`toInput`) and its save (`upsertSchedule`) are
// ScheduleEditor's, rendered here with `autoEdit` so it opens straight into the fields and `embedded` so it
// does not draw a second panel inside this one. No job is created, no visit is booked: the only write is the
// schedule for the job that was already there.
//
// Saving invalidates ['jobRows'], which is the single query the Monthly Plan derives every row from, so the job
// leaves "Needs a schedule" and picks up its real due state as soon as the modal closes.
import type { JobRow } from '../../domain/types';
import ScheduleEditor from '../jobs/ScheduleEditor';
import { describeSchedule } from '../../lib/scheduleFormat';

export interface SetScheduleDialogProps {
  job: JobRow;
  onClose: () => void;
}

export default function SetScheduleDialog({ job, onClose }: SetScheduleDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      onClick={onClose}
      data-testid="set-schedule-dialog"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Set a schedule for ${job.buildingName}`}
        className="max-h-[85vh] w-[460px] overflow-y-auto border border-neutral-300 bg-white p-4"
      >
        <div className="border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Schedule</div>
          <h2 className="mt-1 font-heading text-lg font-semibold">
            {job.schedule ? 'Edit this job’s schedule' : 'When is this job due?'}
          </h2>
          <div className="text-[12.5px] text-neutral-600">
            {job.buildingName} · {job.clientName} · {job.jobSummary}
          </div>
          <div className="mt-1 text-[11.5px] text-neutral-500">
            {job.schedule
              ? describeSchedule(job.schedule)
              : `Priced as ${job.frequencyRaw.toLowerCase()} work, but nothing says when it falls — so it never becomes due on its own.`}
          </div>
        </div>

        <div className="mt-3">
          <ScheduleEditor
            jobId={job.id}
            schedule={job.schedule}
            frequencyType={job.frequencyType}
            autoEdit
            embedded
            onSaved={onClose}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}
