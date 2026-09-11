import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { JobRow, JobVisitSummary } from '../domain/types';
import { listJobRows } from '../repository/jobsRepository';
import {
  getLatestClientSend,
  getReport,
  listPhotosForReport,
  sendClientReport,
  signReportPhotoUrls,
  updatePhotoClientInclusion,
  updateReport,
  type ReportPhoto,
} from '../repository/reportsRepository';
import { isReportReadyForClient } from '../lib/statusPresentation';
import { resolveDisplayContact } from '../lib/contactDisplay';
import { buildClientReportModel, type ClientReportModel } from '../lib/clientReportModel';
import { generateClientReportPdf } from '../lib/clientReportPdf';
import type { JobContactSummary } from '../domain/types';

/** Strips the `data:...;base64,` prefix a data URL carries — the email provider wants raw base64 content, not a data URL. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the generated PDF.'));
    reader.readAsDataURL(blob);
  });
}

interface SendConfirmDialogProps {
  model: ClientReportModel;
  contact: JobContactSummary;
  isSending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** A confirmation step between clicking "Send to client" and anything actually happening — reuses ContactPopover.tsx's exact overlay pattern (the one modal precedent in this app). */
function SendConfirmDialog({ model, contact, isSending, onCancel, onConfirm }: SendConfirmDialogProps) {
  const sectionsIncluded: string[] = ['Work carried out'];
  if (model.notes) sectionsIncluded.push('Notes');
  if (model.issues) sectionsIncluded.push('Issues');
  if (model.photos.length > 0) sectionsIncluded.push(`Photos (${model.photos.length})`);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-[420px] overflow-y-auto border border-neutral-300 bg-white p-4"
      >
        <div className="border-b border-divider pb-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Confirm send</div>
          <h2 className="mt-1 font-heading text-lg font-semibold">{model.buildingName}</h2>
          <div className="text-[12.5px] text-neutral-600">
            {model.clientName} · {model.jobSummary} · {model.visitDateLabel}
          </div>
        </div>

        <div className="mt-3 text-[12.5px] text-ink">
          Sending to <span className="font-semibold">{contact.name}</span> ({contact.email})
        </div>

        <div className="mt-2.5">
          <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">Included</div>
          <ul className="mt-1 list-inside list-disc text-[12.5px] text-ink">
            {sectionsIncluded.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>

        <div className="mt-3.5 flex gap-1.5">
          <button
            onClick={onConfirm}
            disabled={isSending}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSending ? 'Sending…' : 'Confirm and send'}
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

interface ClientReportRow {
  job: JobRow;
  visit: JobVisitSummary;
}

const PHASE_LABEL: Record<ReportPhoto['phase'], string> = { before: 'Before', during: 'During', after: 'After' };

/**
 * Styled to read as a physical page sitting on the workspace (letterhead
 * accent bar, shadow, generous margin) rather than another app panel — the
 * surrounding wrapper in the main return gives it a soft backdrop to sit
 * on. Purely presentational: the content model/fields are unchanged from
 * before, so this still shows exactly what generateClientReportPdf() puts
 * in the real attachment, nothing more.
 */
function ClientReportPreview({ model }: { model: ClientReportModel }) {
  return (
    <div className="mx-auto max-w-[380px] border border-neutral-200 bg-white shadow-md">
      <div className="h-1.5 bg-teal" />
      <div className="p-6">
        <div className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
          Client-facing preview
        </div>
        <h3 className="mt-1.5 font-heading text-lg font-semibold">{model.buildingName}</h3>
        <div className="text-[12.5px] text-neutral-600">
          {model.clientName} · {model.jobSummary} · {model.visitDateLabel}
        </div>

        {model.workCarriedOut && (
          <div className="mt-4">
            <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">
              Work carried out
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{model.workCarriedOut}</div>
          </div>
        )}

        <div className="mt-4 text-[12.5px] text-ink">
          {model.specMet ? 'Specification completed as agreed.' : 'Part of the specification was not fully completed.'}
        </div>

        {model.notes && (
          <div className="mt-4">
            <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Notes</div>
            <div className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{model.notes}</div>
          </div>
        )}

        {model.issues && (
          <div className="mt-4">
            <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Issues flagged</div>
            <div className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{model.issues}</div>
          </div>
        )}

        {model.photos.length > 0 && (
          <div className="mt-4">
            <div className="font-heading text-[10px] font-semibold tracking-[0.1em] text-neutral-500 uppercase">Photos</div>
            <div className="mt-1 flex flex-col gap-2">
              {(['before', 'during', 'after'] as const).map((phase) => {
                const phasePhotos = model.photos.filter((p) => p.phase === phase);
                if (phasePhotos.length === 0) return null;
                return (
                  <div key={phase}>
                    <div className="mb-1 text-[10.5px] text-neutral-500 uppercase">{PHASE_LABEL[phase]}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {phasePhotos.map((p) => (
                        <img key={p.id} src={p.url} alt="" className="h-16 w-16 border border-neutral-300 object-cover" />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
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
export default function ReadyForClientPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const { data: jobRows = [], isLoading, isError, error } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const rows = useMemo<ClientReportRow[]>(() => {
    const list: ClientReportRow[] = [];
    for (const job of jobRows) {
      for (const visit of job.visits) {
        if (isReportReadyForClient(visit)) list.push({ job, visit });
      }
    }
    return list.sort((a, b) => (a.visit.scheduledDate ?? '').localeCompare(b.visit.scheduledDate ?? ''));
  }, [jobRows]);

  const selected = rows.find((r) => r.visit.id === selectedVisitId);
  const reportId = selected?.visit.reportId ?? null;

  const {
    data: report,
    isLoading: reportIsLoading,
    isError: reportIsError,
    error: reportError,
    refetch: refetchReport,
  } = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => getReport(reportId!),
    enabled: !!reportId,
  });
  const {
    data: photos = [],
    isError: photosIsError,
    error: photosError,
    refetch: refetchPhotos,
  } = useQuery({
    queryKey: ['reportPhotos', reportId],
    queryFn: () => listPhotosForReport(reportId!),
    enabled: !!reportId,
  });
  const {
    data: photoUrls = {},
    isError: photoUrlsIsError,
    refetch: refetchPhotoUrls,
  } = useQuery({
    queryKey: ['reportPhotoUrls', reportId, photos.map((p) => p.id).join(',')],
    queryFn: () => signReportPhotoUrls(photos),
    enabled: photos.length > 0,
  });
  const {
    data: lastSend,
    isError: lastSendIsError,
    refetch: refetchLastSend,
  } = useQuery({
    queryKey: ['clientSend', reportId],
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
    setSelectedContactId(resolved.kind === 'single' || resolved.kind === 'primary' ? resolved.contact.id : null);
  }, [selected]);

  const selectRow = (row: ClientReportRow) => {
    setSelectedVisitId(row.visit.id);
    setSaveError(null);
    setSendError(null);
    setShowConfirmDialog(false);
  };

  const invalidateReport = () => {
    queryClient.invalidateQueries({ queryKey: ['report', reportId] });
    queryClient.invalidateQueries({ queryKey: ['jobRows'] });
  };

  const toggleSectionMutation = useMutation({
    mutationFn: (patch: Parameters<typeof updateReport>[1]) => updateReport(reportId!, patch),
    onSuccess: () => {
      invalidateReport();
      setSaveError(null);
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : 'Failed to save selection.'),
  });

  const togglePhotoMutation = useMutation({
    mutationFn: ({ photoId, included }: { photoId: string; included: boolean }) => updatePhotoClientInclusion(photoId, included),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reportPhotos', reportId] });
      setSaveError(null);
    },
    onError: (err) => setSaveError(err instanceof Error ? err.message : 'Failed to save photo selection.'),
  });

  const selectedContact = selected?.job.clientContacts.find((c) => c.id === selectedContactId) ?? null;
  const model = selected && report ? buildClientReportModel(selected.job, selected.visit, report, photos, photoUrls) : null;

  /**
   * Downloads a PDF built from the exact same `model` the on-screen
   * preview renders — never a separate re-fetch/re-selection, so the PDF
   * can never show something the preview doesn't. Purely a local browser
   * download (Blob URL + a throwaway <a download>); nothing is uploaded,
   * emailed, or recorded as sent — sent_to_client_at is never touched here.
   */
  const handleDownloadPdf = async () => {
    if (!model) return;
    setPdfError(null);
    setIsGeneratingPdf(true);
    try {
      const blob = await generateClientReportPdf(model);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${model.buildingName.replace(/[^a-z0-9]+/gi, '-')}-report.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Failed to generate PDF.');
    } finally {
      setIsGeneratingPdf(false);
    }
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
  const handleConfirmSend = async () => {
    if (!model || !selected || !reportId || !selectedContact?.email) return;
    setIsSending(true);
    setSendError(null);
    try {
      const blob = await generateClientReportPdf(model);
      const pdfBase64 = await blobToBase64(blob);
      const result = await sendClientReport({ reportId, contactId: selectedContact.id, pdfBase64 });
      queryClient.invalidateQueries({ queryKey: ['clientSend', reportId] });
      if (result.status === 'sent') {
        setShowConfirmDialog(false);
        queryClient.invalidateQueries({ queryKey: ['jobRows'] });
      } else {
        setSendError(result.error ?? 'Failed to send.');
      }
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send.');
      queryClient.invalidateQueries({ queryKey: ['clientSend', reportId] });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[320px] flex-none flex-col border-r border-divider bg-white">
        <div className="flex-none border-b border-divider px-3.5 py-3">
          <h1 className="font-heading text-lg font-semibold">Ready for client</h1>
          <div className="mt-0.5 text-xs text-neutral-600 tabular-nums">{rows.length} awaiting send</div>
        </div>

        {isLoading ? (
          <div className="p-3.5">
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading…</div>
          </div>
        ) : isError ? (
          <div className="p-3.5">
            <div className="border border-missed bg-missed/10 p-3">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
                Couldn't load reports
              </div>
              <div className="mt-1.5 text-[12.5px] text-ink">{error instanceof Error ? error.message : 'Something went wrong.'}</div>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-5 text-center">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
              No approved reports are waiting to be sent to a client.
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {rows.map((row) => {
              const isSelected = row.visit.id === selectedVisitId;
              const dateLabel = row.visit.scheduledDate ? new Date(row.visit.scheduledDate).toLocaleDateString('en-GB') : 'No date set';
              return (
                <div
                  key={row.visit.id}
                  onClick={() => selectRow(row)}
                  className={`cursor-pointer border-b border-divider px-3.5 py-2.5 ${isSelected ? 'bg-teal-100' : 'hover:bg-neutral-100'}`}
                >
                  <div className="text-[12.5px] font-semibold text-ink">{row.job.buildingName}</div>
                  <div className="text-[11.5px] text-neutral-600">
                    {row.job.clientName} · {row.job.jobSummary}
                  </div>
                  <div className="mt-0.5 text-[11px] text-neutral-500 tabular-nums">
                    Visit {dateLabel}
                    {row.visit.technicianName ? ` · ${row.visit.technicianName}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:overflow-visible">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-5 text-center">
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
                {reportError instanceof Error ? reportError.message : 'Something went wrong.'}
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
            <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">Loading report…</div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-5 lg:h-full lg:flex-row lg:items-start">
            {/* Preparation column — cards scroll internally on desktop; Download/Send stay pinned below them. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:h-full lg:min-h-0">
              <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-0.5">
                <div className="pb-3">
                  <h2 className="font-heading text-xl font-semibold">{selected.job.buildingName}</h2>
                  <div className="mt-0.5 text-[13px] text-neutral-600">
                    {selected.job.clientName} · {selected.job.jobSummary}
                    {selected.visit.scheduledDate && ` · Visit ${new Date(selected.visit.scheduledDate).toLocaleDateString('en-GB')}`}
                    {selected.visit.technicianName && ` · ${selected.visit.technicianName}`}
                  </div>
                  <button
                    onClick={() => navigate(`/buildings/${selected.job.buildingId}`)}
                    className="mt-1.5 cursor-pointer text-[11.5px] text-teal-700 hover:underline"
                  >
                    Open building file
                  </button>
                </div>

                {/* Read-only reference — plain gray fields, no interactive controls, so it never reads like an editable section. */}
                <section className="border border-neutral-300 bg-white p-3">
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                    Report details
                  </div>
                  <div className="mt-1.5 flex flex-col gap-2">
                    <div className="text-[11px] text-neutral-500">
                      {report.specMet ? 'Specification: Completed' : 'Specification: Not fully completed'}
                    </div>
                    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                      Work carried out
                      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink">
                        {report.workCarriedOut || '—'}
                      </div>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                      Notes
                      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink">
                        {report.technicianNotes || '—'}
                      </div>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-neutral-600">
                      Issues
                      <div className="border border-neutral-300 bg-neutral-100 px-2 py-1.5 text-[13px] whitespace-pre-wrap text-ink">
                        {report.issues || '—'}
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
                        onChange={(e) => toggleSectionMutation.mutate({ includeNotes: e.target.checked })}
                      />
                      Include notes
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={report.includeIssues}
                        onChange={(e) => toggleSectionMutation.mutate({ includeIssues: e.target.checked })}
                      />
                      Include issues
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={report.includePhotos}
                        onChange={(e) => toggleSectionMutation.mutate({ includePhotos: e.target.checked })}
                      />
                      Include photos
                    </label>
                  </div>
                  {saveError && <div className="mt-1.5 text-[11.5px] text-missed-fg">{saveError}</div>}

                  {report.includePhotos && (
                    <div className="mt-3 border-t border-divider pt-3">
                      <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                        Photos — select which to include
                      </div>
                      {photosIsError ? (
                        <div className="mt-1.5 border border-missed bg-missed/10 p-2.5 text-[12px] text-missed-fg">
                          Couldn't load this report's photos
                          {photosError instanceof Error ? `: ${photosError.message}` : '.'}
                          <button onClick={() => void refetchPhotos()} className="ml-2 cursor-pointer underline">
                            Try again
                          </button>
                        </div>
                      ) : (
                        photoUrlsIsError && (
                          <div className="mt-1.5 border border-missed bg-missed/10 p-2.5 text-[12px] text-missed-fg">
                            Couldn't load photo previews.
                            <button onClick={() => void refetchPhotoUrls()} className="ml-2 cursor-pointer underline">
                              Try again
                            </button>
                          </div>
                        )
                      )}
                      {/* Phases sit side by side (not stacked) so each column's thumbnails can be
                          larger — three narrow wrapped rows wasted most of the card's width before. */}
                      <div className="mt-1.5 grid grid-cols-3 gap-3">
                        {(['before', 'during', 'after'] as const).map((phase) => {
                          const phasePhotos = photos.filter((p) => p.phase === phase);
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
                                    title={p.includeInClientReport ? 'Included — click to exclude' : 'Excluded — click to include'}
                                  >
                                    {photoUrls[p.id] && (
                                      <img
                                        src={photoUrls[p.id]}
                                        alt=""
                                        className={`h-20 w-20 border object-cover ${p.includeInClientReport ? 'border-teal' : 'border-neutral-300 opacity-40'}`}
                                      />
                                    )}
                                    {/* Real checkbox, just repositioned as a corner overlay — same mutation, same keyboard/tab behavior, no separate "Include" label row taking up vertical space. */}
                                    <input
                                      type="checkbox"
                                      checked={p.includeInClientReport}
                                      onChange={(e) => togglePhotoMutation.mutate({ photoId: p.id, included: e.target.checked })}
                                      aria-label={p.includeInClientReport ? 'Included in client report' : 'Not included in client report'}
                                      className="absolute top-0.5 right-0.5 h-3.5 w-3.5 cursor-pointer accent-teal"
                                    />
                                  </label>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </section>

                <section className="mt-3 border border-neutral-300 bg-white p-3">
                  <div className="font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">Recipient</div>
                  {selected.job.clientContacts.length === 0 ? (
                    <div className="mt-1.5 text-[12.5px] text-due-fg">
                      This client has no contact on file — add one before this report can be sent (All Live Jobs' Contact column).
                    </div>
                  ) : (
                    <>
                      <select
                        value={selectedContactId ?? ''}
                        onChange={(e) => setSelectedContactId(e.target.value || null)}
                        className="mt-1.5 border border-neutral-300 px-2 py-1 text-[12.5px] text-ink outline-none focus:border-teal"
                      >
                        <option value="">Choose a recipient…</option>
                        {selected.job.clientContacts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.email ? ` · ${c.email}` : ' · no email on file'}
                          </option>
                        ))}
                      </select>
                      {selectedContact ? (
                        <div className="mt-1.5 text-[12.5px] text-ink">
                          Sending to <span className="font-semibold">{selectedContact.name}</span>
                          {selectedContact.email ? ` (${selectedContact.email})` : ' — no email on file for this contact.'}
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[11.5px] text-due-fg">
                          Multiple contacts exist for this client — choose one before sending.
                        </div>
                      )}
                    </>
                  )}
                  {lastSendIsError ? (
                    <div className="mt-1.5 text-[11.5px] text-missed-fg">
                      Couldn't check this report's send history.
                      <button onClick={() => void refetchLastSend()} className="ml-1.5 cursor-pointer underline">
                        Try again
                      </button>
                    </div>
                  ) : (
                    lastSend && (
                      <div className={`mt-1.5 text-[11.5px] ${lastSend.status === 'failed' ? 'text-missed-fg' : 'text-neutral-500'}`}>
                        {lastSend.status === 'sent'
                          ? `Sent to ${lastSend.recipientEmail} on ${new Date(lastSend.createdAt).toLocaleString('en-GB')}.`
                          : lastSend.status === 'failed'
                            ? `Last attempt failed (${new Date(lastSend.createdAt).toLocaleString('en-GB')}): ${lastSend.errorMessage ?? 'Unknown error.'}`
                            : 'A send is currently in progress…'}
                      </div>
                    )
                  )}
                </section>
              </div>

              {/* Persistent — never scrolls away with the cards above it on desktop. */}
              <div className="flex-none border-t border-divider pt-3 pb-0.5">
                {pdfError && <div className="mb-2 text-[11.5px] text-missed-fg">{pdfError}</div>}
                {sendError && <div className="mb-2 text-[11.5px] text-missed-fg">{sendError}</div>}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void handleDownloadPdf()}
                    disabled={!model || isGeneratingPdf}
                    className="cursor-pointer border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isGeneratingPdf ? 'Generating…' : 'Download PDF'}
                  </button>
                  <button
                    onClick={() => setShowConfirmDialog(true)}
                    disabled={!model || !selectedContact?.email}
                    title={!selectedContact?.email ? 'Choose a recipient with an email address on file first.' : undefined}
                    className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Send to client
                  </button>
                </div>
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
          onCancel={() => (isSending ? null : setShowConfirmDialog(false))}
          onConfirm={() => void handleConfirmSend()}
        />
      )}
    </div>
  );
}
