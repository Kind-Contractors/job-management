import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { JobRow, JobVisitSummary } from "../domain/types";
import { listJobRows } from "../repository/jobsRepository";
import {
  completeReport,
  getLatestClientSend,
  getReport,
  listPhotosForReport,
  reopenReport,
  sendClientReport,
  signReportPhotoUrls,
  updatePhotoClientInclusion,
  updateReport,
  type ReportPhoto,
} from "../repository/reportsRepository";
import {
  isReportCompleted,
  isReportReadyForClient,
} from "../lib/statusPresentation";
import { useAuth } from "../auth/AuthProvider";
import {
  CompleteButton,
  CompleteConfirm,
  CompletedBanner,
  ReadyForClientTabs,
  SentBadge,
  formatWhen,
  type QueueView,
} from "../components/reports/ReportCompletionControls";
import { resolveDisplayContact } from "../lib/contactDisplay";
import {
  buildClientReportModel,
  type ClientReportModel,
} from "../lib/clientReportModel";
import {
  FOOTER_CONTACT_LINE,
  ISSUE_HELPER_TEXT,
  generateClientReportPdf,
  prepareClientReportPhotos,
  type PreparedReportPhotos,
} from "../lib/clientReportPdf";
import {
  PHOTO_CELL_ASPECT,
  PHOTO_GRID_COLUMNS,
  photoTag,
  planPhotoLayout,
  type OrderedPhotoEntry,
} from "../lib/clientReportPhotoLayout";
import type { JobContactSummary } from "../domain/types";
import { buildSendClientReportInput } from "../lib/clientEmailSend";
import AutoGrowTextarea from "../components/shared/AutoGrowTextarea";
import {
  MAX_EMAIL_MESSAGE_LENGTH,
  checkEmailMessage,
  defaultEmailMessage,
  emailMessageLength,
  formatReportDateLong,
} from "../../supabase/functions/_shared/reportEmail";
import kindContractorsLogo from "../assets/kind_Contractors_logo.png";
import kindLeaf from "../assets/kind_leaf.png";

/** Strips the `data:...;base64,` prefix a data URL carries — the email provider wants raw base64 content, not a data URL. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read the generated PDF."));
    reader.readAsDataURL(blob);
  });
}

interface SendConfirmDialogProps {
  model: ClientReportModel;
  contact: JobContactSummary;
  isSending: boolean;
  /** Set when this report was ALREADY emailed through the system: the dialog then warns that sending again emails it a second time. Null for a first send. */
  alreadySent: { at: string; to: string | null } | null;
  /** The email text the manager is about to send. Held by the page (not here) so it survives the skipped-photos warning. */
  message: string;
  onMessageChange: (message: string) => void;
  /** Puts the standard message back. */
  onResetMessage: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/** A confirmation step between clicking "Send to client" and anything actually happening — reuses ContactPopover.tsx's exact overlay pattern (the one modal precedent in this app). */
export function SendConfirmDialog({
  model,
  contact,
  isSending,
  alreadySent,
  message,
  onMessageChange,
  onResetMessage,
  onCancel,
  onConfirm,
}: SendConfirmDialogProps) {
  // The same rules the server enforces (shared module), so the button is only enabled for a message that will be accepted.
  const messageCheck = checkEmailMessage(message);
  const messageLength = emailMessageLength(message);
  const overLimit = messageLength > MAX_EMAIL_MESSAGE_LENGTH;
  const messageProblem = messageCheck.ok
    ? null
    : message.trim() === ""
      ? "The message cannot be empty."
      : `The message is too long — the maximum is ${MAX_EMAIL_MESSAGE_LENGTH} characters.`;
  const sectionsIncluded: string[] = ["Work carried out"];
  if (model.notes) sectionsIncluded.push("Notes");
  if (model.issues) sectionsIncluded.push("Issues");
  if (model.photos.length > 0)
    sectionsIncluded.push(`Photos (${model.photos.length})`);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-[420px] overflow-y-auto border border-neutral-300 bg-white p-4"
      >
        <div className="border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
            Confirm send
          </div>
          <h2 className="mt-1 font-heading text-lg font-semibold">
            {model.buildingName}
          </h2>
          <div className="text-[12.5px] text-neutral-600">
            {model.clientName} · {model.jobSummary} · {model.visitDateLabel}
          </div>
        </div>

        {alreadySent && (
          <div
            role="alert"
            className="mt-3 border border-due bg-due/10 p-2.5 text-[12.5px] text-due-fg"
          >
            <span className="font-semibold">Already sent.</span> This report was
            emailed{alreadySent.to ? ` to ${alreadySent.to}` : ""} on{" "}
            {formatWhen(alreadySent.at)}. Sending it again will email the client
            a second copy. If you only need to finish with this report, cancel
            and use Completed instead.
          </div>
        )}

        <div className="mt-3 text-[12.5px] text-ink">
          Sending to <span className="font-semibold">{contact.name}</span> (
          {contact.email})
        </div>

        <div className="mt-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
            Included
          </div>
          <ul className="mt-1 list-inside list-disc text-[12.5px] text-ink">
            {sectionsIncluded.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>

        <div className="mt-2.5">
          <div className="flex items-baseline justify-between">
            <label
              htmlFor="client-email-message"
              className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase"
            >
              Email message
            </label>
            <button
              type="button"
              onClick={onResetMessage}
              disabled={isSending}
              className="cursor-pointer text-[11.5px] text-teal underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset to standard message
            </button>
          </div>
          <AutoGrowTextarea
            id="client-email-message"
            minRows={7}
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            disabled={isSending}
            aria-invalid={messageProblem !== null}
            className="mt-1 block w-full border border-neutral-300 p-2 text-[12.5px] text-ink disabled:opacity-60"
          />
          <div className="mt-1 flex justify-between text-[11.5px]">
            <span
              role={messageProblem ? "alert" : undefined}
              className="text-missed-fg"
            >
              {messageProblem}
            </span>
            <span
              className={`tabular-nums ${overLimit ? "font-semibold text-missed-fg" : "text-neutral-600"}`}
            >
              {messageLength} / {MAX_EMAIL_MESSAGE_LENGTH}
            </span>
          </div>
          <div className="mt-0.5 text-[11.5px] text-neutral-600">
            The PDF report is attached automatically. The subject line is set by
            the system.
          </div>
        </div>

        <div className="mt-3.5 flex gap-1.5">
          <button
            onClick={onConfirm}
            disabled={isSending || messageProblem !== null}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSending
              ? "Sending…"
              : alreadySent
                ? "Send again"
                : "Confirm and send"}
          </button>
          <button
            onClick={onCancel}
            disabled={isSending}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface SkippedPhotosDialogProps {
  count: number;
  action: "download" | "send";
  onCancel: () => void;
  onContinue: () => void;
}

/** Shown before Download/Send when some photos couldn't be read — the report is never sent or downloaded until the manager explicitly chooses to continue without them. */
function SkippedPhotosDialog({
  count,
  action,
  onCancel,
  onContinue,
}: SkippedPhotosDialogProps) {
  const noun = count === 1 ? "photo" : "photos";
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] border border-missed bg-white p-4"
      >
        <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-missed-fg uppercase">
          {count} {noun} can't be included
        </div>
        <div className="mt-2 text-[12.5px] text-ink">
          {count} {noun} couldn't be read, so {count === 1 ? "it" : "they"} will
          be missing from this report. You can{" "}
          {action === "send" ? "send" : "download"} the report without{" "}
          {count === 1 ? "it" : "them"}, or cancel and try again.
        </div>
        <div className="mt-3.5 flex gap-1.5">
          <button
            onClick={onContinue}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white"
          >
            {action === "send" ? "Send without them" : "Download without them"}
          </button>
          <button
            onClick={onCancel}
            className="cursor-pointer border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface ClientReportRow {
  job: JobRow;
  visit: JobVisitSummary;
}

const PHASE_LABEL: Record<ReportPhoto["phase"], string> = {
  before: "Before",
  during: "During",
  after: "After",
};

/**
 * Styled to read as a physical page sitting on the workspace (shadow,
 * generous margin) rather than another app panel — the surrounding wrapper in
 * the main return gives it a soft backdrop to sit on. Purely presentational:
 * the content model/fields are unchanged, so this still shows exactly what
 * generateClientReportPdf() puts in the real attachment, nothing more — and
 * its layout (dark teal header with the leaf watermark and logo, facts strip,
 * status card, underlined section headings, issues call-out, and a large
 * Before/After pair followed by a photo grid) deliberately mirrors that PDF's
 * page 1 so the preview does not misrepresent what is sent.
 */
function ClientReportPreview({ model }: { model: ClientReportModel }) {
  const sectionHeading = (label: string) => (
    <div className="inline-block border-b-[3px] border-green pb-1 font-heading text-[15px] leading-none font-semibold text-ink">
      {label}
    </div>
  );

  const facts: [string, string][] = [
    ["Visit date", model.visitDateLabel],
    ["Service", model.jobSummary],
  ];
  if (model.photos.length > 0)
    facts.push([
      "Photos",
      `${model.photos.length} ${model.photos.length === 1 ? "photo" : "photos"}`,
    ]);

  const plan = planPhotoLayout(model.photos);

  const photoFrame = (
    entry: OrderedPhotoEntry<ClientReportModel["photos"][number]>,
    size: "large" | "small",
  ) => (
    <div
      key={entry.photo.id}
      className={`relative overflow-hidden bg-neutral-200 ${size === "large" ? "rounded-xl" : "rounded-md"}`}
      style={{ aspectRatio: PHOTO_CELL_ASPECT }}
    >
      {/* "contain" on a soft mat — the photo is never cropped or stretched. */}
      <img
        src={entry.photo.url}
        alt={photoTag(entry)}
        className="h-full w-full object-contain"
      />
      <span
        className={`absolute rounded-full font-heading font-semibold text-teal ${
          size === "large"
            ? "top-2.5 left-2.5 px-3 py-1 text-[11px]"
            : "top-1.5 left-1.5 px-2 py-0.5 text-[9px]"
        } ${entry.phase === "after" ? "bg-green" : entry.phase === "during" ? "bg-green-light" : "bg-white"}`}
      >
        {photoTag(entry)}
      </span>
    </div>
  );

  return (
    <div className="mx-auto max-w-[380px]">
      <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Client-facing preview
      </div>
      <div className="overflow-hidden border border-neutral-200 bg-white shadow-md">
        {/* The logo artwork is pale green lettering — it needs the dark header to be visible at all. */}
        <div className="relative overflow-hidden bg-teal px-5 pt-4 pb-5">
          <img
            src={kindLeaf}
            alt=""
            aria-hidden
            className="pointer-events-none absolute -top-6 -right-6 h-[210px] w-auto opacity-10"
          />
          <div className="relative flex items-start justify-between gap-2">
            <img
              src={kindContractorsLogo}
              alt="Kind Contractors"
              className="h-12 w-auto object-contain"
            />
            <div className="pt-1 font-heading text-[12px] font-semibold text-white">
              Service report
            </div>
          </div>
          <div className="relative mt-4 font-heading text-[11px] font-semibold text-green">
            {model.jobSummary}
          </div>
          <h3 className="relative mt-1 font-heading text-[26px] leading-tight font-semibold text-white">
            {model.buildingName}
          </h3>
          <div className="relative mt-1 text-[12px] text-green-light">
            Prepared for {model.clientName}
          </div>
        </div>
        <div
          className="grid bg-[#2c6257] px-5 py-3"
          style={{
            gridTemplateColumns: `repeat(${facts.length}, minmax(0, 1fr))`,
          }}
        >
          {facts.map(([label, value], i) => (
            <div
              key={label}
              className={i > 0 ? "border-l border-white/25 pl-3" : ""}
            >
              <div className="text-[9px] text-[#c0d9c6]">{label}</div>
              <div className="mt-0.5 truncate text-[12px] font-semibold text-white">
                {value}
              </div>
            </div>
          ))}
        </div>

        <div className="p-5">
          <div
            className={`flex items-center gap-3 rounded-lg px-3.5 py-3 text-[13px] font-semibold ${
              model.specMet
                ? "bg-neutral-100 text-ink"
                : "bg-[#fbf4e4] text-due-fg"
            }`}
          >
            <span
              className={`flex h-8 w-8 flex-none items-center justify-center rounded-full ${model.specMet ? "bg-green text-teal" : "bg-[#d69228] text-white"}`}
            >
              {model.specMet ? (
                <svg
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 8.4 6.4 11.8 13 4.6" />
                </svg>
              ) : (
                <span className="text-[15px] leading-none font-bold">!</span>
              )}
            </span>
            {model.specMet
              ? "Specification completed as agreed."
              : "Part of the specification was not fully completed."}
          </div>

          {(model.workCarriedOut || model.notes) && (
            <div
              className={`mt-5 grid gap-x-5 gap-y-5 ${model.workCarriedOut && model.notes ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {model.workCarriedOut && (
                <div>
                  {sectionHeading("Work carried out")}
                  <div className="mt-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
                    {model.workCarriedOut}
                  </div>
                </div>
              )}
              {model.notes && (
                <div>
                  {sectionHeading("Notes")}
                  <div className="mt-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
                    {model.notes}
                  </div>
                </div>
              )}
            </div>
          )}

          {model.issues && (
            <div className="mt-5 overflow-hidden rounded-lg border-l-4 border-[#d69228] bg-[#fbf4e4] px-3.5 py-3">
              <div className="text-[12px] font-semibold text-due-fg">
                Flagged for your attention
              </div>
              <div className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">
                {model.issues}
              </div>
              <div className="mt-1.5 text-[10px] text-neutral-600">
                {ISSUE_HELPER_TEXT}
              </div>
            </div>
          )}

          {plan.hero && (
            <div className="mt-6">
              <div className="flex items-end justify-between gap-2">
                {sectionHeading("Before and after")}
                <div className="text-[10px] text-neutral-500">
                  Photos taken on site
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {photoFrame(plan.hero.before, "large")}
                {photoFrame(plan.hero.after, "large")}
              </div>
            </div>
          )}

          {plan.rest.length > 0 && (
            <div className="mt-6">
              <div className="flex items-end justify-between gap-2">
                {sectionHeading(plan.hero ? "More photos" : "Site photographs")}
                <div className="text-[10px] text-neutral-500">
                  Photos taken on site
                </div>
              </div>
              {/* Same grid as the PDF: 3 across, Before -> During -> After. */}
              <div
                className="mt-3 grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${PHOTO_GRID_COLUMNS}, minmax(0, 1fr))`,
                }}
              >
                {plan.rest.map((entry) => photoFrame(entry, "small"))}
              </div>
            </div>
          )}

          <div className="mt-6 border-t border-divider pt-3 font-heading text-[12px] font-semibold text-teal">
            Thank you for choosing Kind Contractors
            <div className="mt-1 font-body text-[10px] font-normal text-neutral-600">
              {FOOTER_CONTACT_LINE}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 1 of the "Ready for Client" workflow — review, section/photo
 * selection, recipient resolution, and preview only. No email is sent, no
 * PDF is generated, sent_to_client_at is never written here, and nothing
 * about Ready for Accounts/Xero is touched. See CLAUDE.md/the approved
 * plan for the full phased design and what Phase 2/3 will add.
 */
export default function ReadyForClientPage({
  initialView = "awaiting",
  initialSelectedVisitId = null,
}: {
  /** Which list to open on. Only tests pass these; the app always opens on "Awaiting completion" with nothing selected. */
  initialView?: QueueView;
  initialSelectedVisitId?: string | null;
} = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(
    initialSelectedVisitId,
  );
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isSending, setIsSending] = useState(false);
  // The email text shown in the confirm dialog. Lives here (not in the dialog) so it is still there after the skipped-photos warning.
  const [emailMessage, setEmailMessage] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // Set when photo preparation couldn't include every photo — holds the already-prepared photos so continuing doesn't redo the work.
  const [skippedWarning, setSkippedWarning] = useState<{
    action: "download" | "send";
    prepared: PreparedReportPhotos;
  } | null>(null);
  // Which list is showing: reports still awaiting completion (the queue), or reports a manager has completed.
  const [view, setView] = useState<QueueView>(initialView);
  const [confirmingComplete, setConfirmingComplete] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { session } = useAuth();
  const actor = session?.user.email ?? "unknown";

  const {
    data: jobRows = [],
    isLoading,
    isError,
    error,
  } = useQuery({ queryKey: ["jobRows"], queryFn: listJobRows });

  // A report stays in the queue from approval until a manager explicitly marks it Completed - whether it was emailed
  // through the system, downloaded and sent by hand, or both (see isReportReadyForClient).
  const { awaitingRows, completedRows } = useMemo(() => {
    const awaiting: ClientReportRow[] = [];
    const completed: ClientReportRow[] = [];
    for (const job of jobRows) {
      for (const visit of job.visits) {
        if (isReportReadyForClient(visit)) awaiting.push({ job, visit });
        else if (isReportCompleted(visit)) completed.push({ job, visit });
      }
    }
    // Latest visit date first, same as Ready for accounts.
    awaiting.sort((a, b) =>
      (b.visit.scheduledDate ?? "").localeCompare(a.visit.scheduledDate ?? ""),
    );
    // Most recently completed first.
    completed.sort((a, b) =>
      (b.visit.reportCompletedAt ?? "").localeCompare(
        a.visit.reportCompletedAt ?? "",
      ),
    );
    return { awaitingRows: awaiting, completedRows: completed };
  }, [jobRows]);
  const rows = view === "awaiting" ? awaitingRows : completedRows;

  const selected = rows.find((r) => r.visit.id === selectedVisitId);
  const reportId = selected?.visit.reportId ?? null;

  const {
    data: report,
    isLoading: reportIsLoading,
    isError: reportIsError,
    error: reportError,
    refetch: refetchReport,
  } = useQuery({
    queryKey: ["report", reportId],
    queryFn: () => getReport(reportId!),
    enabled: !!reportId,
  });
  const {
    data: photos = [],
    isError: photosIsError,
    error: photosError,
    refetch: refetchPhotos,
  } = useQuery({
    queryKey: ["reportPhotos", reportId],
    queryFn: () => listPhotosForReport(reportId!),
    enabled: !!reportId,
  });
  const {
    data: photoUrls = {},
    isError: photoUrlsIsError,
    refetch: refetchPhotoUrls,
  } = useQuery({
    queryKey: ["reportPhotoUrls", reportId, photos.map((p) => p.id).join(",")],
    queryFn: () => signReportPhotoUrls(photos),
    enabled: photos.length > 0,
  });
  const {
    data: lastSend,
    isError: lastSendIsError,
    refetch: refetchLastSend,
  } = useQuery({
    queryKey: ["clientSend", reportId],
    queryFn: () => getLatestClientSend(reportId!),
    enabled: !!reportId,
  });

  // Reset the recipient choice whenever a different report is selected —
  // never carry a contact choice over from one client to another.
  useEffect(() => {
    if (!selected) {
      setSelectedContactId(null);
      return;
    }
    const resolved = resolveDisplayContact(selected.job.clientContacts);
    setSelectedContactId(
      resolved.kind === "single" || resolved.kind === "primary"
        ? resolved.contact.id
        : null,
    );
  }, [selected]);

  const selectRow = (row: ClientReportRow) => {
    setSelectedVisitId(row.visit.id);
    setSaveError(null);
    setSendError(null);
    setShowConfirmDialog(false);
    setConfirmingComplete(false);
    setCompletionError(null);
    setNotice(null);
  };

  const changeView = (next: QueueView) => {
    setView(next);
    setSelectedVisitId(null);
    setConfirmingComplete(false);
    setCompletionError(null);
    setNotice(null);
  };

  const invalidateReport = () => {
    queryClient.invalidateQueries({ queryKey: ["report", reportId] });
    queryClient.invalidateQueries({ queryKey: ["jobRows"] });
  };

  const toggleSectionMutation = useMutation({
    mutationFn: (patch: Parameters<typeof updateReport>[1]) =>
      updateReport(reportId!, patch),
    onSuccess: () => {
      invalidateReport();
      setSaveError(null);
    },
    onError: (err) =>
      setSaveError(
        err instanceof Error ? err.message : "Failed to save selection.",
      ),
  });

  const togglePhotoMutation = useMutation({
    mutationFn: ({
      photoId,
      included,
    }: {
      photoId: string;
      included: boolean;
    }) => updatePhotoClientInclusion(photoId, included),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reportPhotos", reportId] });
      setSaveError(null);
    },
    onError: (err) =>
      setSaveError(
        err instanceof Error ? err.message : "Failed to save photo selection.",
      ),
  });

  // Completed: records who and when, independent of how the report was delivered. The report then leaves the queue.
  const completeMutation = useMutation({
    mutationFn: (id: string) => completeReport(id, actor),
    onSuccess: (_data, id) => {
      setConfirmingComplete(false);
      setCompletionError(null);
      setSelectedVisitId(null);
      setNotice(
        "Report marked as completed. You can find it under Completed, and Reopen it if needed.",
      );
      queryClient.invalidateQueries({ queryKey: ["report", id] });
      queryClient.invalidateQueries({ queryKey: ["jobRows"] });
    },
    onError: (err) =>
      setCompletionError(
        err instanceof Error
          ? err.message
          : "Failed to mark the report completed.",
      ),
  });

  // Reopen: clears completed_at / completed_by and puts the report back in the queue, on the Awaiting completion list.
  const reopenMutation = useMutation({
    mutationFn: (id: string) => reopenReport(id, actor),
    onSuccess: (_data, id) => {
      setCompletionError(null);
      setView("awaiting");
      setNotice("Report reopened. It is back in the Ready for client queue.");
      queryClient.invalidateQueries({ queryKey: ["report", id] });
      queryClient.invalidateQueries({ queryKey: ["jobRows"] });
    },
    onError: (err) =>
      setCompletionError(
        err instanceof Error ? err.message : "Failed to reopen the report.",
      ),
  });

  const selectedContact =
    selected?.job.clientContacts.find((c) => c.id === selectedContactId) ??
    null;
  // Already emailed through the system? (authoritative: the report's own sent timestamp, not just the latest attempt)
  const alreadySentAt = selected?.visit.sentToClientAt ?? null;
  const model =
    selected && report
      ? buildClientReportModel(
          selected.job,
          selected.visit,
          report,
          photos,
          photoUrls,
        )
      : null;

  /** The standard message, built exactly as the server builds it when no message is supplied. */
  const standardMessage = () =>
    selected && selectedContact
      ? defaultEmailMessage({
          contactName: selectedContact.name,
          buildingName: selected.job.buildingName || "your property",
          dateLabel: formatReportDateLong(selected.visit.scheduledDate ?? null),
        })
      : "";

  /** Opening the dialog always starts from the standard message - an edit from an earlier, cancelled attempt is not kept. */
  const openSendDialog = () => {
    setEmailMessage(standardMessage());
    setSendError(null);
    setShowConfirmDialog(true);
  };

  /**
   * Downloads a PDF built from the exact same `model` the on-screen
   * preview renders — never a separate re-fetch/re-selection, so the PDF
   * can never show something the preview doesn't. Purely a local browser
   * download (Blob URL + a throwaway <a download>); nothing is uploaded,
   * emailed, or recorded as sent — sent_to_client_at is never touched here.
   */
  const downloadPdf = async (
    m: ClientReportModel,
    prepared: PreparedReportPhotos,
  ) => {
    const blob = await generateClientReportPdf(m, prepared);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${m.buildingName.replace(/[^a-z0-9]+/gi, "-")}-report.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const runDownload = async (work: () => Promise<void>) => {
    setPdfError(null);
    setIsGeneratingPdf(true);
    try {
      await work();
    } catch (err) {
      setPdfError(
        err instanceof Error ? err.message : "Failed to generate PDF.",
      );
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  /**
   * Photos are resized first so the manager can be told — before anything is
   * downloaded — if any couldn't be included. Nothing is downloaded until
   * they choose to continue (see the skipped-photos dialog below).
   */
  const handleDownloadPdf = async () => {
    if (!model) return;
    await runDownload(async () => {
      const prepared = await prepareClientReportPhotos(model);
      if (prepared.skippedCount > 0) {
        setSkippedWarning({ action: "download", prepared });
        return;
      }
      await downloadPdf(model, prepared);
    });
  };

  /**
   * The one place this app actually sends a report. Generates the PDF the
   * same way handleDownloadPdf does (same model, same function), then
   * calls the send-client-report Edge Function — which independently
   * re-verifies the report is approved and the contact belongs to this
   * client before ever calling the email provider. Only invalidating
   * ['jobRows'] on success moves this report out of the queue — a failed
   * attempt leaves everything exactly as it was, ready to retry.
   */
  const sendPrepared = async (
    m: ClientReportModel,
    prepared: PreparedReportPhotos,
    id: string,
    contactId: string,
  ) => {
    // Checked again here (not only in the dialog): exactly this cleaned text is what is sent, and nothing goes out if it is invalid.
    if (!checkEmailMessage(emailMessage).ok) {
      setSendError(
        "The message cannot be sent - check it is not empty or longer than 2,000 characters.",
      );
      return;
    }
    const blob = await generateClientReportPdf(m, prepared);
    const built = buildSendClientReportInput(
      id,
      contactId,
      await blobToBase64(blob),
      emailMessage,
    );
    if (!built.ok) {
      setSendError(built.error);
      return;
    }
    const result = await sendClientReport(built.input);
    queryClient.invalidateQueries({ queryKey: ["clientSend", id] });
    if (result.status === "sent") {
      setShowConfirmDialog(false);
      // A function that has not been updated yet ignores the message and sends the standard one - never let that pass silently.
      if (result.messageUsed !== "custom") {
        setNotice(
          "The report was emailed, but the server used the standard message instead of yours. Please tell your administrator.",
        );
      }
      queryClient.invalidateQueries({ queryKey: ["jobRows"] });
    } else {
      setSendError(result.error ?? "Failed to send.");
    }
  };

  const runSend = async (work: () => Promise<void>) => {
    setIsSending(true);
    setSendError(null);
    try {
      await work();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send.");
      queryClient.invalidateQueries({ queryKey: ["clientSend", reportId] });
    } finally {
      setIsSending(false);
    }
  };

  /** If any photo can't be included, nothing is sent — the skipped-photos dialog lets the manager choose to send without them or cancel. */
  const handleConfirmSend = async () => {
    if (!model || !selected || !reportId || !selectedContact?.email) return;
    const contactId = selectedContact.id;
    await runSend(async () => {
      const prepared = await prepareClientReportPhotos(model);
      if (prepared.skippedCount > 0) {
        setSkippedWarning({ action: "send", prepared });
        return;
      }
      await sendPrepared(model, prepared, reportId, contactId);
    });
  };

  const handleContinueDespiteSkipped = async () => {
    if (!skippedWarning || !model) return;
    const { action, prepared } = skippedWarning;
    setSkippedWarning(null);
    if (action === "download") {
      await runDownload(() => downloadPdf(model, prepared));
    } else if (selected && reportId && selectedContact?.email) {
      const contactId = selectedContact.id;
      await runSend(() => sendPrepared(model, prepared, reportId, contactId));
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[320px] flex-none flex-col border-r border-divider bg-white">
        <div className="flex-none border-b border-divider px-3.5 py-3">
          <h1 className="font-heading text-lg font-semibold">
            Ready for client
          </h1>
          <div className="mt-0.5 text-xs text-neutral-600 tabular-nums">
            {awaitingRows.length} awaiting completion
          </div>
          <ReadyForClientTabs
            view={view}
            awaitingCount={awaitingRows.length}
            completedCount={completedRows.length}
            onChange={changeView}
          />
        </div>

        {isLoading ? (
          <div className="p-3.5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
              Loading…
            </div>
          </div>
        ) : isError ? (
          <div className="p-3.5">
            <div className="border border-missed bg-missed/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load reports
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">
                {error instanceof Error
                  ? error.message
                  : "Something went wrong."}
              </div>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-5 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              {view === "awaiting"
                ? "No approved reports are waiting to be completed."
                : "No reports have been marked completed yet."}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {rows.map((row) => {
              const isSelected = row.visit.id === selectedVisitId;
              const dateLabel = row.visit.scheduledDate
                ? new Date(row.visit.scheduledDate).toLocaleDateString("en-GB")
                : "No date set";
              return (
                <div
                  key={row.visit.id}
                  onClick={() => selectRow(row)}
                  className={`cursor-pointer border-b border-divider px-3.5 py-2.5 ${isSelected ? "bg-teal-100" : "hover:bg-neutral-100"}`}
                >
                  <div className="text-[12.5px] font-semibold text-ink">
                    {row.job.buildingName}
                  </div>
                  <div className="text-[11.5px] text-neutral-600">
                    {row.job.clientName} · {row.job.jobSummary}
                  </div>
                  <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">
                    Visit {dateLabel}
                    {row.visit.technicianName
                      ? ` · ${row.visit.technicianName}`
                      : ""}
                  </div>
                  {view === "awaiting" && row.visit.sentToClientAt && (
                    <div className="mt-1">
                      <SentBadge sentAt={row.visit.sentToClientAt} />
                    </div>
                  )}
                  {view === "completed" && (
                    <div className="mt-1 text-[11px] text-done-fg">
                      Completed by {row.visit.reportCompletedBy ?? "unknown"} ·{" "}
                      {formatWhen(row.visit.reportCompletedAt)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:overflow-visible">
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
            {notice && (
              <div
                role="status"
                className="max-w-md border border-teal-700 bg-teal-100 px-3 py-2 text-[12.5px] text-teal-700"
              >
                {notice}
              </div>
            )}
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              Select an item on the left
            </div>
          </div>
        ) : reportIsError ? (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="border border-missed bg-missed/10 p-4">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load this report
              </div>
              <div className="mt-1.5 text-[13px] text-ink">
                {reportError instanceof Error
                  ? reportError.message
                  : "Something went wrong."}
              </div>
              <button
                onClick={() => void refetchReport()}
                className="mt-3 cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100"
              >
                Try again
              </button>
            </div>
          </div>
        ) : reportIsLoading || !report ? (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
              Loading report…
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-5 lg:h-full lg:flex-row lg:items-start">
            {/* Preparation column — cards scroll internally on desktop; Download/Send stay pinned below them. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:h-full lg:min-h-0">
              <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-0.5">
                <div className="pb-3">
                  <h2 className="font-heading text-xl font-semibold">
                    {selected.job.buildingName}
                  </h2>
                  <div className="mt-0.5 text-[13px] text-neutral-600">
                    {selected.job.clientName} · {selected.job.jobSummary}
                    {selected.visit.scheduledDate &&
                      ` · Visit ${new Date(selected.visit.scheduledDate).toLocaleDateString("en-GB")}`}
                    {selected.visit.technicianName &&
                      ` · ${selected.visit.technicianName}`}
                  </div>
                  <button
                    onClick={() =>
                      navigate(`/buildings/${selected.job.buildingId}`)
                    }
                    className="mt-1.5 cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                  >
                    Open building file
                  </button>
                </div>

                {view === "completed" && (
                  <CompletedBanner
                    completedAt={selected.visit.reportCompletedAt ?? null}
                    completedBy={selected.visit.reportCompletedBy ?? null}
                    sentAt={alreadySentAt}
                    pending={reopenMutation.isPending}
                    onReopen={() => reopenMutation.mutate(reportId!)}
                  />
                )}
                {view === "awaiting" && alreadySentAt && (
                  <div className="mb-3 border border-done bg-done/10 px-3 py-2 text-[12.5px] text-done-fg">
                    <span className="font-semibold">Sent to client</span> on{" "}
                    {formatWhen(alreadySentAt)}. This report stays in the queue
                    until you mark it Completed.
                  </div>
                )}

                {/* Read-only reference — plain gray fields, no interactive controls, so it never reads like an editable section. */}
                <section className="border border-neutral-300 bg-white p-3">
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                    Report details
                  </div>
                  <div className="mt-1.5 flex flex-col gap-2">
                    <div className="text-[11px] text-neutral-500">
                      {report.specMet
                        ? "Specification: Completed"
                        : "Specification: Not fully completed"}
                    </div>
                    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                      Work carried out
                      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink">
                        {report.workCarriedOut || "—"}
                      </div>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                      Notes
                      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink">
                        {report.technicianNotes || "—"}
                      </div>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                      Issues
                      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink">
                        {report.issues || "—"}
                      </div>
                    </label>
                  </div>
                </section>

                {/* The actual editorial decision for this page — real, white, interactive controls, visually distinct from the read-only card above. */}
                <section className="mt-3 border border-neutral-300 bg-white p-3">
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                    Client-visible content
                  </div>
                  <div className="mt-1.5 flex flex-col gap-1 text-[12.5px] text-ink">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={report.includeNotes}
                        onChange={(e) =>
                          toggleSectionMutation.mutate({
                            includeNotes: e.target.checked,
                          })
                        }
                      />
                      Include notes
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={report.includeIssues}
                        onChange={(e) =>
                          toggleSectionMutation.mutate({
                            includeIssues: e.target.checked,
                          })
                        }
                      />
                      Include issues
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={report.includePhotos}
                        onChange={(e) =>
                          toggleSectionMutation.mutate({
                            includePhotos: e.target.checked,
                          })
                        }
                      />
                      Include photos
                    </label>
                  </div>
                  {saveError && (
                    <div className="mt-1.5 text-[11.5px] text-missed-fg">
                      {saveError}
                    </div>
                  )}

                  {report.includePhotos && (
                    <div className="mt-3 border-t border-divider pt-3">
                      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                        Photos — select which to include
                      </div>
                      {photosIsError ? (
                        <div className="mt-1.5 border border-missed bg-missed/10 p-2.5 text-[12px] text-missed-fg">
                          Couldn't load this report's photos
                          {photosError instanceof Error
                            ? `: ${photosError.message}`
                            : "."}
                          <button
                            onClick={() => void refetchPhotos()}
                            className="ml-2 cursor-pointer underline"
                          >
                            Try again
                          </button>
                        </div>
                      ) : (
                        photoUrlsIsError && (
                          <div className="mt-1.5 border border-missed bg-missed/10 p-2.5 text-[12px] text-missed-fg">
                            Couldn't load photo previews.
                            <button
                              onClick={() => void refetchPhotoUrls()}
                              className="ml-2 cursor-pointer underline"
                            >
                              Try again
                            </button>
                          </div>
                        )
                      )}
                      {/* Phases sit side by side (not stacked) so each column's thumbnails can be
                          larger — three narrow wrapped rows wasted most of the card's width before. */}
                      <div className="mt-1.5 grid grid-cols-3 gap-3">
                        {(["before", "during", "after"] as const).map(
                          (phase) => {
                            const phasePhotos = photos.filter(
                              (p) => p.phase === phase,
                            );
                            if (phasePhotos.length === 0) return null;
                            return (
                              <div key={phase}>
                                <div className="mb-1 font-heading text-[9.5px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
                                  {PHASE_LABEL[phase]}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {phasePhotos.map((p) => (
                                    <label
                                      key={p.id}
                                      className="relative block h-20 w-20 cursor-pointer"
                                      title={
                                        p.includeInClientReport
                                          ? "Included — click to exclude"
                                          : "Excluded — click to include"
                                      }
                                    >
                                      {photoUrls[p.id] && (
                                        <img
                                          src={photoUrls[p.id]}
                                          alt=""
                                          className={`h-20 w-20 border object-cover ${p.includeInClientReport ? "border-teal" : "border-neutral-300 opacity-40"}`}
                                        />
                                      )}
                                      {/* Real checkbox, just repositioned as a corner overlay — same mutation, same keyboard/tab behavior, no separate "Include" label row taking up vertical space. */}
                                      <input
                                        type="checkbox"
                                        checked={p.includeInClientReport}
                                        onChange={(e) =>
                                          togglePhotoMutation.mutate({
                                            photoId: p.id,
                                            included: e.target.checked,
                                          })
                                        }
                                        aria-label={
                                          p.includeInClientReport
                                            ? "Included in client report"
                                            : "Not included in client report"
                                        }
                                        className="absolute top-0.5 right-0.5 h-3.5 w-3.5 cursor-pointer accent-teal"
                                      />
                                    </label>
                                  ))}
                                </div>
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>
                  )}
                </section>

                <section className="mt-3 border border-neutral-300 bg-white p-3">
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                    Recipient
                  </div>
                  {selected.job.clientContacts.length === 0 ? (
                    <div className="mt-1.5 text-[12.5px] text-due-fg">
                      This client has no contact on file — add one before this
                      report can be sent (All Live Jobs' Contact column).
                    </div>
                  ) : (
                    <>
                      <select
                        value={selectedContactId ?? ""}
                        onChange={(e) =>
                          setSelectedContactId(e.target.value || null)
                        }
                        className="mt-1.5 border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                      >
                        <option value="">Choose a recipient…</option>
                        {selected.job.clientContacts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.email ? ` · ${c.email}` : " · no email on file"}
                          </option>
                        ))}
                      </select>
                      {selectedContact ? (
                        <div className="mt-1.5 text-[12.5px] text-ink">
                          Sending to{" "}
                          <span className="font-semibold">
                            {selectedContact.name}
                          </span>
                          {selectedContact.email
                            ? ` (${selectedContact.email})`
                            : " — no email on file for this contact."}
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[11.5px] text-due-fg">
                          Multiple contacts exist for this client — choose one
                          before sending.
                        </div>
                      )}
                    </>
                  )}
                  {lastSendIsError ? (
                    <div className="mt-1.5 text-[11.5px] text-missed-fg">
                      Couldn't check this report's send history.
                      <button
                        onClick={() => void refetchLastSend()}
                        className="ml-1.5 cursor-pointer underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : (
                    lastSend && (
                      <div
                        className={`mt-1.5 text-[11.5px] ${lastSend.status === "failed" ? "text-missed-fg" : "text-neutral-500"}`}
                      >
                        {lastSend.status === "sent"
                          ? `Sent to ${lastSend.recipientEmail} on ${new Date(lastSend.createdAt).toLocaleString("en-GB")}.`
                          : lastSend.status === "failed"
                            ? `Last attempt failed (${new Date(lastSend.createdAt).toLocaleString("en-GB")}): ${lastSend.errorMessage ?? "Unknown error."}`
                            : "A send is currently in progress…"}
                      </div>
                    )
                  )}
                </section>
              </div>

              {/* Persistent — never scrolls away with the cards above it on desktop. */}
              <div className="flex-none border-t border-divider pt-3 pb-0.5">
                {pdfError && (
                  <div className="mb-2 text-[11.5px] text-missed-fg">
                    {pdfError}
                  </div>
                )}
                {sendError && (
                  <div className="mb-2 text-[11.5px] text-missed-fg">
                    {sendError}
                  </div>
                )}
                {completionError && (
                  <div
                    role="alert"
                    className="mb-2 text-[11.5px] text-missed-fg"
                  >
                    {completionError}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void handleDownloadPdf()}
                    disabled={!model || isGeneratingPdf}
                    className="cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isGeneratingPdf ? "Generating…" : "Download PDF"}
                  </button>
                  {view === "awaiting" && (
                    <>
                      <button
                        onClick={openSendDialog}
                        disabled={!model || !selectedContact?.email}
                        title={
                          !selectedContact?.email
                            ? "Choose a recipient with an email address on file first."
                            : undefined
                        }
                        className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Send to client
                      </button>
                      {/* Completed - the manager's own "fully dealt with", whichever way the report reached the client. */}
                      <CompleteButton
                        disabled={completeMutation.isPending || !reportId}
                        onClick={() => {
                          setCompletionError(null);
                          setConfirmingComplete(true);
                        }}
                      />
                    </>
                  )}
                </div>
                {view === "awaiting" && confirmingComplete && reportId && (
                  <CompleteConfirm
                    sentAt={alreadySentAt}
                    pending={completeMutation.isPending}
                    onConfirm={() => completeMutation.mutate(reportId)}
                    onCancel={() => setConfirmingComplete(false)}
                  />
                )}
              </div>
            </div>

            {/* Preview column — capped so it reads like a document, not a stretched panel; scrolls independently so it stays put while the cards above scroll. */}
            <div className="w-full lg:h-full lg:w-[440px] lg:flex-none">
              {/* A soft backdrop behind the preview card so it reads as a page sitting on a surface, not another flat app panel. */}
              <div className="bg-neutral-200 p-4 lg:h-full lg:min-h-0 lg:overflow-y-auto">
                {model && <ClientReportPreview model={model} />}
              </div>
            </div>
          </div>
        )}
      </div>

      {showConfirmDialog && model && selectedContact?.email && (
        <SendConfirmDialog
          model={model}
          contact={selectedContact}
          isSending={isSending}
          alreadySent={
            alreadySentAt
              ? {
                  at: alreadySentAt,
                  to:
                    lastSend?.status === "sent"
                      ? lastSend.recipientEmail
                      : null,
                }
              : null
          }
          message={emailMessage}
          onMessageChange={setEmailMessage}
          onResetMessage={() => setEmailMessage(standardMessage())}
          onCancel={() => (isSending ? null : setShowConfirmDialog(false))}
          onConfirm={() => void handleConfirmSend()}
        />
      )}

      {skippedWarning && (
        <SkippedPhotosDialog
          count={skippedWarning.prepared.skippedCount}
          action={skippedWarning.action}
          onCancel={() => setSkippedWarning(null)}
          onContinue={() => void handleContinueDespiteSkipped()}
        />
      )}
    </div>
  );
}
