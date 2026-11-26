import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAutoInvoiceEmailSetting } from '../../repository/appSettingsRepository';
import { AUTO_INVOICE_EMAIL_QUERY_KEY } from '../settings/AutoInvoiceEmailSetting';

/**
 * Ready for accounts header: a compact "Invoice emails: On / Off" pill that opens the existing Automatic Invoice Emails setting
 * (passed in as children, unchanged) in a small panel. The pill only READS the same cached setting for its label; changing it
 * still happens inside the setting itself (confirmation first, saved only on confirm). The panel stays mounted while closed, so
 * a confirmation in progress is not lost by closing it.
 */
export default function InvoiceEmailsPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const setting = useQuery({ queryKey: AUTO_INVOICE_EMAIL_QUERY_KEY, queryFn: getAutoInvoiceEmailSetting });
  const label = setting.isLoading ? '…' : setting.isError ? 'Unknown' : setting.data?.enabled ? 'On' : 'Off';

  // Closing on a press elsewhere on the page needs a document listener - a real subscription, so an effect, only while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="invoice-emails-toggle"
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-neutral-300 bg-white px-3 text-[12px] whitespace-nowrap text-neutral-700 hover:bg-neutral-100"
      >
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </svg>
        Invoice emails:{' '}
        <strong className={setting.data?.enabled ? 'text-teal-700' : 'text-due-fg'} data-testid="invoice-emails-state">
          {label}
        </strong>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-10 z-30 w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg shadow-lg"
        data-testid="invoice-emails-panel"
      >
        {children}
      </div>
    </div>
  );
}
