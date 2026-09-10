import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearchParams, useNavigate } from 'react-router-dom';
import type { IconType } from 'react-icons';
import {
  HiOutlineBanknotes,
  HiOutlineBriefcase,
  HiOutlineBuildingOffice2,
  HiOutlineCalendarDays,
  HiOutlineClipboardDocumentCheck,
  HiOutlineClock,
  HiOutlineDocumentText,
  HiOutlineExclamationTriangle,
  HiOutlinePhoto,
  HiOutlineTableCells,
  HiOutlineUsers,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import { listJobRows } from '../../repository/jobsRepository';
import { listBuildingRows } from '../../repository/buildingsRepository';
import { listTechnicians } from '../../repository/techniciansRepository';
import { listUsers } from '../../repository/usersRepository';
import { isVisitReadyForAccounts } from '../../lib/statusPresentation';

type AttentionKey = 'review' | 'needs_booking' | 'overdue' | 'missed';

const ATTENTION_ITEMS: { key: AttentionKey; label: string; icon: IconType; dotClass: string }[] = [
  { key: 'review', label: 'Reports to review', icon: HiOutlineDocumentText, dotClass: 'bg-teal-700' },
  { key: 'needs_booking', label: 'Due, not scheduled', icon: HiOutlineClock, dotClass: 'bg-due' },
  { key: 'overdue', label: 'Overdue', icon: HiOutlineExclamationTriangle, dotClass: 'bg-missed' },
  { key: 'missed', label: 'Missed visits', icon: HiOutlineXCircle, dotClass: 'bg-missed' },
];

const DIVISIONS = ['General', 'Specialist', 'Both'] as const;

/**
 * The one nav-row renderer, shared by every clickable "Needs you today" and
 * "Views of the same data" row — expanded shows the existing label+count
 * layout exactly unchanged; collapsed swaps it for a real icon (react-icons,
 * Heroicons outline set — the previous pass used 2-letter monograms here,
 * replaced per feedback) plus the count, with the full label always
 * available as a native title tooltip. Active-state highlighting and click
 * behavior are identical in both states.
 */
function NavItem({
  active,
  onClick,
  dotClass,
  icon: Icon,
  label,
  count,
  collapsed,
}: {
  active: boolean;
  onClick: () => void;
  dotClass?: string;
  icon: IconType;
  label: string;
  count: number;
  collapsed: boolean;
}) {
  if (collapsed) {
    return (
      <div
        onClick={onClick}
        title={`${label} — ${count}`}
        className={[
          'flex cursor-pointer flex-col items-center gap-0.5 border-l-2 py-2 hover:bg-neutral-200',
          active ? 'border-ink bg-neutral-200' : 'border-transparent',
        ].join(' ')}
      >
        <span className="relative flex h-6 w-6 items-center justify-center text-neutral-700">
          <Icon size={16} />
          {dotClass && <i className={`absolute -top-1 -right-1 block h-1.5 w-1.5 flex-none ${dotClass}`} />}
        </span>
        <span className="font-body text-[9px] text-neutral-500 tabular-nums">{count}</span>
      </div>
    );
  }

  return (
    <div onClick={onClick} title={label} className={navLinkClasses(active)}>
      {dotClass && <i className={`block h-[7px] w-[7px] flex-none ${dotClass}`} />}
      {label}
      <b className="ml-auto font-body text-xs tabular-nums">{count}</b>
    </div>
  );
}

function navLinkClasses(active: boolean) {
  return [
    'flex items-center gap-2.5 px-4 py-1.5 text-[13px] border-l-2 cursor-pointer hover:bg-neutral-200',
    active ? 'border-ink bg-neutral-200 font-semibold' : 'border-transparent font-normal',
  ].join(' ');
}

export default function NavRail() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  const { data: jobRows = [] } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });
  const { data: buildingRows = [] } = useQuery({ queryKey: ['buildingRows'], queryFn: listBuildingRows });
  const { data: technicians = [] } = useQuery({ queryKey: ['technicians'], queryFn: listTechnicians });
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: listUsers });

  const status = searchParams.get('status');
  const division = searchParams.get('division') ?? 'Both';
  const onJobs = pathname === '/jobs';
  const onBuildings = pathname.startsWith('/buildings');
  const onThisWeek = pathname === '/this-week';
  const onMonthMatrix = pathname === '/month-matrix';
  const onReportReview = pathname === '/report-review';
  const onUsers = pathname === '/users';

  const divisionFiltered = jobRows.filter((j) => division === 'Both' || j.division === division);

  const counts: Record<AttentionKey, number> = {
    review: divisionFiltered.filter((j) => j.status === 'review').length,
    // 'needs_booking' (a schedule says due this month, no visit yet) and
    // 'unscheduled' (no visit history at all, whether or not a schedule
    // exists) both represent "this job needs a booking from the manager" —
    // see mapJobRow.ts's deriveVisitState. Counting only 'needs_booking'
    // would miss the majority of real jobs today (no schedule row at all).
    needs_booking: divisionFiltered.filter((j) => j.status === 'needs_booking' || j.status === 'unscheduled').length,
    overdue: divisionFiltered.filter((j) => j.status === 'overdue').length,
    missed: divisionFiltered.filter((j) => j.status === 'missed').length,
  };

  // A report being "ready for accounts" is a per-visit condition (approved,
  // not yet sent to accounts), not a job-level status — a job can have this
  // sitting on an old visit while its overall status is anything. Counted
  // directly rather than via `job.status`, using the one shared predicate
  // (isVisitReadyForAccounts) also used by AllLiveJobsPage's filter and
  // VisitRow's inline badge.
  const readyForAccountsCount = divisionFiltered.reduce(
    (n, j) => n + j.visits.filter(isVisitReadyForAccounts).length,
    0,
  );
  const readyForAccounts = searchParams.get('readyForAccounts') === '1';

  const goToReadyForAccounts = () => {
    const next = new URLSearchParams(searchParams);
    next.set('readyForAccounts', '1');
    next.delete('status');
    next.delete('group');
    navigate(`/jobs?${next.toString()}`);
  };

  const goToFilteredJobs = (key: AttentionKey) => {
    const next = new URLSearchParams(searchParams);
    next.set('status', key);
    next.delete('readyForAccounts');
    next.delete('group');
    navigate(`/jobs?${next.toString()}`);
  };

  const goToView = (nextGroup: 'client' | 'frequency') => {
    const next = new URLSearchParams(searchParams);
    next.delete('status');
    next.delete('readyForAccounts');
    if (nextGroup === 'frequency') next.set('group', 'frequency');
    else next.delete('group');
    navigate(`/jobs?${next.toString()}`);
  };

  const setDivision = (d: (typeof DIVISIONS)[number]) => {
    const next = new URLSearchParams(searchParams);
    if (d === 'Both') next.delete('division');
    else next.set('division', d);
    setSearchParams(next, { replace: true });
  };

  const viewItems: { key: string; label: string; icon: IconType; active: boolean; count: number; onClick: () => void }[] = [
    { key: 'jobs', label: 'All live jobs', icon: HiOutlineBriefcase, active: onJobs && !status, count: divisionFiltered.length, onClick: () => goToView('client') },
    { key: 'buildings', label: 'Buildings', icon: HiOutlineBuildingOffice2, active: onBuildings, count: buildingRows.length, onClick: () => navigate('/buildings') },
    { key: 'schedule', label: 'Schedule', icon: HiOutlineCalendarDays, active: onThisWeek, count: technicians.length, onClick: () => navigate('/this-week') },
    { key: 'matrix', label: 'Month matrix', icon: HiOutlineTableCells, active: onMonthMatrix, count: divisionFiltered.length, onClick: () => navigate('/month-matrix') },
    { key: 'reviews', label: 'Report review', icon: HiOutlineClipboardDocumentCheck, active: onReportReview, count: counts.review, onClick: () => navigate('/report-review') },
    { key: 'users', label: 'Users', icon: HiOutlineUsers, active: onUsers, count: users.filter((u) => u.isActive).length, onClick: () => navigate('/users') },
  ];

  return (
    <nav
      className={`flex flex-none flex-col overflow-y-auto border-r border-divider bg-neutral-100 py-4 transition-[width] duration-200 ${
        collapsed ? 'w-14' : 'w-[236px]'
      }`}
    >
      <div className={`flex items-center pb-2 ${collapsed ? 'justify-center px-2' : 'justify-between px-4'}`}>
        {!collapsed && (
          <span className="font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Needs you · today</span>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className="cursor-pointer border border-neutral-300 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-200"
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      {ATTENTION_ITEMS.map((item) => (
        <NavItem
          key={item.key}
          active={onJobs && status === item.key}
          onClick={() => goToFilteredJobs(item.key)}
          dotClass={item.dotClass}
          icon={item.icon}
          label={item.label}
          count={counts[item.key]}
          collapsed={collapsed}
        />
      ))}
      <NavItem
        active={onJobs && readyForAccounts}
        onClick={goToReadyForAccounts}
        dotClass="bg-teal"
        icon={HiOutlineBanknotes}
        label="Ready for accounts"
        count={readyForAccountsCount}
        collapsed={collapsed}
      />
      <div
        title="Photos uploading — not built yet, no photo-upload mechanism exists in this pass"
        className={
          collapsed
            ? 'flex cursor-default flex-col items-center gap-0.5 border-l-2 border-transparent py-2'
            : 'flex cursor-default items-center gap-2.5 border-l-2 border-transparent px-4 py-1.5 text-[13px] text-neutral-500'
        }
      >
        {collapsed ? (
          <span className="flex h-6 w-6 items-center justify-center text-neutral-400">
            <HiOutlinePhoto size={16} />
          </span>
        ) : (
          <>
            <i className="block h-[7px] w-[7px] flex-none bg-neutral-300" />
            Photos uploading
            <b className="ml-auto font-body text-xs text-neutral-400">—</b>
          </>
        )}
      </div>

      <div className="mx-4 my-4 h-px bg-divider" />

      {!collapsed && (
        <div className="px-4 pb-2 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">
          Views of the same data
        </div>
      )}
      {viewItems.map((item) => (
        <NavItem
          key={item.key}
          active={item.active}
          onClick={item.onClick}
          icon={item.icon}
          label={item.label}
          count={item.count}
          collapsed={collapsed}
        />
      ))}

      <div className={`mt-auto pt-4 pb-2 ${collapsed ? 'px-2' : 'px-4'}`}>
        {!collapsed && (
          <div className="mb-1.5 font-heading text-[10px] font-semibold tracking-[0.16em] text-neutral-600 uppercase">Division</div>
        )}
        <div className={collapsed ? 'flex flex-col gap-1' : 'grid grid-cols-3 border border-neutral-300'}>
          {DIVISIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDivision(d)}
              title={`Division: ${d}`}
              className={
                collapsed
                  ? `cursor-pointer border border-neutral-300 py-1 text-center text-[10px] font-semibold uppercase ${
                      division === d ? 'bg-teal text-white' : 'text-neutral-700 hover:bg-neutral-200'
                    }`
                  : [
                      'cursor-pointer border-l border-neutral-300 py-1 text-center text-[11.5px] first:border-l-0',
                      division === d ? 'bg-teal font-semibold text-white' : 'font-normal text-neutral-700',
                    ].join(' ')
              }
            >
              {collapsed ? d.slice(0, 1) : d}
            </button>
          ))}
        </div>
        {!collapsed && (
          <div className="mt-3 text-[11.5px] leading-normal text-neutral-600">
            One master record per job. Every view above reads the same row.
          </div>
        )}
      </div>
    </nav>
  );
}
