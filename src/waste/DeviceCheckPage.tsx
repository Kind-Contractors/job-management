import { useState } from 'react';
import { Link } from 'react-router-dom';
import { runDeviceCheck, submitBlockedReason, verdictOf, type DeviceCheckReport } from './deviceCheck';
import { submitDeviceCheck } from './wasteApi';

type Phase = { step: 'intro' } | { step: 'running' } | { step: 'done'; report: DeviceCheckReport } | { step: 'sending'; report: DeviceCheckReport } | { step: 'sent'; report: DeviceCheckReport; reference: string } | { step: 'error'; report: DeviceCheckReport | null; message: string };

const yesNo = (v: boolean | null | undefined) => (v == null ? '–' : v ? 'yes' : 'no');
const mb = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n / 1048576)} MB`);

/** The facts shown before sending: exactly the report that would be sent, in plain rows. */
export function DeviceCheckSummary({ report }: { report: DeviceCheckReport }) {
  const b = report.indexedDb.blob;
  const est = typeof report.storage.estimate === 'object' ? report.storage.estimate : null;
  const rows: [string, string][] = [
    ['Device', `${report.device.category}${report.device.iosVersionReported ? ` · iOS ${report.device.iosVersionReported} (as reported)` : ''}`],
    ['Browser', `${report.browser.name}${report.browser.version ? ` ${report.browser.version}` : ''} · ${report.browser.displayMode}`],
    ['Screen', `${report.device.screen.width ?? '–'} × ${report.device.screen.height ?? '–'} · ${report.device.devicePixelRatio ?? '–'}x · touch ${report.device.touchPoints ?? '–'}`],
    ['Storage', est ? `${mb(est.usageBytes)} used of ${mb(est.quotaBytes)}` : String(report.storage.estimate)],
    ['Kept permanently', String(report.storage.persisted)],
    ['Storage opened', yesNo(report.indexedDb.open.ok)],
    ['Simple record saved and read', `${yesNo(report.indexedDb.plainObject.ok && report.indexedDb.plainObject.readBack)}`],
    ['Test file saved', `${yesNo(b.ok)} (${b.transaction}${b.error ? ` · ${b.error.name ?? ''}: ${b.error.message ?? ''}` : ''})`],
    ['Test file read back intact', b.readBack ? `${yesNo(b.bytesMatch)} (${b.bytes} bytes${b.hashMatches != null ? `, fingerprint ${b.hashMatches ? 'matches' : 'differs'}` : ''})` : '–'],
    ['Test records removed', yesNo(report.indexedDb.cleanup.ok)],
    ['Last photo/video save problem', report.lastMediaSaveError ? `${report.lastMediaSaveError.kind}: ${report.lastMediaSaveError.name ?? ''} ${report.lastMediaSaveError.message ?? ''}` : 'none this visit'],
    ['App version', `${report.appVersion} (${report.environment})`],
  ];
  return (
    <dl data-testid="device-check-summary" className="divide-y divide-divider border border-divider text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3 px-3 py-1.5">
          <dt className="w-[42%] shrink-0 text-neutral-500">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function DeviceCheckPage() {
  const [phase, setPhase] = useState<Phase>({ step: 'intro' });
  const [showRaw, setShowRaw] = useState(false);

  const run = async () => {
    setPhase({ step: 'running' });
    try {
      setPhase({ step: 'done', report: await runDeviceCheck() });
    } catch (e) {
      setPhase({ step: 'error', report: null, message: `The check couldn’t run: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const send = async (report: DeviceCheckReport) => {
    const blocked = submitBlockedReason(report.environment, window.location.hostname);
    if (blocked) {
      setPhase({ step: 'error', report, message: blocked });
      return;
    }
    setPhase({ step: 'sending', report });
    try {
      const { id } = await submitDeviceCheck(report);
      setPhase({ step: 'sent', report, reference: id.slice(0, 8) });
    } catch (e) {
      setPhase({ step: 'error', report, message: `It couldn’t be sent: ${e instanceof Error ? e.message : String(e)}. Check the connection and try again.` });
    }
  };

  const report = 'report' in phase ? phase.report : null;
  const verdict = report ? verdictOf(report) : null;
  return (
    <div className="flex flex-col gap-3 px-4 pt-3 pb-8" data-testid="device-check">
      <div>
        <Link to="/waste/reports" className="text-[12px] text-neutral-500 underline">
          Back to My reports
        </Link>
        <h1 className="mt-1 font-heading text-[20px] leading-tight font-semibold text-ink">Device compatibility check</h1>
      </div>
      <p className="text-[12.5px] text-neutral-600">
        Checks whether this phone can keep photos and videos for upload. It saves a small test file (not a photo or video), reads it back
        and removes it. It looks at technical browser and device details only - never your reports, photos, videos or addresses.
        Nothing is sent unless you choose to send it.
      </p>

      {phase.step === 'intro' && (
        <button type="button" onClick={() => void run()} className="cursor-pointer bg-teal px-4 py-2.5 text-[14px] font-semibold text-white">
          Run the check
        </button>
      )}
      {phase.step === 'running' && <p className="text-[13px] text-neutral-500">Checking…</p>}

      {verdict && (
        <p role="status" data-testid="device-check-verdict" className={`border px-3 py-2 text-[13px] ${verdict.ok ? 'border-done bg-done/10 text-done-fg' : 'border-missed bg-missed/10 text-missed-fg'}`}>
          {verdict.text}
        </p>
      )}
      {report && (
        <>
          <p className="text-[12px] text-neutral-500">This is what would be sent:</p>
          <DeviceCheckSummary report={report} />
          <button type="button" onClick={() => setShowRaw((v) => !v)} className="cursor-pointer self-start text-[12px] text-neutral-500 underline">
            {showRaw ? 'Hide the full technical details' : 'Show the full technical details'}
          </button>
          {showRaw && <pre data-testid="device-check-raw" className="max-h-64 overflow-auto bg-neutral-100 p-2 text-[10.5px] whitespace-pre-wrap break-all text-ink">{JSON.stringify(report, null, 2)}</pre>}
        </>
      )}

      {phase.step === 'done' && (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => void send(phase.report)} className="cursor-pointer bg-teal px-4 py-2.5 text-[14px] font-semibold text-white">
            Send to Kind Contractors
          </button>
          <button type="button" onClick={() => void run()} className="cursor-pointer text-[12.5px] text-neutral-600 underline">
            Run the check again
          </button>
        </div>
      )}
      {phase.step === 'sending' && <p className="text-[13px] text-neutral-500">Sending…</p>}
      {phase.step === 'sent' && (
        <p role="status" data-testid="device-check-sent" className="border border-done bg-done/10 px-3 py-2 text-[13px] text-done-fg">
          Sent - thank you. Reference: {phase.reference}
        </p>
      )}
      {phase.step === 'error' && (
        <div className="flex flex-col gap-2">
          <p role="alert" data-testid="device-check-error" className="border border-missed bg-missed/10 px-3 py-2 text-[13px] text-missed-fg">
            {phase.message}
          </p>
          {phase.report && (
            <button type="button" onClick={() => void send(phase.report as DeviceCheckReport)} className="cursor-pointer bg-teal px-4 py-2.5 text-[14px] font-semibold text-white">
              Try sending again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
