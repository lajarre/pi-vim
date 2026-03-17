# 03. central invalidation hook for redo

Date: 2026-03-16

## Status

Accepted (supersedes ADR 02)

## Context

ADR 02 used per-path `trackFreshMutation()` wrappers to detect
text mutations for redo invalidation. This required manually
enumerating every mutating code path. Missing a path silently
preserves stale redo history — a fragility confirmed by wave-01
batch 06 (the `Ctrl+K` cancel-path miss).

The v1.1 spec requires a single authoritative invalidation point
that fires regardless of mutation source.

## Decision

Replace per-path wrapping with a single hook on the editor's
`onChange` callback. When `onChange` fires:

1. If the redo stack is empty, return immediately.
2. If `isApplyingUndo` is true, do not clear redo.
3. If `isApplyingRedo` is true, do not clear redo.
4. Otherwise, clear the redo stack.

This hook is the single source of truth for redo invalidation.
New mutating paths automatically participate without opt-in.

## Alternatives considered

### Keep per-path wrapping (ADR 02)

Rejected — requires manual enumeration; silent failure mode
when a path is missed.

### Top-level before/after text comparison at handleInput boundary

Rejected — `handleInput` is re-entrant via `super.handleInput()`
calls; produces false positives without re-entrancy tracking.

## Consequences

### Positive

- New mutating code paths automatically invalidate redo.
- No enumeration discipline required.
- Single integration point — easy to audit.

### Negative

- Depends on `onChange` firing reliably for all text mutations.
  If upstream changes suppress `onChange` for some mutation path,
  redo invalidation would silently break.
- The hook intercepts a callback that belongs to the underlying
  editor — a coupling point.

## References

- `doc/feature/2026-03-15-c-r/adr/02-per-path-mutation-detection.md`
- `doc/feature/2026-03-15-c-r/spec-followup-chatgpt-review.md` §3
