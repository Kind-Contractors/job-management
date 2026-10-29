// Friendly wording for the Building File History timeline: one title per activity_events.event_type, and a tidy form of the detail
// line for the video and photo events (the database writes machine-friendly details such as "before" or "2 link(s), valid 365 days").
// A new event kind that has no entry here falls back to the raw string rather than breaking the timeline.

/** Human-readable title per activity_events.event_type — new event kinds fall back to the raw string rather than breaking the timeline. */
export const HISTORY_EVENT_LABEL: Record<string, string> = {
  building_created: 'Building created',
  building_details_updated: 'Building details updated',
  building_client_changed: 'Client changed',
  site_instructions_updated: 'Site instructions updated',
  access_info_updated: 'Access details updated',
  contact_added: 'Contact added',
  contact_updated: 'Contact updated',
  contact_deleted: 'Contact deleted',
  job_created: 'Job created',
  job_details_updated: 'Job details updated',
  job_price_changed: 'Price changed',
  job_frequency_changed: 'Frequency changed',
  job_default_technician_changed: 'Default technician changed',
  visit_created: 'Visit scheduled',
  visit_rescheduled: 'Visit rescheduled',
  visit_technician_assigned: 'Technician assigned',
  visit_technician_changed: 'Technician changed',
  visit_technician_unassigned: 'Technician unassigned',
  visit_technician_added: 'Additional technician added',
  visit_technician_removed: 'Additional technician removed',
  report_contribution_returned: 'Technician contribution returned',
  report_contribution_waived: 'Technician waived from report',
  visit_completed: 'Visit completed',
  visit_missed: 'Visit missed',
  visit_cancelled: 'Visit cancelled',
  report_submitted: 'Report submitted',
  report_approved: 'Report approved',
  report_returned: 'Report returned for correction',
  report_resubmitted: 'Report resubmitted',
  report_sent_to_client: 'Sent to client',
  report_sent_to_accounts: 'Sent to accounts',
  report_completed: 'Report completed',
  report_reopened: 'Report reopened',
  report_photo_added: 'Photo added',
  report_photo_removed: 'Photo removed',
  report_photo_moved: 'Photo moved',
  report_video_added: 'Video added',
  report_video_removed: 'Video removed',
  report_video_moved: 'Video moved',
  report_video_links_issued: 'Client video links created',
  report_video_links_revoked: 'Client video links revoked',
};

const VIDEO_PHASE_DETAIL: Record<string, string> = { before: 'Before section', during: 'During section', after: 'After section' };

/** The detail line shown under an event's title; most events pass straight through. */
export function historyEventDetail(eventType: string, detail: string | null): string | null {
  if (!detail) return detail;
  if (eventType === 'report_video_added' || eventType === 'report_video_removed' || eventType === 'report_photo_added' || eventType === 'report_photo_removed') return VIDEO_PHASE_DETAIL[detail] ?? detail;
  // A move is written as "from:to" (for example "before:during").
  if (eventType === 'report_photo_moved' || eventType === 'report_video_moved') {
    const [from, to] = detail.split(':');
    if (from && to && VIDEO_PHASE_DETAIL[from] && VIDEO_PHASE_DETAIL[to]) return `${VIDEO_PHASE_DETAIL[from]} → ${VIDEO_PHASE_DETAIL[to]}`;
  }
  if (eventType === 'report_video_links_issued') {
    const m = /^(\d+) link\(s\), valid (\d+) days?$/.exec(detail);
    if (m) return `${m[1]} ${m[1] === '1' ? 'link' : 'links'}, valid for ${m[2]} days`;
  }
  if (eventType === 'report_video_links_revoked') {
    const m = /^(\d+) link\(s\)$/.exec(detail);
    if (m) return `${m[1]} ${m[1] === '1' ? 'link' : 'links'}`;
  }
  return detail;
}
