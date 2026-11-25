import type { JobRow } from '../../domain/types';
import FormDialog from '../ui/FormDialog';
import JobEditor from './JobEditor';

/** "Edit" from the All live jobs Actions column: the existing job editor (same fields, checks and saving) in a dialog. */
export default function JobEditDialog({ job, onClose }: { job: JobRow; onClose: () => void }) {
  return (
    <FormDialog eyebrow="Edit job" title={`${job.buildingName} · ${job.jobSummary}`} onClose={onClose} testId="job-edit-dialog" width={560}>
      <JobEditor job={job} onDone={onClose} embedded />
    </FormDialog>
  );
}
