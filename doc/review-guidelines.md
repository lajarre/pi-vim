# Review Guidelines

## review criteria

Flag issues that:
- Meaningfully impact accuracy, performance, security, or
  maintainability
- Are discrete and actionable
- Were introduced in the changes being reviewed
- The author would likely fix if aware of them

Do NOT flag:
- Pre-existing issues outside the current changes
- Style preferences enforced by formatters/linters
- Speculative impact without provable affected code

### Priority levels

Tag each finding:
- [P0] Blocking. Drop everything.
- [P1] Urgent. Next cycle.
- [P2] Normal. Fix eventually.
- [P3] Low. Nice to have.

### Review priorities

- Call out new dependencies and justify them
- Prefer simple solutions over unnecessary abstractions
- Favor fail-fast over logging-and-continue
- Flag dead code, unused state, unreachable branches
- Check error handling (codes not messages, no silent swallow)
- Check untrusted input (SQL injection, open redirects, SSRF)

## Design principles

When fixing issues, follow these principles:
- Public types and abstractions are API contracts — refactor
  their internals, don't delete them
- Data model fields are part of the persisted schema — add
  fields, don't remove existing ones
- Multi-step operations belong in named helper functions
- CLI should require explicit commands — empty input prints
  usage, never defaults to a command
- Persistence must handle user-configured paths (create parent
  directories) and fail atomically (temp file + rename)
- Option/flag parsing should handle edge cases: separator (--),
  duplicates, blank values
- Prefer idiomatic language patterns (e.g., ExitCode over
  process::exit in Rust)

## Project-specific

Reviewers MUST flag:
- User-visible behavior changes without focused tests.
- Focused tests that do not assert the affected observable
  state, as relevant: buffer text, cursor position, mode,
  register/clipboard writes, undo/redo state, count
  consumption, and charwise vs linewise behavior.
- Motion, operator, count, or text-object changes without
  edge-case coverage for count clamp, count leak, no-op
  behavior, and cursor placement.
- Undo/redo, cache invalidation, or history-state changes
  without tests for redo clearing on real edits, harmless
  inputs preserving history, exhausted-history clamp, and
  stale-cache/stale-redo prevention after edits.
- Register or clipboard changes without unnamed-register
  coverage and best-effort clipboard mirroring coverage.
- Unicode or char-motion changes without grapheme-safe tests.
- Vertical movement, `gg`/`G`, paragraph motion, or cursor-
  column changes without wrapped-line vs logical-line
  coverage.
- Hot-path or perf-sensitive changes, including word motions,
  char motions, caches, or startup, without before/after
  benchmark evidence. Reviewers SHOULD flag memory or
  responsiveness regressions.
- Vim-parity changes that neither match Vim nor make the
  intentional divergence explicit in tests and README.
- User-visible command additions or semantic changes that do
  not update README tables/examples in the same change.
- New runtime dependencies without justification.
