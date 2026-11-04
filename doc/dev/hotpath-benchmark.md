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

## EX history ownership — 2026-11-04

Base `b0a915b` vs the EX-history runtime. Same installed coding-agent/pi-tui
1.4.0, Node v24.15.0, darwin-arm64. Three serial base/head, head/base,
base/head rounds of `script/hotpath-compare.ts`, eight samples per run.
Median of the three per-run medians/p95s, µs/op:

| operation | base median | base p95 | head median | head p95 |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.954 | 1.136 | 0.946 | 1.145 |
| `motion_h_4k` | 538.355 | 540.414 | 539.342 | 542.058 |
| `motion_w_50` | 1.680 | 2.008 | 1.675 | 2.001 |
| `insert_type` | 11.591 | 11.874 | 11.444 | 11.676 |
| `insert_edit` | 17.003 | 17.926 | 16.685 | 17.515 |

The history-key decoder only runs while EX is open; the other non-Insert paths
add a null check, and Insert returns before it. The wide-line median rises
0.987 µs (+0.2%) and ignored-key p95 rises 0.009 µs (+0.8%). These are batch
averages, not real-terminal latency bounds or evidence of a speedup. The
harness uses stub bindings, not real app callbacks. No render algorithm or
cache changed; the final EX append helper's explicit string assignment is
outside these measured paths.

One before/after `script/perf-bench.ts --json` run (seven startup samples,
five memory samples per build) measured extension import medians 631.711 /
647.095 ms, host-only import medians 619.166 / 641.869 ms, and incremental
heap 792,992 / 806,240 B, a 13,248 B increase in these samples (not an
isolated module-allocation measurement). Host-only startup also slowed, so these non-alternating startup samples
do not isolate a history-module startup penalty. History retains at most 100
strings; their lengths, like EX input itself, are not separately capped.

Reproduce the input comparison by extracting `git archive b0a915b '*.ts'`
under `.tmp/exhist-base`, then alternating
`PIVIM_ENTRY=.tmp/exhist-base/index.ts node --import tsx/esm script/hotpath-compare.ts`
with the same command without `PIVIM_ENTRY`. This reuses installed peers,
without installing, switching branches or creating worktrees. EX browse
correctness, paste safety and app-key precedence are tested separately; no
successful-recall or terminal-transport performance claim is made.

## app/editor ownership split — 2026-11-04

Base `932978f` vs the round4 runtime (alias removal plus app-only dispatch).
Same installed coding-agent/pi-tui 1.4.0, Node v24.15.0, darwin-arm64. Three
serial base/head, head/base, base/head rounds of `script/hotpath-compare.ts`,
eight samples per run. Median of the three per-run medians/p95s, µs/op:

| operation | base median | base p95 | head median | head p95 |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.976 | 1.111 | 0.983 | 1.105 |
| `motion_h_4k` | 553.449 | 571.565 | 553.187 | 561.976 |
| `motion_w_50` | 1.706 | 2.082 | 1.683 | 2.322 |
| `insert_type` | 11.859 | 12.258 | 11.772 | 12.029 |
| `insert_edit` | 17.973 | 18.238 | 17.282 | 18.535 |

The ignored-key median rises 0.007 µs (+0.7%); short-word p95 rises 0.240 µs
(+11.5%). No speedup or statistical non-regression claim. An initial version
unconditionally decoded both Vim history controls on every printable input:
ignored-key median was 0.972 → 1.463 µs. Restricting that decoding to raw control
bytes/CSI encodings removed that measured overhead without caching bindings or
restricting printable app remaps. The table above remeasures the final runtime.

This existing harness uses a stub binding manager and no registered app actions;
it measures the added dispatch structure, not the cost of real binding scans or
host callbacks. The real-default/remap matrix tests correctness, not latency.
Rendering, autocomplete, successful history recall, terminal transport and app
side effects are not timed. Reproduce by extracting `git archive 932978f '*.ts'`
under `.tmp/round4-base`, then alternating
`PIVIM_ENTRY=.tmp/round4-base/index.ts node --import tsx/esm script/hotpath-compare.ts`
with the same command without `PIVIM_ENTRY`, using the same installed peers.

## saved-draft history — 2026-11-03

Base `de9f457` vs the runtime in `feat(history): enter history from a non-empty draft`.
Same installed coding-agent/pi-tui 1.4.0, Node v24.15.0, darwin-arm64.
Three serial base/head, head/base, base/head rounds of the five-operation
`script/hotpath-compare.ts` set above, eight samples per run. Median of the
three per-run medians/p95s, µs/op:

| operation | base median | base p95 | head median | head p95 |
| --- | ---: | ---: | ---: | ---: |
| noop_key | 0.933 | 1.103 | 0.943 | 1.146 |
| motion_h_4k | 540.830 | 547.424 | 540.323 | 545.804 |
| motion_w_50 | 1.687 | 1.998 | 1.648 | 1.945 |
| insert_type | 11.548 | 11.854 | 11.643 | 11.980 |
| insert_edit | 16.830 | 17.502 | 17.023 | 17.746 |

The largest positive median delta is 0.193 µs for a fresh Insert edit (+1.1%).
These are input-path controls, not successful-history-recall latency or terminal
measurements. The history guard removes the empty-buffer check and preserves
host-restored cursors; it adds no scan/cache. No performance improvement is claimed.
Reproduce by archiving `de9f457 '*.ts'` into `.tmp/final-base` and alternating
`PIVIM_ENTRY=.tmp/final-base/index.ts` with the default entrypoint as above.

## modal input ownership — 2026-11-03

Base `30a6ee7` vs the runtime in `fix(input): keep control keys out of host actions in normal mode`.
Same installed coding-agent/pi-tui 1.4.0, Node v24.15.0, darwin-arm64.
Three serial base/head, head/base, base/head rounds of `script/hotpath-compare.ts`,
eight samples per operation. Median of per-run medians/p95s in µs/op:

| operation | base median | base p95 | head median | head p95 |
| --- | ---: | ---: | ---: | ---: |
| noop_key | 0.927 | 1.080 | 0.943 | 1.093 |
| motion_h_4k | 541.780 | 545.558 | 545.226 | 552.887 |
| motion_w_50 | 1.660 | 2.010 | 1.678 | 2.090 |
| insert_type | 11.691 | 11.788 | 11.581 | 12.102 |
| insert_edit | 16.924 | 17.276 | 17.089 | 17.518 |

The ignored-key median rises 0.016 µs (+1.7%); the wide-line control rises
3.446 µs (+0.6%). These samples do not prove statistical non-regression or
measure terminal transport. The printable fast return is retained; no global
key decoder, recurring probe or cache was added. This fixes ownership, not speed.
Reproduce by archiving `30a6ee7 '*.ts'` into `.tmp/final-B-base` and alternating
`PIVIM_ENTRY=.tmp/final-B-base/index.ts` with the default entrypoint.

Historical decision (superseded by the 2026-11-04 app/editor split above):
consume unsupported keys at Normal/pending dispatch endpoints and
ignore unsupported controls within EX, rather than blacklist individual Ctrl
bindings or bypass CustomEditor into a second host editor dispatcher. Insert
keeps the real host bindings; explicit Normal Enter and idle Escape remain
host-owned. Unsupported arrows are consumed too, not a second navigation API.
The behavior is intentionally a Pi modal-ownership policy, not a claim that
Vim ignores the same controls. The committed default-binding matrix covers
20 states × 4 controls × 2 encodings, plus Visual/V-Line find/till cancellation,
positive host-action controls, preserved EX text, and explicit submission/abort.

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

### Clipboard module resolver — 2026-11-04

Node v24.15.0, darwin-arm64, coding-agent 1.4.0 without
`@mariozechner/clipboard`. Same first-call / 10,000 warmup / 30 × 20,000
probe protocol above, three fresh-process alternating before/after rounds.
Values are median of run medians/p95s, µs/call (batch averages).

| probe (2026-11-04) | before median | before p95 | after median | after p95 |
| --- | ---: | ---: | ---: | ---: |
| absent-module resolution: uncached lookup vs cached boolean | 48.144819 | 48.870906 | 0.005406 | 0.024779 |
| read dispatch: `ad734a2` vs this fix, simulated command success | 0.019288 | 0.064183 | 0.018471 | 0.065690 |

The first row compares the rejected resolve-on-every-put design with the
cached probe, **not** the previous release (which did not check availability).
Median first lookup: 342.792 µs uncached vs 464.375 µs cached, including lazy
Pi resolution/source construction in the latter. The dispatch row measures
the actual previous helper route vs the new platform route: first dispatch
348.875 → 612.583 µs. The one-time extra lookup is paid on the first read;
afterward the capability is only a boolean, including cached `false`.
Tests count exactly one injected resolution across repeated puts for both
outcomes. No lookup is added to ordinary keystrokes or write dispatch.

No child startup, OS clipboard, rendering or editor insertion is timed. This
is evidence for the cache and routing cost, not a claim of faster end-to-end
puts or a statistical non-regression result. The shared 750 ms process budget
is unchanged. Reproduce from the repo root without switching branches:

```sh
mkdir -p .tmp/clipboard-base
git archive ad734a2 clipboard-mirror.ts clipboard-platform.ts | tar -xf - -C .tmp/clipboard-base
# Run PROBE=resolve-before, resolve-after, read-before, read-after in fresh
# processes; reverse each before/after pair in round 2, repeat round 1 in round 3.
PROBE=resolve-after node --import tsx/esm --input-type=module <<'JS'
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const variant = process.env.PROBE;
const { readClipboardInChildProcess, createClipboardModuleProbe } = await import(
  variant === 'read-before'
    ? './.tmp/clipboard-base/clipboard-mirror.ts' : './clipboard-mirror.ts'
);
const moduleUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const uncached = () => {
  try { return Boolean(createRequire(moduleUrl).resolve('@mariozechner/clipboard')); }
  catch { return false; }
};
const options = {
  platform: 'darwin', now: () => 0,
  run: () => ({ status: 0, signal: null, stdout: 'x' }),
};
const probe = variant === 'resolve-before' ? uncached
  : variant === 'resolve-after' ? createClipboardModuleProbe()
  : () => readClipboardInChildProcess(options) === 'x';
let consumed = 0;
const firstStart = performance.now();
consumed += Number(probe());
const firstUs = (performance.now() - firstStart) * 1000;
for (let i = 0; i < 10000; i++) consumed += Number(probe());
const samples = [];
for (let batch = 0; batch < 30; batch++) {
  const start = performance.now();
  for (let i = 0; i < 20000; i++) consumed += Number(probe());
  samples.push((performance.now() - start) * 1000 / 20000);
}
const sorted = [...samples].sort((a, b) => a - b);
console.log({ variant, firstUs, median: sorted[14], p95: sorted[27], consumed });
JS
```

## Pi 1.4 host compatibility and startup probe — 2026-11-02

Base `f8b20d8` (before compat commits); head: the cursor-marker startup probe
change, including reset-only theme fallback. **Both use the installed
coding-agent/pi-tui 1.4.0**, Node v24.15.0, darwin-arm64. Three serial alternating
rounds (base/head, head/base, base/head), eight samples per operation using
`script/hotpath-compare.ts`. Values are medians of the three per-run medians/p95s,
in µs/op. They do not isolate 0.78-to-1.4 host performance.

| operation | base median | base p95 | head median | head p95 | median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| noop_key | 0.966 | 1.122 | 0.952 | 1.130 | -1.4% |
| motion_h_4k | 546.442 | 550.456 | 548.079 | 550.427 | +0.3% |
| motion_w_50 | 1.708 | 2.035 | 1.645 | 2.100 | -3.7% |
| insert_type | 11.801 | 12.082 | 11.673 | 11.858 | -1.1% |
| insert_edit | 17.284 | 17.435 | 16.727 | 17.604 | -3.2% |

The required-action result and render capability are cached per instance; no
probe occurs on repeated keys. The +0.3% wide-line control is within these batch
variations; this is compatibility evidence, not an optimization claim.

### Startup (same 1.4 host)

`script/perf-bench.ts --json`, seven child processes per import metric, five
heap samples. Run once per revision; these noisy import deltas **exclude editor
construction/preflight**, which is measured separately below. The older history
integration recorded 21.847 ms incremental import on 0.78 (not directly comparable).

| startup metric | base ms | head ms |
| --- | ---: | ---: |
| runtime only | 73.157 | 74.574 |
| host import | 642.644 | 650.957 |
| extension import | 656.245 | 667.761 |
| incremental extension import | 13.601 | 16.804 |

Incremental heap: 780,480 → 785,416 B (+4,936 B); not peak memory or proof of a
retained-heap bound. The import delta rose 3.203 ms in this single process batch;
do not attribute all of that to the probe or call it a cold-start guarantee.

The detached probe includes construction, `setText("a")`, **one** 16-column
host render and the real selection scanner. Three fresh-process first calls
were **1,587.333 / 1,640.750 / 1,535.625 µs** (median **1.587 ms**). After 100
warmups, 30 batches of 100 calls per process gave **7.176 µs median / 9.908 µs
p95** (median of three runs). Construction plus the first Escape, measured the
same way on both revisions, changed **6.578 / 9.979 → 13.737 / 18.301 µs**
(median / p95). Accept the one-time ~1.6 ms cold cost to detect incompatible
paint before editing; no persistent renderer, timer or frame cache was added.

Reproduce without another worktree or installation:

```sh
mkdir -p .tmp/compat-base
git archive f8b20d8 '*.ts' | tar -x -C .tmp/compat-base
PIVIM_ENTRY=.tmp/compat-base/index.ts node --import tsx/esm script/hotpath-compare.ts
node --import tsx/esm script/hotpath-compare.ts
# Alternate those commands for three rounds. For correct import targets:
(cd .tmp/compat-base && node --import tsx/esm script/perf-bench.ts --json)
node --import tsx/esm script/perf-bench.ts --json
```

For the probe-only metric, import `probePiEditorCursor` from
`pi-editor-actions.ts`; pass `{ requestRender() {}, terminal: { rows: 40, cols: 80 } }`,
a theme with identity `borderColor`/`bold` and `fg: (_k,s) => s`, and
`{ matches: () => false }`. Time the first call, then 100 warmups and 30 batches
of 100 calls, asserting every return is true. For the construction control,
time `new ModalEditor(tui, theme, kb).handleInput("\u005cx1b")` instead. The startup
probe is host presentation, not a Vim command, so no nvim parity row is added.
