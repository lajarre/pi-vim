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
| initial highlight | `10322c0` | `790fea9` (runtime identical to `690f4cc`) | immediately before selection paint vs paint plus its integration fixes |
| bounded selection work | `36476ab` | `92bd06c` | complete intake before review fixes vs prepared selection range and allocation-free ANSI offset scanning |

The second comparison also includes the history-edit fix; that path does not
run in the measured render loop. It does **not** isolate or claim render
improvements from history recall or label positioning. Those features are
already in both builds of that comparison.

The first seven fixtures reproduce the original highlight harness; the last
four expose repeated end-line work and provide normal-mode controls:

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

## measurement protocol — 2026-10-31

Both tables were remeasured against the rebuilt revisions above: Node
v24.15.0, darwin-arm64, pi-tui/coding-agent 0.78.0. Each comparison uses three
serial rounds in base/head, head/base, base/head order, without a concurrent
test process. Per fixture: 100 warmups, 30 batches of 20 renders (700 frames
per build per round). Values are medians of the three per-run medians and
p95s, in µs/render. These p95s describe **batch-average** cost, not frame tails.

The bounded counts replace the older initial-comparison protocol of five
rounds at 1000/60/100, allowing the same eleven fixtures on both comparisons
without an unbounded 16K pre-fix run. The tables are fresh observations, not
old measurements relabeled with new revision IDs.

## initial highlight evidence

| fixture | base median | base p95 | head median | head p95 | median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `insert_80_long` | 257.467 | 273.235 | 258.138 | 272.556 | +0.3% |
| `visual_5_lines` | 5.954 | 7.613 | 15.019 | 17.973 | +152.2% |
| `visual_line_400_words` | 254.871 | 269.429 | 524.144 | 550.787 | +105.7% |
| `normal_80_long` | 258.415 | 269.223 | 258.419 | 290.771 | +0.0% |
| `ex_80_long` | 259.421 | 302.371 | 255.923 | 273.585 | -1.3% |
| `insert_resize_79_80` | 346.460 | 577.810 | 343.331 | 573.348 | -0.9% |
| `visual_unicode_20` | 51.140 | 53.865 | 107.471 | 115.098 | +110.2% |
| `visual_one_4096` | 324.773 | 344.310 | 3195.679 | 3233.552 | +884.0% |
| `normal_4096` | 321.419 | 344.912 | 322.890 | 344.085 | +0.5% |
| `visual_one_16384` | 1308.985 | 1344.715 | 13035.396 | 13167.346 | +895.8% |
| `normal_16384` | 1308.944 | 1334.594 | 1316.338 | 1346.860 | +0.6% |

Active visual paint adds work: about 9.1 µs on five short lines and 269.3 µs
on the wrapped draft. This is not an optimization result. The one-character
selection on a 16K line originally adds about 11.7 ms; the next comparison
measures the fix for that repeated work. Insert/normal modes do not traverse
selection geometry; a focused regression test replaces both the selection
helper and host layout builder with throwing sentinels.

## bounded selection work

| fixture | base median | base p95 | head median | head p95 | median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `insert_80_long` | 254.123 | 271.190 | 254.750 | 268.998 | +0.2% |
| `visual_5_lines` | 13.742 | 16.446 | 11.858 | 15.117 | -13.7% |
| `visual_line_400_words` | 521.373 | 539.160 | 515.883 | 534.827 | -1.1% |
| `normal_80_long` | 258.619 | 294.983 | 258.629 | 300.069 | +0.0% |
| `ex_80_long` | 251.902 | 270.087 | 253.531 | 275.563 | +0.6% |
| `insert_resize_79_80` | 352.777 | 589.608 | 349.608 | 572.081 | -0.9% |
| `visual_unicode_20` | 106.373 | 118.735 | 105.690 | 114.833 | -0.6% |
| `visual_one_4096` | 3191.735 | 3238.321 | 851.290 | 866.490 | -73.3% |
| `normal_4096` | 319.306 | 334.633 | 325.023 | 346.104 | +1.8% |
| `visual_one_16384` | 13048.002 | 13298.400 | 3496.725 | 3539.879 | -73.2% |
| `normal_16384` | 1316.873 | 1349.033 | 1316.050 | 1353.635 | -0.1% |

The one-character case formerly segmented the entire end line once for each
of 12 visible rows. It now does that once per frame, independent of wrapping;
the regression test checks both lengths at widths 80/40/80. Endpoint ordering
is also prepared once. ANSI scanning uses sticky-regex `lastIndex`, not a
substring allocation per scanned character. No persistent cache or new
invalidation state is needed. Existing visual/grapheme and render-interleaved
nvim cases retain the same semantics.

The one-character visual cases improve by about 73%, but remain slower than
normal rendering: host layout construction and one full end-line segmentation
remain. Small control deltas (including the +1.8% normal 4K result) are reported,
not attributed to a changed non-visual code path. These runs are not statistical
proof of zero regression or a bound on real terminal responsiveness.

## host cursor marker compatibility — 2026-11

Base `dea044d` vs the runtime in `fix(visual): keep host cursor markers intact when painting` (its parent is the base). Same harness, eleven fixtures, installed 0.78.0 peers, Node v24.15.0 / darwin-arm64. Three serial base/head, head/base, base/head rounds at 100 warmups, 30 batches of 20 renders; median of medians and median of batch p95s, µs/render. The head was measured before committing this evidence; no runtime changes followed measurement.

| fixture | base median | base p95 | head median | head p95 | median change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `insert_80_long` | 246.358 | 259.869 | 248.975 | 260.444 | +1.1% |
| `visual_5_lines` | 11.517 | 14.287 | 14.571 | 17.687 | +26.5% |
| `visual_line_400_words` | 500.331 | 514.567 | 509.267 | 524.981 | +1.8% |
| `normal_80_long` | 253.967 | 289.492 | 248.519 | 258.306 | -2.1% |
| `ex_80_long` | 246.521 | 265.381 | 256.127 | 296.548 | +3.9% |
| `insert_resize_79_80` | 333.810 | 555.138 | 344.148 | 576.788 | +3.1% |
| `visual_unicode_20` | 100.067 | 105.767 | 105.254 | 109.888 | +5.2% |
| `visual_one_4096` | 826.156 | 838.971 | 834.444 | 849.421 | +1.0% |
| `normal_4096` | 312.994 | 328.344 | 314.779 | 334.960 | +0.6% |
| `visual_one_16384` | 3393.433 | 3444.646 | 3392.181 | 3494.185 | -0.0% |
| `normal_16384` | 1284.956 | 1304.748 | 1295.031 | 1323.010 | +0.8% |

This correctness fix costs about 3 µs on five short selected lines: validate APC termination and keep host metadata outside injected SGR. Idle controls remain within run noise (−2.1% to +3.9%); their code paths are unchanged. This is not evidence of an idle optimization or real-terminal latency. Synthetic 1.4 marker fixtures assert the compositor regex still matches at selection edges and wrapping boundaries; the timing harness uses the installed 0.78 host, not the unpacked 1.4 reference package.

Reproduce with the commands below, substituting `dea044d` and this section's fix commit for the archive refs and using the same three-round protocol.

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
initial comparison instead, use `10322c0` / `790fea9` with the same counts and
all eleven fixtures. The harness uses only Node builtins and the repo's existing
TypeScript loader. It lives in `script/`, outside the published package.

The [render performance strategy](render-perf-strategy.md) still requires
render-invocation evidence before idle-frame short-circuiting. This benchmark
does not supply that evidence. No label-position or history-specific render
claim is made here.
