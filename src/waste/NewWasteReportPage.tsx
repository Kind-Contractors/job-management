import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WasteDraft, WasteMedia } from './offline/wasteDb';
import {
  addWasteMedia,
  discardWasteDraft,
  getOrCreateEditingDraft,
  listWasteMedia,
  removeWasteMedia,
  requestWasteSubmit,
  retryWasteMedia,
  subscribeWasteQueue,
  updateWasteDraftFields,
  uploadProgress,
} from './offline/wasteSyncEngine';
import { addDays, checkWasteForm, emptySections, emptySectionsQuestion, londonToday, WASTE_LIMITS, WASTE_PHASES, type WasteMediaKind, type WastePhase } from './wasteRules';
import WasteMediaSection from './WasteMediaSection';
import WasteConfirmDialog from './WasteConfirmDialog';

const label = 'mb-1 block font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-600 uppercase';
const input = 'w-full border border-neutral-300 bg-white px-3 py-2.5 text-[15px] text-ink outline-none focus:border-teal';

/**
 * "New report": address, dates, description, Before/After photos and videos, Send. Everything typed or added is kept on the phone
 * as it happens (a closed app or lost signal loses nothing); files start uploading straight away.
 */
export default function NewWasteReportPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<WasteDraft | null>(null);
  const [media, setMedia] = useState<WasteMedia[]>([]);
  const [, setTick] = useState(0);
  const [addErrors, setAddErrors] = useState<Partial<Record<WastePhase, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmEmpty, setConfirmEmpty] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const previews = useRef(new Map<string, string>());

  // Loads (or starts) the draft being written on this phone - once per mount.
  useEffect(() => {
    let cancelled = false;
    getOrCreateEditingDraft()
      .then((d) => {
        if (!cancelled) setDraft(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'This phone’s storage could not be opened.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Follows the upload engine (an external store): this draft's files and their progress.
  const reportId = draft?.reportId ?? null;
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    const refresh = () => {
      void listWasteMedia(reportId).then((list) => {
        if (!cancelled) {
          setMedia(list);
          setTick((t) => t + 1);
        }
      });
    };
    refresh();
    const unsubscribe = subscribeWasteQueue(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [reportId]);

  // Releases the preview images' memory when the page closes.
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const previewUrl = (blob: Blob, key: string): string => {
    const existing = previews.current.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    previews.current.set(key, url);
    return url;
  };

  if (loadError) return <p className="p-4 text-[13px] text-missed-fg">{loadError}</p>;
  if (!draft) return <p className="p-4 text-[13px] text-neutral-500">Loading…</p>;

  const setField = (field: 'address' | 'startDate' | 'endDate' | 'description', value: string) => {
    const next = { ...draft, [field]: value };
    // Picking a start date after the end date moves the end date with it (the usual one-day job).
    if (field === 'startDate' && value && next.endDate < value) next.endDate = value;
    setDraft(next);
    setProblems([]);
    void updateWasteDraftFields(draft.reportId, { address: next.address, startDate: next.startDate, endDate: next.endDate, description: next.description });
  };

  const handleAdd = async (phase: WastePhase, kind: WasteMediaKind, files: File[]) => {
    setAddErrors((e) => ({ ...e, [phase]: undefined }));
    for (const file of files) {
      const result = await addWasteMedia(draft.reportId, phase, kind, file);
      if (!result.ok) {
        setAddErrors((e) => ({ ...e, [phase]: result.message }));
        break;
      }
    }
  };

  const send = async () => {
    await requestWasteSubmit(draft.reportId);
    navigate(`/waste/sent/${draft.reportId}`);
  };

  const handleSend = () => {
    const found = checkWasteForm(draft);
    setProblems(found);
    if (found.length > 0) return;
    const question = emptySectionsQuestion(emptySections(media));
    if (question) setConfirmEmpty(question);
    else void send();
  };

  const today = londonToday();
  const stillUploading = media.some((m) => m.status !== 'ready');

  return (
    <div className="pb-6">
      <div className="px-4 pt-3 pb-1">
        <h1 className="font-heading text-[20px] leading-tight font-semibold text-ink">New waste report</h1>
      </div>

      <div className="flex flex-col gap-3 border-b border-divider px-4 py-3">
        <div>
          <label htmlFor="waste-address" className={label}>
            Job address
          </label>
          <textarea
            id="waste-address"
            rows={2}
            value={draft.address}
            maxLength={WASTE_LIMITS.maxAddressLength}
            onChange={(e) => setField('address', e.target.value)}
            placeholder="Street, town, postcode"
            className={`${input} resize-none`}
            autoComplete="street-address"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="waste-start" className={label}>
              Start date
            </label>
            <input id="waste-start" type="date" value={draft.startDate} max={addDays(today, 1)} onChange={(e) => setField('startDate', e.target.value)} className={input} />
          </div>
          <div>
            <label htmlFor="waste-end" className={label}>
              End date
            </label>
            <input id="waste-end" type="date" value={draft.endDate} min={draft.startDate} max={addDays(today, 1)} onChange={(e) => setField('endDate', e.target.value)} className={input} />
          </div>
        </div>
        <div>
          <label htmlFor="waste-description" className={label}>
            Work carried out / notes
          </label>
          <textarea
            id="waste-description"
            rows={4}
            value={draft.description}
            maxLength={WASTE_LIMITS.maxDescriptionLength}
            onChange={(e) => setField('description', e.target.value)}
            className={`${input} resize-y`}
          />
        </div>
      </div>

      {WASTE_PHASES.map((phase) => (
        <WasteMediaSection
          key={phase}
          phase={phase}
          media={media.filter((m) => m.phase === phase)}
          progressOf={uploadProgress}
          previewUrl={previewUrl}
          locked={false}
          addError={addErrors[phase] ?? null}
          onAdd={(kind, files) => void handleAdd(phase, kind, files)}
          onRemove={(id) => void removeWasteMedia(id).catch((err: unknown) => setAddErrors((e) => ({ ...e, [phase]: err instanceof Error ? err.message : 'Could not remove it.' })))}
          onRetry={(id) => void retryWasteMedia(id)}
        />
      ))}

      <div className="flex flex-col gap-2 px-4 pt-4">
        {problems.length > 0 && (
          <ul role="alert" className="border border-missed bg-missed/10 px-3 py-2 text-[12.5px] text-missed-fg">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {stillUploading && <p className="text-[12px] text-neutral-500">Photos and videos keep uploading after you press Send - you can start another report straight away.</p>}
        <button type="button" onClick={handleSend} className="w-full cursor-pointer bg-teal py-3.5 text-[15px] font-semibold text-white">
          Send report
        </button>
        <button type="button" onClick={() => setConfirmDiscard(true)} className="mx-auto cursor-pointer py-2 text-[12.5px] text-neutral-600 underline">
          Discard this draft
        </button>
      </div>

      {confirmEmpty && (
        <WasteConfirmDialog
          ariaLabel="Send without photos"
          message={confirmEmpty}
          confirmLabel="Send anyway"
          onCancel={() => setConfirmEmpty(null)}
          onConfirm={() => {
            setConfirmEmpty(null);
            void send();
          }}
        />
      )}
      {confirmDiscard && (
        <WasteConfirmDialog
          ariaLabel="Discard draft"
          message="Throw this draft away, with its photos and videos? This can’t be undone."
          confirmLabel="Discard"
          destructive
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            void discardWasteDraft(draft.reportId).then(async () => {
              setMedia([]);
              setDraft(await getOrCreateEditingDraft());
            });
          }}
        />
      )}
    </div>
  );
}
