# Deep Optimization Path Spec

**Date:** 2026-02-26  
**Branch:** `spec/deep-optimization-path`  
**Status:** Draft for implementation planning

## 1) Problem Statement

Current extension overhead is already small at startup/memory level, but there is a clear responsiveness hotspot in word-motion paths on long single-line prompts.

### Benchmark snapshot (quick, local)
- Startup (median):
  - `tsx` runtime only: ~86.6 ms
  - `@mariozechner/pi-coding-agent` import: ~573.0 ms
  - `index.ts` import: ~579.8 ms
  - Incremental extension load over host dependency: **~6.8 ms**
- Memory (median, GC-forced process snapshots):
  - `pi-coding-agent` heap used: ~48.78 MB
  - `index.ts` heap used: ~48.89 MB
  - Incremental extension heap: **~0.11 MB** (noise-level)
- Responsiveness:
  - Normal-mode mapped key (`h`): ~5.8 µs/op
  - Normal-mode ignored printable (`z`): ~0.19 µs/op
  - Single-line `w/b` on 400-word line: ~2493 µs/op (**hotspot**)

Conclusion: startup and RAM are acceptable; deep optimization target is **long-line word-motion latency** while preserving semantics.

---

## 2) Goals / Non-Goals

### Goals
1. Preserve current Vim-like semantics by default (`w/e/b`, operators, cross-line behavior).
2. Reduce long-line word-motion latency significantly without changing behavior.
3. Keep startup overhead increase ≤ +10 ms from current state.
4. Keep steady-state memory overhead increase ≤ +2 MB from current state.
5. Keep implementation maintainable (clear invariants, small modules, explicit tests).

### Non-Goals
1. No feature expansion (no visual mode, counts, macros, search, etc.).
2. No external runtime dependencies for optimization.
3. No behavior changes hidden behind “optimization.”

---

## 3) Deep Optimization Strategy (Selected)

Implement a **semantic-preserving word-motion accelerator** that avoids repeated whole-buffer scanning for common single-line operations.

### Core idea
Introduce a line-local cache for lexical boundaries and a fast path for `w/e/b`, `dw/de/db`, and `yw/ye/yb` when the operation is provably line-local.

### Design components

#### A. `WordBoundaryCache` (new module)
- Input: line string.
- Output: precomputed boundary tables (word starts, word ends, token classes).
- Invalidation: full invalidate on any line mutation; lazy recompute on next use.
- Safety: cache keyed by exact line content identity (or hash + length) to prevent stale reads.

#### B. `FastWordMotionEngine` (new module)
- Uses `WordBoundaryCache` for local motion target lookup.
- Handles `w/e/b` in O(1) to O(log n) target selection after cache build.
- Defines strict guard conditions for fast path:
  1. Operation starts and ends on same line.
  2. No pending state requiring cross-line semantics.
  3. Cursor and line snapshot unchanged during computation.
- If any guard fails: immediately fallback to current canonical path.

#### C. Integration in `ModalEditor`
- Replace direct calls to `findWordTargetInText()` in hot paths with:
  1. `tryFastWordMotion(...)`
  2. fallback to existing absolute-index logic.
- Affected command families:
  - Motion: `w/e/b`
  - Delete operator: `d` + `w/e/b`
  - Yank operator: `y` + `w/e/b`

---

## 4) Data Flow

1. Key arrives (`w`, `e`, `b`, or operator+motion).
2. `ModalEditor` checks fast-path guards.
3. If eligible:
   - obtain boundary map for current line from cache,
   - compute target column,
   - execute mutation/yank/move using existing editor primitives.
4. If not eligible or cache invalid:
   - run current canonical text-wide path.
5. On any mutation:
   - invalidate cache entry for touched line(s).

This keeps existing behavior as source of truth and treats acceleration as optional execution path.

---

## 5) Reliability, Security, Correctness

- No network/filesystem attack surface change.
- Main risk is semantic drift due to stale cache or incorrect guard logic.
- Mitigations:
  1. Invariant checks in dev/test mode (fast result must match canonical result on sampled runs).
  2. Differential tests: fast path vs canonical path for random line fixtures.
  3. Fallback-on-doubt policy (never force fast path under ambiguity).

---

## 6) Benchmark & Acceptance Plan

### Benchmarks to run
1. Cold startup import medians (20 runs).
2. Memory snapshot medians with GC (10 runs).
3. Microbench for:
   - `h` mapped key,
   - ignored printable,
   - `w/b` on 20/50/100/200/400-word lines,
   - `dw` and `yw` on long single lines.
4. End-to-end interaction latency under scripted key streams.

### Acceptance thresholds
- `w/b` on 400-word single line: **≥ 3x faster** than current median.
- No regression >10% for non-word hot paths (`h`, insert-mode passthrough).
- Startup delta ≤ +10 ms median.
- Heap delta ≤ +2 MB median.
- All existing tests pass; new differential tests pass.

---

## 7) Weighted Trade-offs

| Option | Perf Gain | Semantic Safety | Complexity | Recommendation |
|---|---:|---:|---:|---|
| Status quo | Low | High | Low | Not enough for hotspot |
| Native fast-word mode (`alt-f/b`) | Very High | Low | Low | Keep as optional fallback experiment only |
| **Deep optimization path (this spec)** | **High** | **High (with fallback)** | **Medium-High** | **Recommended** |
| Full internal editor rewrite | Very High | Unknown | Very High | Reject |

---

## 8) Rollout Plan

1. Phase 1: introduce cache + fast motion for plain `w/e/b` (no operators).
2. Phase 2: extend to `d`/`y` operator motions.
3. Phase 3: add differential/property tests and benchmark harness.
4. Phase 4: tune and document behavior + performance notes.

Each phase ships behind an internal feature flag first, then default-on after benchmark and regression sign-off.

---

## 9) Open Questions

1. Should differential checks run in CI always, or only in extended test mode?
2. Should we expose a user-facing config to force canonical mode for debugging?
3. What line length threshold (if any) should trigger stricter guard behavior?
