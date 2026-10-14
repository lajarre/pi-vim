# render benchmark: visual selection

Two comparisons: the cost of adding selection paint, then the cost of fixing
repeated end-line segmentation. These measure rendering, not keystrokes, render
frequency, terminal IO or individual-frame latency tails. No idle-frame cache
or short-circuit is introduced.

## builds and harness

[script/render-compare.ts](../../script/render-compare.ts) imports `PIVIM_ENTRY`
(default `index.ts`) and drives public editor methods. Both builds use the
same installed peers, without an install or another worktree. A stub terminal
has 40 rows; hardware cursor writes are no-ops. Borders and labels use ANSI
colors, selection uses a background color, and all editors are focused.
Construction, input and fixture setup are outside the timed loop. Returned
row counts are consumed. Each JSON result includes fixture keys, UTF-16 size,
widths, mode, batch samples, median and p95 in microseconds per render.

| comparison | base | head | purpose |
| --- | --- | --- | --- |
| initial highlight | `10322c0` | `790fea9` (runtime identical to `690f4cc`) | before and after selection paint plus its integration fixes |
| bounded selection work | `36476ab` | `92bd06c` | complete intake before review fixes vs prepared selection range and allocation-free ANSI offset scanning |

The second comparison also includes the history-edit fix; that path does not
run in the measured render loop. It does **not** isolate or claim render
improvements from history recall or label positioning. Those features are
already in both builds of that comparison.

The first seven fixtures reproduce the original highlight harness:

| fixture | input / selection | widths |
| --- | --- | --- |
| `insert_80_long` | `word0` through `word399`, space-separated; 3,089 UTF-16 units | 80 |
| `visual_5_lines` | five lines: `lineN ` + six copies of `draft word `; 364 units; select through last line end | 80 |
| `visual_line_400_words` | same 400-word draft, whole-line selection | 80 |
| `normal_80_long` | same draft, normal mode | 80 |
| `ex_80_long` | same draft, `:config` label | 80 |
| `insert_resize_79_80` | same draft, alternate widths; footer-cache miss path | 79/80 |
| `visual_unicode_20` | 40 copies of `alpha 中é😀 β `; 560 units; whole string selected | 20 |
| `visual_one_4096`, `visual_one_16384` | unbroken ASCII `x` line; select only its first character | 80 |
| `normal_4096`, `normal_16384` | same unbroken lines, normal-mode controls | 80 |

## initial highlight evidence

Recorded during highlight integration, before this review round: Node
v24.15.0, darwin-arm64, pi-tui/coding-agent 0.78.0. Five rounds, alternating
base/head and head/base. Per fixture: 1,000 warmups, 60 batches of 100 renders.
Values are the median of five round medians and the median of five round p95s.
The original seven-fixture measurements are preserved here rather than
claimed as fresh runs of the later intake tip.

| fixture | base median | base p95 | head median | head p95 | median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `insert_80_long` | 247.707 | 264.282 | 249.337 | 262.009 | +0.66% |
| `visual_5_lines` | 5.479 | 5.902 | 13.880 | 14.983 | +153.33% |
| `visual_line_400_words` | 245.041 | 250.695 | 506.752 | 515.910 | +106.80% |
| `normal_80_long` | 247.053 | 252.719 | 252.303 | 262.884 | +2.13% |
| `ex_80_long` | 246.855 | 253.305 | 249.205 | 258.023 | +0.95% |
| `insert_resize_79_80` | 370.524 | 383.278 | 375.671 | 397.922 | +1.39% |
| `visual_unicode_20` | 49.382 | 55.373 | 104.773 | 111.320 | +112.17% |

Active visual paint adds work: about 8.4 µs on five short lines and 261.7 µs
on the wrapped draft. This is not an optimization result. Insert/normal modes
do not traverse selection geometry; a focused regression test replaces both
the selection helper and host layout builder with throwing sentinels.

## bounded selection work — 2026-10-14

Fresh measurements: Node v24.15.0, darwin-arm64, the same 0.78.0 peers. Three
rounds in base/head, head/base, base/head order; no concurrent test process.
Per fixture: 100 warmups, 30 batches of 20 renders (700 frames per build per
round). Values are medians of the three per-run medians and p95s. Reduced
sample counts bound the 16K pre-fix fixture's runtime; both builds use the
same counts. These p95s are distributions of **batch-average** cost.

| fixture | base median | base p95 | head median | head p95 | median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `insert_80_long` | 254.098 | 270.440 | 254.069 | 270.873 | −0.0% |
| `visual_5_lines` | 14.217 | 16.398 | 11.956 | 14.615 | −15.9% |
| `visual_line_400_words` | 521.492 | 559.260 | 513.442 | 525.481 | −1.5% |
| `normal_80_long` | 250.275 | 276.767 | 261.767 | 313.502 | +4.6% |
| `ex_80_long` | 250.292 | 276.394 | 254.773 | 275.821 | +1.8% |
| `insert_resize_79_80` | 346.556 | 583.617 | 352.944 | 589.344 | +1.8% |
| `visual_unicode_20` | 105.365 | 111.490 | 103.396 | 109.973 | −1.9% |
| `visual_one_4096` | 3176.390 | 3229.606 | 844.269 | 873.069 | −73.4% |
| `normal_4096` | 317.785 | 340.181 | 323.187 | 338.956 | +1.7% |
| `visual_one_16384` | 12900.842 | 12985.219 | 3493.908 | 3536.723 | −72.9% |
| `normal_16384` | 1309.981 | 1328.371 | 1322.563 | 1348.490 | +1.0% |

The one-character case formerly segmented the entire end line once for each
of 12 visible rows. It now does that once per frame, independent of wrapping;
the regression test checks both lengths at widths 80/40/80. Endpoint ordering
is also prepared once. ANSI scanning uses sticky-regex `lastIndex`, not a
substring allocation per scanned character. No persistent cache or new
invalidation state is needed. Existing visual/grapheme and render-interleaved
nvim cases retain the same semantics.

The one-character visual cases improve by about 73%, but remain slower than
normal rendering: host layout construction and one full end-line segmentation
remain. Small control deltas (including the +4.6% normal result) are reported,
not attributed to a changed non-visual code path. These runs are not statistical
proof of zero regression or a bound on real terminal responsiveness.

## reproduction

Run from the repository root with its existing development dependencies.
Nested archives let Node resolve the same peers by walking upward; no branch
switch, worktree creation or package installation is needed.

```sh
mkdir -p .tmp/render-base .tmp/render-head
git archive 36476ab '*.ts' | tar -xf - -C .tmp/render-base
git archive 92bd06c '*.ts' | tar -xf - -C .tmp/render-head
export PIVIM_WARMUP=100 PIVIM_SAMPLES=30 PIVIM_ITERATIONS=20
PIVIM_ENTRY=.tmp/render-base/index.ts PIVIM_BUILD=base node --import tsx/esm script/render-compare.ts > .tmp/render-base.json
PIVIM_ENTRY=.tmp/render-head/index.ts PIVIM_BUILD=head node --import tsx/esm script/render-compare.ts > .tmp/render-head.json
```

Repeat three rounds, reversing order in round two, preserving each JSON file.
Compare each fixture's median-of-medians and median-of-p95s. To reproduce the
initial comparison instead, use `10322c0` / `790fea9` and counts 1000/60/100;
compare its first seven fixtures (the one-character controls were added later).
The harness uses only Node builtins and the repo's existing TypeScript loader.
It lives in `script/`, outside the published package.

The [render performance strategy](render-perf-strategy.md) still requires
render-invocation evidence before idle-frame short-circuiting. This benchmark
does not supply that evidence. No label-position or history-specific render
claim is made here.
