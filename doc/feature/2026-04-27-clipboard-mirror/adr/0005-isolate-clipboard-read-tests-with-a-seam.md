# 0005. Isolate clipboard read tests with a seam

Date: 2026-04-27

## Status

Accepted

## Context

The new paste behavior depends on the host OS clipboard, which is nondeterministic in automated tests. The codebase already had a write seam for clipboard mirroring. Existing put tests expected internal-register behavior and should not accidentally depend on the developer or CI machine clipboard.

## Decision

`ModalEditor` exposes `setClipboardReadFn()` as a test seam mirroring the existing clipboard write seam. Shared test harness factories set the read seam to `() => null` by default, forcing shadow fallback unless a test explicitly opts into OS clipboard text, an empty clipboard, or a failure mode.

## Alternatives Considered

### Let tests read the real host clipboard
- Pros: Exercises the real integration path.
- Cons: Nondeterministic; depends on developer or CI clipboard state; can leak local machine state into test outcomes.

### Mock `spawnSync()` globally
- Pros: Tests the child-process wrapper call shape directly.
- Cons: More invasive; couples many tests to Node internals; risks affecting unrelated child-process behavior.

### Use only the existing write seam
- Pros: Avoids adding public test-only surface.
- Cons: Does not control paste-source reads; existing tests could become flaky after `p`/`P` start reading the OS clipboard.

### Add a dedicated read seam with harness fallback
- Pros: Keeps tests deterministic; lets focused tests cover OS-source, null fallback, thrown fallback, empty clipboard, counts, and linewise behavior; matches the existing seam pattern.
- Cons: Adds another test seam to `ModalEditor`; integration with the real OS clipboard is covered indirectly rather than by default unit tests.

## Consequences

Unit tests do not depend on host clipboard state. Focused tests explicitly choose the clipboard read result they need. The default harness behavior preserves older internal-shadow expectations while allowing new tests to prove OS-backed paste semantics. Future tests should set the read seam deliberately when asserting paste behavior.
