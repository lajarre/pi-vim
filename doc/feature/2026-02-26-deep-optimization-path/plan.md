# Deep Optimization Path — Implementation Plan

**Date:** 2026-02-26  
**Source spec:** `doc/feature/2026-02-26-deep-optimization-path/spec.md`  
**Execution mode:** hortator batched loop

## Goal

Deliver a measurable responsiveness step-up for long single-line word motions while preserving current behavior.

## Acceptance gates

1. `npm test` passes.
2. 400-word single-line `w/b` median latency improves by at least **3x** vs baseline.
3. No regression >10% on non-word microbench (`h`, ignored printable, insert passthrough).
4. Startup overhead increase <= +10 ms median.
5. Heap increase <= +2 MB median.

## Task list

### T1 — Add reproducible perf harness + baseline snapshots

**Requirements (verbatim):**
- Add a committed perf harness script under `script/` that can output JSON for startup, memory, and responsiveness metrics.
- Include microbench points for: `h`, ignored printable, `w/b` on 20/50/100/200/400-word lines, and operator forms `dw`/`yw` on long single lines.
- Capture and persist baseline snapshot data for current implementation before optimization.

**Expected files:**
- `script/perf-bench.ts` (new)
- `doc/feature/2026-02-26-deep-optimization-path/benchmark-baseline.json` (new)

### T2 — Implement line-local fast path for plain `w/e/b`

**Requirements (verbatim):**
- Add guard-based fast path in `ModalEditor` for plain `w/e/b` when motion stays on current line.
- Fallback immediately to canonical absolute-text path when cross-line semantics are required.
- Keep behavior unchanged for multiline transitions (`w`/`e` crossing EOL, `b` from BOL).

**Expected files:**
- `index.ts` (modify)
- `test/modal-editor.test.ts` (modify)

### T3 — Add `WordBoundaryCache` and wire it to motion fast path

**Requirements (verbatim):**
- Introduce a dedicated cache module keyed by exact line content.
- Cache must provide precomputed word boundary data used by fast `w/e/b` lookups.
- On any uncertainty or stale suspicion, fallback to canonical path.

**Expected files:**
- `word-boundary-cache.ts` (new)
- `index.ts` (modify)
- `test/motions.test.ts` or `test/modal-editor.test.ts` (modify)

### T4 — Extend fast path to operator motions (`d/c/y` + `w/e/b`)

**Requirements (verbatim):**
- Apply the same guard/fallback logic for `dw/de/db`, `cw/ce/cb`, and `yw/ye/yb`.
- Use line-local range operations for fast path; preserve existing register behavior.
- Preserve cross-line behavior through canonical fallback.

**Expected files:**
- `index.ts` (modify)
- `test/modal-editor.test.ts` (modify)

### T5 — Differential + regression tests for semantic equivalence

**Requirements (verbatim):**
- Add differential tests comparing fast-path result to canonical-path result on generated line fixtures.
- Add explicit regression cases for guard boundaries (EOL, BOL, punctuation, whitespace runs, empty lines).
- Ensure insert-mode behavior and non-word commands remain unaffected.

**Expected files:**
- `test/modal-editor.test.ts` (modify)
- `test/motions.test.ts` (modify)

### T6 — Roadblock loop: five optimization looks if hotspot target not met

**Requirements (verbatim):**
- If after T1–T5 `w/b` 400-word gain is <3x, run five additional targeted optimization attempts before any bailout.
- For each attempt, capture metrics and keep only changes with favorable trade-off.
- Candidate attempts (must evaluate all five unless target met earlier):
  1. Reduce regex overhead in char classification.
  2. Reduce repeated line/cursor fetches in hot paths.
  3. Batch/optimize cursor movement command emission.
  4. Rework boundary-table search strategy (array index vs binary search).
  5. Tune cache invalidation granularity.

**Expected files:**
- `index.ts` (modify as needed)
- `word-boundary-cache.ts` (modify as needed)
- `doc/feature/2026-02-26-deep-optimization-path/benchmark-attempts.json` (new)

### T7 — Final benchmark report + docs update

**Requirements (verbatim):**
- Record final benchmark snapshot and baseline-vs-final delta report.
- Update feature docs with chosen trade-offs, rejected attempts, and rationale.
- Explicitly state whether acceptance thresholds passed; if not, include clear bailout report with failed attempts.

**Expected files:**
- `doc/feature/2026-02-26-deep-optimization-path/benchmark-final.json` (new)
- `doc/feature/2026-02-26-deep-optimization-path/report.md` (new)
- `README.md` (modify only if user-visible behavior/notes changed)

## Batch proposal

- **Batch 1:** T1 + T2
- **Batch 2:** T3 + T4 + T5
- **Batch 3:** T6 + T7

## Commit protocol

- One logical commit per task group.
- Message style: `<gitmoji> <imperative>`.
- Commit only touched files for that task group.
