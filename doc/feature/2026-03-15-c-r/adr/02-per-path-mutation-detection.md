# 02. per-path mutation detection for redo invalidation

Date: 2026-03-16

## Status

Accepted

## Context

ADR 01 establishes the redo invalidation policy: clear redo
history after a fresh text mutation following undo, but preserve
it across navigation, yank, mode toggles, failed motions, and
no-op `<C-r>`.

The policy says *when* to clear. This ADR records *how* the
implementation detects mutations to trigger that clearing.

Two viable approaches exist:

1. Compare text at the `handleInput` boundary (top-level
   before/after snapshot).
2. Wrap individual mutating code paths with a
   `trackFreshMutation()` helper that captures a snapshot before
   the action, runs it, then clears redo if text changed.

The choice matters because `ModalEditor.handleInput` is
re-entrant: operator helpers, insert-mode passthrough, and
control-sequence cancel paths all call
`super.handleInput(seq)` internally. A top-level comparison
cannot distinguish a real user mutation from an internal
forwarding call that merely delegates to the underlying editor.

## Decision

Use per-entry-point wrapping via `trackFreshMutation()`.

Each code path known to produce text mutations wraps its
mutating call in the tracker:

- insert-mode passthrough and `Alt-o` / `Alt-O`,
- normal-mode control passthrough,
- normal-mode mutators (`x`, `s`, `S`, `D`, `C`, `J`, `gJ`,
  etc.),
- delete/change helpers, put helpers,
- pending-operator cancel paths that forward non-printable
  input to the underlying editor.

The tracker captures a snapshot before the action, runs it,
then calls `clearRedoStackIfFreshMutation()` which clears redo
only when `before.text !== after.text`. An `isApplyingRedo`
guard prevents redo replay from clearing its own stack.

## Alternatives considered

### top-level text comparison at handleInput boundary

- Pros: single integration point, impossible to miss a path.
- Cons: `handleInput` is re-entrant via `super.handleInput()`
  calls from operator helpers and insert-mode forwarding. A
  top-level before/after comparison would fire on internal
  forwarding that is not a user-initiated mutation, producing
  false positives. Suppressing those false positives would
  require tracking re-entrancy depth, which is at least as
  complex as the per-path approach and less explicit.

### clear redo on every handleInput call unconditionally

- Pros: simplest possible implementation.
- Cons: violates the spec requirement that non-mutating commands
  (navigation, yank, failed motions, mode toggles) must preserve
  redo history after undo.

## Consequences

### positive

- Redo invalidation is explicit: each mutating path opts in.
  Non-mutating paths preserve redo by default (no action
  needed).
- The `trackFreshMutation()` wrapper is small and composable;
  adding it to a new mutating path is a one-line change.
- Text-delta check (not cursor-delta) avoids false clears from
  cursor-only movements within mutating helpers.

### negative

- New mutating code paths must remember to include the tracker.
  Omitting it silently preserves stale redo history after a
  real mutation.
- Wave-01 batch 06 demonstrated this risk: the
  `cancelPendingOperator` path for non-printable control
  sequences (e.g. `Ctrl+K`) was initially missed and required
  a follow-up fix to route through `trackFreshMutation()`.
- Maintaining the enumeration requires discipline. A regression
  test that does undo → specific-mutation → redo-is-gone is
  the recommended guard for each new mutating path added in
  the future.

## References

- `doc/feature/2026-03-15-c-r/adr/01-local-redo-stack.md`
  (invalidation policy)
- `doc/feature/2026-03-15-c-r/spec.md` (history invalidation
  §§1-3)
- `index.ts:230-243` (`trackFreshMutation`,
  `clearRedoStackIfFreshMutation`)
- `index.ts:473-480` (batch 06 fix for `cancelPendingOperator`)
- `test/modal-editor.test.ts:2167-2232` (invalidation tests)
- `test/modal-editor.test.ts:2348-2364` (`Ctrl+K` regression)
