# Open question: weekly and fortnightly work on the Monthly Plan

**Status: unresolved. Not implemented. Needs a decision from Luke.**

## The current, honest behaviour

Weekly and fortnightly jobs **are not placed on the Monthly Plan**, and nothing in the app claims they are.

- A weekly job with **no schedule** is listed as `no_schedule` ("Needs a schedule" filter) — findable, but not due.
- A weekly job **with** a schedule is listed as `not_determinable` ("Can't tell").
- `JobCreator` does **not** offer the First due date shortcut for Weekly or Fortnightly. It shows a note saying
  so and sends the manager to the Schedule to book visits directly.
- `ScheduleEditor` still allows a week-unit schedule to be configured by hand. That is unchanged and deliberate —
  the schedule is real data worth recording even while the Monthly Plan cannot act on it.

## Why

`stepMonths` ([src/lib/scheduleFormat.ts](../src/lib/scheduleFormat.ts)) converts a cadence to whole calendar
months and returns `null` for `interval_unit = 'week'`, because a week does not divide into months. Every
derivation downstream — `isMonthInCycle`, `monthsDueInYear`, `suggestDateInMonth` — then answers `null`.

**An anchor date does not fix this**, unlike every month-based cadence. Measured against the real functions:

```
weekly (every 1 week, no anchor)        -> due months: NULL | plan: not_determinable
weekly (every 1 week, ANCHORED)         -> due months: NULL | plan: not_determinable
fortnightly (every 2 weeks, anchored)   -> due months: NULL | plan: not_determinable
quarterly (fixed weekday, ANCHORED)     -> due months: 2,5,8,11 | plan: due_no_date  ✅
```

## The actual question

It is **not** "can we compute the dates" — four or five Wednesdays in a month is trivial arithmetic. It is
**what a Monthly Plan row should be** once a job wants more than one visit in the month. The page's entire
shape today is *one row per job per month*, with one date field, one technician picker and one Book button.

Three candidate answers, none obviously right:

1. **One row per occurrence.** A weekly job becomes 4–5 rows in November. Honest and directly bookable, but a
   handful of weekly jobs would dominate a month that is otherwise one row per job, and client/frequency
   grouping would need to cope with repeated jobs.
2. **One row per job, listing its occurrences.** The row expands to the month's dates with a technician each
   and a single "Book all" action. Keeps the page's shape; needs a genuinely different row component and a
   multi-visit write path (`createVisit` books one visit).
3. **Exclude them, by design.** Weekly work is routine and arguably does not need monthly planning at all —
   Luke's described pain was quarterly/annual work being forgotten, not the weekly round. If so, the right fix
   is wording, not features.

Luke described the problem as *"these are all the jobs due in August"*. Which of the three that means for a
weekly job has not been asked, and guessing it would be inventing a requirement.

## Related constraints

- Whatever is chosen must not break the double-booking guard: booking N visits at once needs the same
  "show what exists / confirm a repeat" treatment a single booking gets, per `MonthlyPlanRow`'s header.
- `visits` has no unique `(job_id, scheduled_date)` constraint and cannot have a naive one — see the Monthly
  Plan plan's "The four DEV duplicates" section.
- Month Matrix has the same gap for the same reason, and should be decided at the same time.
