# input hot-path benchmark: dot-repeat recording

Dot-repeat records the last change by watching the key stream, so a small
amount of bookkeeping now runs on **every dispatched keystroke** — not only on
change commands. `prepareRepeatRecordingForInput` runs before dispatch
(`index.ts` in `handleInputCore`, just above the mode branches) and
`finishRepeatRecordingAfterInput` runs in the trailing `finally`. (A handful of
inputs — filtered bracketed-paste bytes and mid-flight ex-line bytes — return
earlier and skip both.) This document measures what that per-key path costs, so
the README's "sub-µs word motions" claim can be read against numbers rather
than taken on faith.

The headline: the per-key repeat bookkeeping (and the other input-path guards
added alongside it) adds a fixed, sub-microsecond cost per keystroke — about
**35 ns** on the cheapest key — and is lost in the noise on motions that walk
any real distance. Typing latency stays where it was.

## what "base" and "head" mean

- **head** — the current tip of this branch.
- **base** — the commit immediately before dot-repeat landed, i.e. the parent
  of `feat(repeat): add dot-repeat (.) for the last change` (`7e0d320`), which
  is `feat(operators): support counted d$/c$ and count-ignoring d0/d^/c^`
  (`bbbf63e`). At base, neither recording helper exists and `handleInput` does
  no per-key repeat bookkeeping.

The delta between the two is therefore the **aggregate** per-input branch cost
added since that tip. The repeat recording is its always-on component, but the
other input-path work added in the same window (visual-mode and ex-line guards,
bracketed-paste stripping in normal mode) sits on the same path and is folded
in, not factored out — and any unrelated speedup elsewhere on the path offsets
it (see `motion_w_50`'s negative delta below). So read each number as the
combined branch delta, not an isolated profile of the recording. Isolating
recording alone would need a head build with recording compiled out; that is
out of scope here.

## harness

`script/hotpath-compare.ts` drives `ModalEditor` through the public
`handleInput` surface only, so the same harness runs against any build old
enough to predate the operations it measures. It imports its entry point from
the `PIVIM_ENTRY` environment variable (default: this checkout's `index.ts`),
times each operation with `performance.now()`, and prints per-operation
median/p95 in µs/op as JSON. Rendering is excluded, matching
`script/perf-bench.ts`.

Five operations, chosen to bracket the input path:

| operation | what it is | why |
| --- | --- | --- |
| `noop_key` | unbound printable `z` in normal mode, 20k loop | cheapest key; a fixed per-input cost shows up as the largest fraction here |
| `motion_h_4k` | `h` one column left on a 4k-column line, 4k loop | dominated by the column walk; a control — recording should vanish into it |
| `motion_w_50` | `w` on a 50-word line, reset each op | a cheap real motion, small enough to see per-input overhead |
| `insert_type` | sustained typing in one INSERT session, 1k keys | each key appends to the open recording; the line grows identically in both builds so the delta isolates the append |
| `insert_edit` | `i` `x` `Esc`, fresh editor per op | full recording lifecycle: open on `i`, append, finalize on Esc |

`insert_type` grows a 0→1000-character line, so its absolute µs/op reflects the
host editor's string insert on a lengthening line, not keypress latency. Only
its base-vs-head delta is meaningful here — both builds pay the identical string
cost, leaving the recording append as the difference.

## results

Median of per-run medians over 5 rounds, base and head alternated each round so
machine drift lands on both evenly. Node v24.15.0, Apple M2 Pro, darwin-arm64;
timings are machine-dependent, deltas less so.

| operation | base µs/op | head µs/op | Δ µs/op | Δ % |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.600 | 0.636 | +0.035 | +5.8% |
| `motion_h_4k` | 413.5 | 414.2 | +0.70 | +0.17% |
| `motion_w_50` | 1.376 | 1.374 | −0.002 | −0.1% |
| `insert_type` | 8.29 | 8.43 | +0.14 | +1.7% |
| `insert_edit` | 11.83 | 12.03 | +0.20 | +1.7% |

Reading them:

- **No-op keys** carry the whole fixed cost with nothing to hide behind: ~35 ns
  per keystroke, 5.8% of a 0.6 µs key. This is the price of the per-key
  bookkeeping running on a key that records nothing.
- **Motions** are unchanged for practical purposes. `motion_w_50` moves by about
  two nanoseconds — the sign is negative, i.e. head is a hair *faster*, which is
  just run-to-run noise around zero. `motion_h_4k` gains 0.7 µs on a 414 µs walk
  (0.17%), i.e. the same fixed per-key cost, now a rounding error against the
  work it sits beside.
- **Insert** typing gains ~0.14–0.20 µs per edit for the append and
  open/finalize bookkeeping — well under a microsecond, and dwarfed by the host
  editor's own insert cost.

Every delta is sub-microsecond. Word motions do not shift out of the range they
were already in: `motion_w_50` sits at 1.37 µs in both builds (a 50-word line;
the scoreboard's shorter 20-word `w` is 1.07 µs), and the boundary-cache motion
path the README highlights is untouched by the recording work. The per-key
repeat path did not regress the hot path.

## reproducing this

From a clean checkout of this branch:

```sh
# head
node --import tsx/esm script/hotpath-compare.ts

# base: the commit before dot-repeat landed, checked out *nested* under this
# checkout so Node resolves this checkout's node_modules with no reinstall.
# Grep the feat subject specifically — this doc's own commit subject also
# contains "add dot-repeat", so a looser --grep='add dot-repeat' resolves to
# *this* commit's parent (a build that already has the recording) and yields a
# bogus near-zero delta.
base="$(git rev-list -1 --grep='feat(repeat): add dot-repeat' HEAD)~1"
git worktree add .tmp/base-checkout "$base"
PIVIM_ENTRY=.tmp/base-checkout/index.ts \
  node --import tsx/esm script/hotpath-compare.ts
git worktree remove .tmp/base-checkout
```

The nesting matters: Node walks *upward* from the entry file for `node_modules`,
so the base checkout must live inside this one (here under the git-ignored
`.tmp/`) to reuse its installed peers. A sibling checkout would need its own
`npm ci` instead. Each run prints JSON; compare the `stats.median` of matching
operations. Absolute numbers move with the machine; the deltas above reproduce.

## public register insertion — 2026-11

Base `d66d494` vs the runtime in `perf(put): insert registers through insertTextAtCursor` (its parent is the base). Node v24.15.0, darwin-arm64, installed pi-tui/coding-agent 0.78.0. Three serial base/head, head/base, base/head rounds of `script/perf-bench.ts --json`; four samples per row. Values are median-of-medians and median-of-p95s in µs/op (sample averages, not individual latency tails).

The new `p_chars_*` rows use a fresh editor with `ab`, cursor at column zero, a one-line ASCII `x` register of the labelled size, clipboard reads disabled, and one timed `p`. Creation/register setup is outside timing; 24 operations per sample. The existing `50p` fixture is unchanged (120 operations per sample). These rows also appear in the generated scoreboard.

| operation | base median | base p95 | head median | head p95 |
| --- | ---: | ---: | ---: | ---: |
| `50p` | 161.988 | 164.552 | 65.654 | 73.454 |
| `p_chars_1000` | 324.431 | 352.542 | 19.950 | 21.564 |
| `p_chars_4000` | 1675.338 | 1685.156 | 50.958 | 51.403 |
| `p_chars_16000` | 13102.799 | 13195.608 | 185.490 | 191.823 |

The public call replaces per-character insertion and autocomplete/notification work with one call per filtered register copy. Existing Vim undo windows collapse the host snapshots, including linewise positioning. Calling the superclass avoids the external-injection override that intentionally cancels repeat recording. Counts, linewise placement, filtering, register contents and cursor semantics are unchanged.

A preliminary public-call-only run still cost 1359 µs at 16K: final cursor placement built a grapheme array for the whole line. The final implementation locates that one grapheme using `Intl.Segmenter`'s `containing`, retaining the existing fallback when Segmenter is absent. Tests compare every UTF-16 offset with full segmentation (ASCII, wide, combining, joined emoji and flags), and curated put/undo/dot nvim cases pass. The final 16K median is 0.185 ms, with roughly linear size scaling. No terminal, clipboard process, or 1.4 runtime is measured; the earlier ad-hoc reference timings used a different probe and are not substituted for these measurements.

Reproduce without installing or switching branches: archive `d66d494` TypeScript into `.tmp/put-base`, copy this revision's `script/perf-bench.ts` into its `script/` directory, and run `node --import tsx/esm .tmp/put-base/script/perf-bench.ts --json` from the repo root. Run the head with `node --import tsx/esm script/perf-bench.ts --json`, alternating three rounds. Compare only the responsiveness rows: startup/heap probes use the current cwd rather than the nested entrypoint.

The existing all-whitespace first-nonblank parity gap remains out of scope: changing it would alter shared `^` and put placement policy, rather than preserve the observables of this insertion migration. Characterwise multiline puts retain their documented Pi cursor placement.

## clipboard runtime probe — 2026-10-14

`canSpawnJavaScriptHelper()` runs before clipboard reads/writes. Before this
change (rebuilt checkpoint `f87352c`), each call created a `require` and re-resolved `node:sea`.
The implementation in this commit memoizes the process-constant default
result, including `false`; explicit test overrides bypass the cache and cannot
poison it. No clipboard process, native backend or editor work is timed here.

Node v24.15.0, darwin-arm64; three rounds, ordered before/after, after/before,
before/after. Each fresh process makes one separately timed first probe,
10,000 warmups, then 30 batches of 20,000 probes. Results below are the median
of the three run medians and p95s in µs/call (batch averages, not latency tails).

| probe | before median | before p95 | after median | after p95 |
| --- | ---: | ---: | ---: | ---: |
| repeated default runtime detection | 2.371165 | 2.464360 | 0.005400 | 0.026496 |

Median first-probe time: 106.416 µs before, 104.875 µs after. The default probe
still pays the initial builtin lookup; this result is about repeated work, not
a claim of faster cold startup or OS clipboard completion. Tests count one
SEA probe across repeated default calls for both ordinary Node and simulated
SEA, while injected probes run every time. Bun and missing-API fallback tests
remain in place.

Reproduce without installing dependencies or switching branches:

```sh
mkdir -p .tmp/runtime-before
git archive f87352c clipboard-platform.ts | tar -xf - -C .tmp/runtime-before
# Run once with PIVIM_ENTRY=.tmp/runtime-before/clipboard-platform.ts,
# then with PIVIM_ENTRY=clipboard-platform.ts; alternate for three rounds.
PIVIM_ENTRY=clipboard-platform.ts node --import tsx/esm --input-type=module <<'JS'
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { canSpawnJavaScriptHelper: probe } = await import(
  pathToFileURL(resolve(process.env.PIVIM_ENTRY)).href
);
let consumed = 0;
const firstStart = performance.now();
consumed += Number(probe());
const firstUs = (performance.now() - firstStart) * 1000;
for (let i = 0; i < 10000; i++) consumed += Number(probe());
const samples = [];
for (let sample = 0; sample < 30; sample++) {
  const start = performance.now();
  for (let i = 0; i < 20000; i++) consumed += Number(probe());
  samples.push((performance.now() - start) * 1000 / 20000);
}
const sorted = [...samples].sort((a, b) => a - b);
console.log({ firstUs, median: sorted[14], p95: sorted[27], samples, consumed });
JS
```
