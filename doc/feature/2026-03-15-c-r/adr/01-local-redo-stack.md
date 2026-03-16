# 01. local redo stack in modaleditor

Date: 2026-03-16

## Status

Accepted

## Context

We need normal-mode `<C-r>` redo in `pi-vim` for this feature wave.
The spec requires redo now and keeps upstream `pi-tui` redo API work
out of scope for v1.

Current behavior has normal-mode `u` undo only. README documents redo as
deferred, and guidance recovery confirms count and docs constraints for
this wave:

- count state must not leak into later commands,
- `MAX_COUNT` remains capped at `9999`,
- docs promotion targets are `README.md` sections.

The design must satisfy spec risks: snapshot drift, cursor fidelity,
register safety, and count-state safety.

## Decision

Implement redo as a local linear snapshot stack inside `ModalEditor`.
Do not add an upstream prerequisite.

### chosen mechanism

1. Normal-mode `u` feeds redo history.
   - capture `beforeUndo` (text + cursor),
   - forward undo to the underlying editor (`CTRL_UNDERSCORE`),
   - capture `afterUndo`,
   - push `beforeUndo` onto the local redo stack only when
     `beforeUndo != afterUndo`.

2. Normal-mode `<C-r>` applies redo from local snapshots.
   - pop snapshot(s) from the local redo stack,
   - before restore, push the current editor state onto the underlying
     editor undo stack,
   - restore text and cursor exactly from the popped snapshot.

3. Redo invalidation policy.
   - clear redo history after a fresh mutation that happens after undo,
   - do not clear redo for navigation, yank, mode toggles,
     failed/no-op operator paths, or no-op `<C-r>`.

This keeps undo authority in the underlying editor while adding a local
redo bridge that mirrors successful undo transitions.

## Alternatives considered

### 1) full local undo/redo mirror for every mutation

Rejected.

- wider state surface to track across all mutating paths,
- higher risk of divergence from underlying undo boundaries,
- extra complexity not required by this spec's v1 shape.

### 2) redo by replaying original key sequences

Rejected.

- replay is context-sensitive and can drift when buffer context changes,
- weaker cursor fidelity guarantees than snapshot restore,
- harder to keep count behavior deterministic.

### 3) block on an upstream redo API

Rejected.

- conflicts with spec preference for local v1 architecture,
- delays delivery for a non-required dependency,
- does not remove local integration work for count/state safety.

## Consequences

- We accept local snapshot storage in `ModalEditor` as a bounded
  coupling point.
- Undo granularity remains defined by underlying editor undo units.
- Redo correctness depends on precise snapshot capture/restore points.
- Tests must lock snapshot drift protection, cursor fidelity,
  register safety, and count-state safety.

## Risk cross-check (spec)

- snapshot drift: addressed by capturing before/after around actual undo
  transitions and pushing only on real state change.
- cursor fidelity: addressed by snapshot payload including cursor and
  exact restore on `<C-r>`.
- register safety: addressed by restore path touching text/cursor only;
  no redo-side register rewrite.
- count-state safety: addressed by consuming `<C-r>` counts within redo
  handling and resetting pending count state after execution.

## References

- `doc/feature/2026-03-15-c-r/spec.md`
- `doc/feature/2026-03-15-c-r/wave-01/guidance-recovery.md`
- `README.md`
