import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createTeam, listTeams, listVisitsForWeek, setTeamActive } from '../repository/teamsRepository';
import { listJobRows } from '../repository/jobsRepository';
import type { WeekVisit } from '../domain/types';

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const DAY_NUM = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const RANGE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const VISIT_STATUS_STYLE: Record<WeekVisit['status'], string> = {
  due: 'border-neutral-400 bg-neutral-200 text-neutral-700',
  booked: 'border-teal bg-teal-100 text-teal-700',
  completed: 'border-teal-700 bg-teal-700 text-white',
  missed: 'border-missed bg-missed/10 text-missed-fg',
  cancelled: 'border-neutral-300 bg-neutral-100 text-neutral-400 line-through',
};

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday–Saturday of the week `weekOffset` weeks from the current real week — the design's "6 working days". Never derived from job frequency. */
function workWeek(weekOffset: number): Date[] {
  const today = new Date();
  const day = today.getDay(); // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset + weekOffset * 7);
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export default function ThisWeekPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [newTeamName, setNewTeamName] = useState('');

  const queryClient = useQueryClient();
  const days = useMemo(() => workWeek(weekOffset), [weekOffset]);
  const startDate = toISODate(days[0]);
  const endDate = toISODate(days[days.length - 1]);

  const {
    data: teams = [],
    isLoading: teamsLoading,
    isError: teamsError,
    error: teamsErrorObj,
  } = useQuery({ queryKey: ['teams'], queryFn: listTeams });
  const { data: visits = [], isLoading: visitsLoading } = useQuery({
    queryKey: ['weekVisits', startDate, endDate],
    queryFn: () => listVisitsForWeek(startDate, endDate),
  });
  const { data: jobRows = [] } = useQuery({ queryKey: ['jobRows'], queryFn: listJobRows });

  const createTeamMutation = useMutation({
    mutationFn: (name: string) => createTeam(name),
    onSuccess: () => {
      setNewTeamName('');
      queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => setTeamActive(id, isActive),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams'] }),
  });

  const jobById = useMemo(() => new Map(jobRows.map((j) => [j.id, j])), [jobRows]);

  const isLoading = teamsLoading || visitsLoading;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-end gap-3.5 px-5 pt-4 pb-3">
        <div>
          <h1 className="font-heading text-[26px] leading-none font-semibold">This week</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-neutral-600 tabular-nums">
            <button onClick={() => setWeekOffset((w) => w - 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
              ‹
            </button>
            {RANGE_FORMAT.format(days[0])} – {RANGE_FORMAT.format(days[days.length - 1])}
            <button onClick={() => setWeekOffset((w) => w + 1)} className="cursor-pointer px-1 text-neutral-500 hover:text-ink">
              ›
            </button>
            {weekOffset !== 0 && (
              <button onClick={() => setWeekOffset(0)} className="cursor-pointer text-teal-700 hover:underline">
                Today
              </button>
            )}
            <span>· {teams.length} team{teams.length === 1 ? '' : 's'}</span>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newTeamName.trim()) createTeamMutation.mutate(newTeamName.trim());
          }}
          className="ml-auto flex items-center gap-1.5"
        >
          <input
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            placeholder="New team name"
            className="border border-neutral-300 px-2 py-1.5 text-xs text-ink outline-none focus:border-teal"
          />
          <button
            type="submit"
            disabled={!newTeamName.trim() || createTeamMutation.isPending}
            className="cursor-pointer bg-teal px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            + Add team
          </button>
        </form>
      </div>

      {isLoading ? (
        <div className="p-5">
          <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
            Loading this week…
          </div>
        </div>
      ) : teamsError ? (
        <div className="p-5">
          <div className="border border-missed bg-missed/10 p-4">
            <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-missed-fg uppercase">
              Couldn't load teams
            </div>
            <div className="mt-1.5 text-[13px] text-ink">
              {teamsErrorObj instanceof Error ? teamsErrorObj.message : 'Something went wrong.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 px-5 pb-5">
          <div className="grid grid-cols-[160px_repeat(6,1fr)] border border-neutral-300">
            <div className="border-b border-neutral-300 bg-neutral-200 px-3 py-2 font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase">
              Team
            </div>
            {days.map((d) => (
              <div
                key={d.toISOString()}
                className="border-b border-l border-neutral-300 bg-neutral-200 px-3 py-2 text-center font-heading text-[10px] font-semibold tracking-[0.13em] text-neutral-600 uppercase"
              >
                {DAY_LABEL.format(d)} <span className="tabular-nums normal-case">{DAY_NUM.format(d)}</span>
              </div>
            ))}

            {teams.map((team) => {
              const teamVisits = visits.filter((v) => v.teamId === team.id);
              return (
                <Fragment key={team.id}>
                  <div
                    className={`flex items-center gap-2 border-b border-neutral-300 px-3 py-2 text-[12.5px] ${
                      team.isActive ? '' : 'text-neutral-400'
                    }`}
                  >
                    <span className="font-semibold">{team.name}</span>
                    <span className="ml-auto text-[10.5px] text-neutral-500 tabular-nums">{teamVisits.length}</span>
                    <button
                      onClick={() => toggleActiveMutation.mutate({ id: team.id, isActive: !team.isActive })}
                      className="cursor-pointer text-[10.5px] text-teal-700 hover:underline"
                    >
                      {team.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                  {days.map((d) => {
                    const dayISO = toISODate(d);
                    const dayVisits = teamVisits.filter((v) => v.scheduledDate === dayISO);
                    return (
                      <div key={`${team.id}-${dayISO}`} className="border-b border-l border-neutral-300 px-2 py-2">
                        {dayVisits.length === 0 ? (
                          <span className="text-[11px] text-neutral-400">free</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {dayVisits.map((v) => {
                              const job = jobById.get(v.jobId);
                              return (
                                <div
                                  key={v.id}
                                  className={`truncate border px-1.5 py-0.5 text-[11px] ${VISIT_STATUS_STYLE[v.status]}`}
                                  title={job ? `${job.jobSummary} · ${job.buildingName}` : v.jobId}
                                >
                                  {job ? job.buildingName : 'Job'}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>

          {teams.length === 0 && (
            <div className="border border-t-0 border-neutral-300 bg-white px-5 py-10 text-center">
              <div className="font-heading text-[11px] font-semibold tracking-[0.13em] text-neutral-500 uppercase">
                No teams have been set up yet
              </div>
              <div className="mt-1.5 text-[13px] text-neutral-600">
                Add a team above to start booking visits for this week.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
