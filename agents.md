# Job management System UI - Agent Development Notes

## Why this file

These notes capture day-to-day coding standards for maintainability and review quality in this repository.

## Component Structure

- Prefer smaller, focused components over one large component with mixed concerns.
- Keep orchestration (state transitions, API mutations, async flow) in the parent component.
- Move render-heavy UI blocks into local presentational components when readability starts to drop.
- Refactors should be behavior-safe unless a functional change is explicitly requested.

## useEffect Discipline (Avoid by default)

- Do not use `useEffect` for derived state or event handling that can be done inline.
- Use `useEffect` only for true side effects (external async state sync, subscriptions, imperative integration).
- When a `useEffect` is required, add a short comment above it:
  - why it is required,
  - what external source it is syncing with,
  - what state transition/action it performs.

## Practical Review Rule

When touching existing files:

1. Verify each review finding against current code.
2. Fix only what is still valid.
3. Keep changes minimal and scoped.
4. Run focused lint/tests on touched files.
