# Mode-label QA and evidence

Labels/placement are intentional Pi UI divergences; no nvim editing semantics or parity cases change.

Using disposable settings, test both styles in editor/status placement: INSERT → NORMAL → VISUAL → V-LINE, EX entry/cancellation/submission, pending `2d3f`, and Unicode EX overflow at narrow widths. Check label colors/`labelSync`, symmetric inner padding, no duplicate editor/status label, theme replacement, resize, wrappers, and `/reload`. Removing the settings must restore the full editor label.

Real Pi 1.3.0 PTY checks passed native status in both styles and compact Powerline placement, EX/count feedback, resize/reload, and editor wrappers. No prompt was submitted. Physical-terminal/IME checks remain manual.

Before/after evidence uses frozen upstream `e55b07c`, Node 24.19.0, Linux/x64, Ryzen 5800X. Default full/editor output checksums match. For overflowing Unicode EX (560 UTF-16 units, 12/80-column fixtures), optional compact/status input cost rose ~20–24 → 59–68 µs/key; input+render rose ~67–82 → 100–122 µs. The callback hashes labels, not a real footer; no speedup or performance equivalence is claimed.

Package measurement: 60004 B packed / 236372 B unpacked versus baseline 58576 / 231210, still 17 files and no dependencies. Budgets rise to 60500 / 237000 for the settings, publication/fitting code, and README; test/QA files are not shipped.

Reproducible harnesses, all samples, and limitations are archived outside this PR: [input/publication](https://github.com/francisqureshi/pi-vim/blob/2ef2907b9130bd18b14bf84643f3f91447671bee/doc/dev/status-input-evidence.md), [render](https://github.com/francisqureshi/pi-vim/blob/2ef2907b9130bd18b14bf84643f3f91447671bee/doc/dev/compact-label-evidence.md). Those measurements describe the original feature snapshot; the merge validation below covers integration with newer upstream behavior.

## Merge validation on upstream 0.15.1

Merged upstream `500929e` while retaining `labelPosition`, Visual selection
painting, cursor reconstruction cleanup, and current settings. Status placement
takes precedence over the editor's `labelPosition`; compact pending `Z` feedback
uses `N`. Automated integration cases cover top-left compact labels, status labels
with Visual painting, live theme background replacement, and stale-editor cleanup.

Repeat the manual checks above on the current Pi host, including top-left labels
and Visual highlighting in both placements; the earlier Pi 1.3.0 PTY results do
not establish physical-terminal behavior on Pi 1.4.0.

Fresh package dry runs on this host measure 77094 B / 293444 B at upstream and
78556 B / 298834 B after merging, with 20 files in both. The 79100 B / 299500 B
limits preserve modest headroom without adding dependencies or packed files.

Render replay against upstream `500929e` and the merged code uses the existing
`script/render-compare.ts` fixtures, Node 24.19.0, Linux/x64, 1,000 warmup
renders, 60 samples and 100 renders/sample. Both consume 1,029,000 rows.
These are default full/editor labels, not a fresh status-publication benchmark;
the original opt-in measurements above still describe that additional cost.
The scoreboard ran during part of the baseline, so this is regression evidence,
not evidence of a speedup or statistical performance equivalence.

| fixture | upstream median / p95 (µs) | merged median / p95 (µs) |
| --- | ---: | ---: |
| `insert_80_long` | 481.86 / 519.63 | 478.07 / 483.63 |
| `visual_5_lines` | 18.75 / 22.32 | 19.17 / 20.99 |
| `visual_line_400_words` | 970.77 / 991.85 | 974.55 / 984.02 |
| `normal_80_long` | 478.60 / 485.80 | 480.57 / 490.51 |
| `ex_80_long` | 477.78 / 490.94 | 486.44 / 492.21 |
| `insert_resize_79_80` | 504.06 / 513.27 | 510.30 / 519.92 |
| `visual_unicode_20` | 369.94 / 620.06 | 180.35 / 194.55 |
| `visual_one_4096` | 1620.53 / 2189.15 | 1583.03 / 1591.43 |
| `normal_4096` | 668.38 / 677.73 | 645.10 / 660.62 |
| `visual_one_16384` | 6922.56 / 7018.01 | 6770.33 / 6875.52 |
| `normal_16384` | 2801.84 / 2848.72 | 2735.39 / 2814.21 |

Reproduce with an upstream archive nested below the checkout (so it shares the
installed peers):

```sh
mkdir .comparison-base
git archive 500929e | tar -x -C .comparison-base
PIVIM_ENTRY=.comparison-base/index.ts node --import tsx/esm script/render-compare.ts
node --import tsx/esm script/render-compare.ts
```
