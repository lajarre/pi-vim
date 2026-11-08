# render performance strategy — decision record

Scope: the strategy decision requested by issue #31 ("perf: plan render
performance strategy"). The issue body is self-contained (two-cost model,
profiling findings, tooling, non-goals); this doc records the decisions and
the evidence bars, and does not duplicate the issue. No perf code lands with
this doc.

## decision 1 — measurement order

1. **Render-invocation instrumentation first** (issue work item 2, first
   half): a render counter plus an inputs-changed flag, to quantify the idle
   re-render question. Cheapest artifact, answers the highest-leverage
   question, and its result decides which cost to attack.
2. **Keystroke/render replay benchmark second** (issue work item 1): committed
   fixtures (widths, long prompts, insert/normal/EX labels, ANSI labels, wide
   graphemes) and a committed baseline, covering cache hit and miss paths.
3. **Leaf follow-ups measured last** (issue work item 3): `visibleWidth`
   hoisting on the footer path only once the benchmark exists to prove the
   residual cost.

Rationale: structural cost bounds leaf cost — a skipped frame pays zero leaf
cost, while a cheaper leaf still runs every tick. The instrumentation is a
few lines; the benchmark is the expensive artifact and should not be built
around the wrong target.

## decision 2 — which cost to attack first

**Structural (idle re-render short-circuit), not leaf.** The issue's profile
already shows: after PR #20 the pi-vim subtree collapses and identical stacks
repeat on every render-timer tick with unchanged content. If instrumentation
confirms that, a short-circuit eliminates whole frames including their leaf
cost; the reverse is not true.

Hard prerequisite carried over from the issue's non-goals: document
`ModalEditor.render` inputs and side effects first, and split the
cursor-shape sequence write out of the pure render path so a skipped frame
cannot drop a needed escape sequence.

## decision 3 — evidence bars (what triggers implementation)

- **Render short-circuit**: implement only when instrumentation shows that at
  steady-state idle (no input for 10 s, default render timer) more than half
  of render invocations run with the inputs-changed flag false, AND the
  render-input set is documented. Below that bar, defer and re-measure after
  the next host (`pi-tui`/`pi-coding-agent`) upgrade.
- **Footer cache extension** (hoist `visibleWidth(lastLine)` /
  `visibleWidth(rawLabel)` on the hit path): only if the replay benchmark
  attributes a measurable share of frame time (target bar: >5% of the frame
  budget at 80-col/long-prompt fixtures) to those two calls. The issue warns
  the cache key must include label visible width to avoid stale fallback —
  keep that constraint.
- **Measured terminal text in `pi-tui`**: only if repeated measurement is
  still material after both of the above; this is an upstream design
  conversation, not a pi-vim patch.
- **Defer** is the standing default whenever a bar is not met; each deferral
  is recorded on issue #31 per its acceptance criteria.

## packaging constraint (current, measured this run)

`pack:check` headroom is 366 B packed / 355 B unpacked (34634/35000,
149645/150000). Consequences:

- instrumentation and benchmark harness code must live in `script/` or
  `test/` (not packed); only a counter hook small enough to fit the headroom
  may touch `index.ts`, and the issue's non-goal forbids raising the budget
  without fresh `pack:check` output and rationale;
- this reinforces measurement-first: a benchmark in `script/` costs zero
  packed bytes.

## branch triage — perf/last-line-caching

- At triage, the branch's only unmerged commit was "perf: last line
  render caching" (+12/−1 on index.ts).
- Main already contains the same cache, landed by PR #20 as `6149853`
  (merged 2026-06-11): the branch's `lastLineCacheKey/lastLineCacheResult`
  corresponds to `ModalEditor`'s `lastLineCache = { l, w, label, result }`
  and the identical key comparison + truncation where `render` truncates the
  last line (search `lastLineCache` in index.ts; line numbers shift with the
  issue #32 modularization). Only field names differ; logic and cached
  expression are the same.
- The branch also predates the `@earendil-works` package rename.
- Recommendation: **archive the branch** (superseded). Archiving is a user
  action via worktree-tending, not this run's.

## selection-paint evidence

[Render benchmark](render-benchmark.md) records the initial highlight cost and
2026-10-31 before/after measurements for bounded selection-end work, with a
reusable no-install harness. It does not measure render-invocation frequency
or justify an idle short-circuit; the evidence bars above still apply.

## status vs issue #31 acceptance criteria

This doc records the "next optimization decision" as: build measurement
(instrumentation, then benchmark), then implement the render short-circuit if
its evidence bar is met, else defer with recorded rationale. The benchmark
command, committed baseline, and idle quantification remain open work items
tracked by issue #31.
