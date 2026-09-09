/**
 * The page-identity row — title, one-line description, and the single
 * primary action. Matches the reference screenshot's "obvious primary
 * action" principle: everything else on the page (view switch, filters,
 * date nav) is secondary to this one button. Opens the existing
 * ScheduleDayDrawer pre-filled to today — no new booking surface.
 */
export default function ScheduleHeader({ onAddBooking }: { onAddBooking: () => void }) {
  return (
    <div className="flex flex-none items-center gap-4 px-5 pt-4 pb-3">
      <div>
        <h1 className="font-heading text-[26px] leading-none font-semibold text-ink">Schedule</h1>
        <p className="mt-1 text-[13px] text-neutral-600">
          View and manage job bookings. Drag a job onto a day to schedule it, or add a booking directly.
        </p>
      </div>
      <button
        onClick={onAddBooking}
        className="ml-auto flex-none cursor-pointer bg-teal px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
      >
        + Add booking
      </button>
    </div>
  );
}
