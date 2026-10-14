# Direct Pi editor operations

`pi-editor-actions.ts` is the compatibility boundary for Pi's TypeScript-private
editor methods. Before input or rendering, `ModalEditor` checks the whole contract.
If any method is missing or non-callable, it warns once and forwards every input
unchanged to `CustomEditor.handleInput` for that instance. Preflight itself leaves
the buffer, cursor, mode, registers and history untouched; subsequent typing,
submission and `/reload` or `/quit` use Pi's stock dispatcher and keybindings,
without Vim recording, mode transitions or register/clipboard writes.
Rendering returns the stock lines without a Vim label, border recoloring or cursor
shaping. Startup does not claim the hardware cursor for an incompatible editor;
if replacing an existing Vim editor, its cursor ownership is released once.
The check is cached; replacing host methods after successful validation is not
supported. Individual action calls still check the method and retain its receiver;
unrelated host exceptions are not swallowed.

Decision (2026-10-10 follow-up): notify once + stock pass-through supersedes the
initial notify + input-no-op decision. Swallowing every key stranded the user,
including the recovery commands. A changed private method name need not break Pi's
public input path, so pass-through keeps that path usable. Both reviewed Pi TUIs
let editor exceptions escape terminal dispatch and terminate Pi; a late per-action
catch can also leave partial mode/register/clipboard/put changes. Whole-contract
preflight avoids starting those Vim actions. This is not a synthetic-key fallback:
no remapped key is fabricated, and Pi's actual input semantics remain in control.

Movement, deletion, undo, prompt-history recall, open-line commands, Insert-mode
positioning shortcuts, and register insertion bypass `CustomEditor.handleInput`. Actual user input
still goes through that dispatcher, including application and extension shortcuts.
Calling the original operations retains Pi's kill ring, undo snapshots, and
change notifications. Register insertion uses `insertCharacter` / `addNewLine`,
not input events, so register contents cannot accidentally trigger shortcuts.
Before placement/counting, put text normalizes CRLF/CR and tabs as Pi does and
filters other C0, DEL, and C1 controls. Private `insertCharacter` does not filter
controls; accepting raw ESC/BEL would let a clipboard OSC sequence reach terminal
rendering. This intentionally differs from nvim's literal control-character puts
and leaves the source register unchanged. A control-only put is a no-op, including
cursor/history, while consuming its count. Focused tests assert buffer and render
safety for both clipboard and unnamed-register inputs.
Counted multi-line `P` also resets to the insertion line for every copy, fixing
an existing interleaving bug exposed by the new tests.

Tests configure the pi-tui instance resolved from pi-coding-agent, rather than
assuming the top-level peer shares its singleton. They cover remapped and empty
bindings, conflicting actions, extension interception, Unicode, clipboard writes,
undo/redo, count consumption, and real-input forwarding. Curated nvim comparisons
live in `test/nvim-parity-editor-actions.ts`. The oracle now converts between
nvim's byte columns and Pi's UTF-16 columns and excludes fixture initialization
from both undo histories; it also tolerates undo messages preceding its result.
Follow-up tests cover `2P.`, single-command undo windows, exhausted undo/redo,
real-edit redo invalidation, harmless input, joined/combining graphemes,
and open-line commands at empty/wrapped buffer edges.

## Existing gaps kept out of scope

This dispatch change does not redesign normal-mode cursor clamps (`9l`, `D`,
short-target `j`), line-change register semantics (`S` / `cc`), the all-whitespace
first-nonblank rule, or line-deletion cursor placement. Their existing skipped
parity cases remain: they require motion/register-policy changes independent of
binding dispatch. Characterwise multi-line puts and undo after an open-line
command also retain their existing Pi cursor placement; the new undo parity case
compares restored text after `0`, while unit tests preserve existing cursor state.

## Contributor input-path evidence

Same five-operation input set as `doc/dev/hotpath-benchmark.md`, using the existing
`script/hotpath-compare.ts`. Baseline: `e55b07c`; after: this change. Node v24.21.0,
darwin-arm64. Three alternating baseline/change rounds; each result is the median
of the three per-run medians (eight samples per run), in microseconds/op.

| operation | before | after | change |
| --- | ---: | ---: | ---: |
| `noop_key` | 0.639 | 0.639 | +0.1% |
| `motion_h_4k` | 450.222 | 446.958 | -0.7% |
| `motion_w_50` | 1.467 | 1.438 | -2.0% |
| `insert_type` | 8.717 | 9.007 | +3.3% |
| `insert_edit` | 13.140 | 13.540 | +3.0% |

No material motion regression was observed. Insert medians varied by less than
0.4 microseconds; real typing is not dispatched through the new adapter.
These numbers are evidence for a correctness migration, not a speedup claim.

To reproduce, run `node --import tsx/esm script/hotpath-compare.ts` on this
checkout and on the baseline, alternating runs. Set `PIVIM_ENTRY` to the baseline's
`index.ts` and reuse the same installed peers, as described in the hot-path doc.

## Intake integration evidence (2026-10-10)

All eight action methods exist in the installed pi-tui 0.78.0 and the published
1.0.0 source. The latter was source-audited, not used as the runtime test host.

| operation | signature in both versions | relevant behavior |
| --- | --- | --- |
| undo | `undo()` | Exits history browsing and pops one snapshot, no-op when empty; resets grouping/column and emits onChange. 1.0 also restores paste metadata. |
| prompt history | `navigateHistory(direction)` | `-1` older / `1` newer; first browse snapshots once, valid recalls emit onChange. Cursor/draft behavior differs below. |
| line start | `moveToLineStart()` | Clears lastAction; sets column zero. |
| line end | `moveToLineEnd()` | Clears lastAction; sets UTF-16 line length. |
| delete tail | `deleteToEndOfLine()` | Snapshots real deletes/joins, updates kill ring and onChange. |
| newline | `addNewLine()` | Clears grouping, snapshots, splits line, moves to next line column zero. |
| cursor | `moveCursor(deltaLine, deltaCol)` | Line argument first; visual vertical rows and one grapheme per horizontal sign. 1.0 also refreshes open autocomplete. |
| character | `insertCharacter(char, skipUndoCoalescing?)` | Omitted second argument preserves word/whitespace snapshot grouping and onChange/autocomplete. |

The default raw Ctrl+_ byte (`0x1f`, normalized by Pi to `ctrl+-`) invokes this
same `undo()` through `tui.editor.undo`; no extra undo bookkeeping is lost by
bypassing the binding layer. Pi-vim's own undo windows still collapse each Vim
change to one host snapshot. Existing undo cursor differences for `o`/linewise
`p` are explicitly asserted in the focused history tests, not silently normalized.

Remeasured on 2026-10-31: three alternating base/head rounds of the existing
five-operation benchmark, eight samples per run. Base `21e4a3e` (clipboard
integration); head `10b9ae4` (action integration, before the degraded-mode
follow-up). Node v24.15.0, darwin-arm64, installed peers 0.78.0. Values below
are the median of the three per-run medians and the median of the three
per-run p95s; these are sampled microbenchmarks, not interactive end-to-end
latency. Cursor, quit and visual changes are also present at head; this is an
integration comparison, not an isolated action-adapter profile.

| operation | base median µs | head median µs | base p95 µs | head p95 µs |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.657 | 0.673 | 0.785 | 0.784 |
| `motion_h_4k` | 437.097 | 429.958 | 437.705 | 433.051 |
| `motion_w_50` | 1.486 | 1.383 | 1.702 | 1.722 |
| `insert_type` | 9.295 | 8.943 | 9.884 | 9.328 |
| `insert_edit` | 13.533 | 13.500 | 14.450 | 14.219 |

The ignored-key median increased by 0.016 µs (+2.4%); motion and insert medians
decreased in this sample. This migration fixes binding correctness, not performance.
No render optimization or speedup claim is made. The benchmark excludes terminal
painting, large puts, clipboard transport, and 1.0 runtime behavior.

To avoid creating another worktree, extract `git archive 21e4a3e '*.ts'` under
`.tmp/base-checkout`, then set `PIVIM_ENTRY=.tmp/base-checkout/index.ts` for the
base run. Archive `10b9ae4` into a separate nested directory for the head run.
The nested files reuse the installed peers; archiving only TypeScript avoids
introducing a nested Biome configuration. Run `script/hotpath-compare.ts`
serially, alternating the two entrypoints for three rounds.

### Degraded-mode follow-up evidence

The compatibility matrix models a host with renamed private methods but a working
public dispatcher: the installed host's original method is exposed only inside
its stock `handleInput` call. For every missing/non-callable action, tests assert
unchanged preflight state, one warning, literal typing and Enter/slash-command
submission, no Vim register/clipboard/mode changes, and stock-render equality with
no cursor-shape writes. Factory tests also cover startup without cursor ownership
and replacement of an existing Vim editor, releasing its ownership exactly once.

Remeasured on 2026-10-31: three alternating rounds of `c74137d` vs `3934f5b`,
with the same runtime and aggregation as above, measure the supported input
path after the shared preflight helper:

| operation | base median µs | follow-up median µs | base p95 µs | follow-up p95 µs |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.674 | 0.666 | 0.781 | 0.792 |
| `motion_h_4k` | 429.326 | 432.274 | 433.379 | 434.040 |
| `motion_w_50` | 1.386 | 1.384 | 1.768 | 1.771 |
| `insert_type` | 9.323 | 9.075 | 9.829 | 9.273 |
| `insert_edit` | 13.643 | 13.944 | 14.911 | 14.162 |

The wide-line motion median increased 0.7%; a fresh insert edit increased
0.301 µs (2.2%). Sustained insert decreased by 2.7%. These microbenchmarks
exclude rendering; no render-performance claim is made for the stock fallback.

## Prompt-history integration evidence (2026-10-10)

Issue #51 adds normal-mode edge recall through `navigateHistory`, not synthetic
Up/Down input. Both audited hosts expose `history`, `historyIndex` (`-1` means
not browsing), and public `addToHistory`. They trim entries, deduplicate adjacent
entries, retain at most 100, clamp exhausted navigation, and push one undo
snapshot on entering history. Their dispatch conditions are not identical:

| behavior | pi-tui 0.78.0 | pi-tui 1.0.0 source |
| --- | --- | --- |
| insert Up entry | Empty, or already browsing on first visual row | First visual row and empty, browsing, or column zero (allows a non-empty draft) |
| insert Down | Browsing on last visual row | Same |
| older recall cursor | End of last logical line | Start of buffer |
| newer recall cursor | End of last logical line | Same |
| returning to index -1 | Clears editor | Restores the saved `historyDraft` state |
| undo | Clears browsing index, restores snapshot | Also clears saved draft and restores paste metadata |

Normal-mode j/k deliberately retain the conservative empty-or-browsing guard,
use logical edges, and normalize successful recalls to the last grapheme of the
last line. Counts/operators and pending prefixes bypass this path; visual modes
and replay are rejected before host dispatch. Exhausted navigation does not
reposition the cursor. The new boolean defaults on, with project override; this
exposes existing host history without granting a capability or maintaining a
second history/draft store. Insert arrows remain host-owned.

No pi-vim undo window opens for recall. Pi's first-browse anchor survives
`collapseUndoStackTo`; `u` before further edits restores the pre-browse draft
(empty after normal-mode entry) and exits browsing. Redo restores recalled text
and cursor but not browsing state. Pi's onChange clears stale redo; harmless
inputs do not. Recall preserves the last dot command. Seeded tests assert these
states plus register/clipboard neutrality, mode/label stability, Unicode,
wrapped/logical edges, disabled settings, and remapped host bindings. A simulated
start-of-buffer host checks cursor normalization; 1.0.0 was not runtime-tested.
The nvim oracle has no prompt history; its added cases cover buffer-local counts
and operators instead. Existing short-target vertical and gg/G gaps are unchanged.

### Input-cost evidence

Historical observations from 2026-10-10, retained rather than claimed as a new
run. The corresponding rebuilt checkpoints are `3934f5b` before history and
`00abfe0` after; these table values were not remeasured against those revisions.
The original run used installed 0.78.0 peers and Node v24.15.0: one before/after
run of `node --import tsx/esm script/perf-bench.ts --json`, four samples per
motion. Medians are microseconds/op; these are observations, not speedup claims.

| operation | before | after |
| --- | ---: | ---: |
| h, 4K line | 413.084 | 422.316 |
| ignored printable | 0.660 | 0.665 |
| 10w, 400 words | 33.943 | 34.083 |
| 3fX | 39.201 | 41.456 |
| 200j, 320 lines | 2.506 | 2.627 |
| 50p | 172.183 | 163.333 |
| w / b, 20 words | 0.975 / 1.092 | 1.007 / 1.112 |
| w / b, 50 words | 1.161 / 1.301 | 1.171 / 1.330 |
| w / b, 100 words | 1.516 / 1.651 | 1.520 / 1.719 |
| w / b, 200 words | 2.375 / 2.639 | 2.345 / 2.744 |
| w / b, 400 words | 4.481 / 4.569 | 4.523 / 4.673 |
| dw / yw, 400 words | 8.253 / 4.089 | 8.285 / 4.030 |

Incremental import medians: 27.475 → 21.847 ms (seven process samples);
incremental heap: 3,015,384 → 3,029,944 bytes (five process samples).
A separate guard probe alternated 20,000 j/k pairs per sample (eight measured
samples after one warmup). Fixtures: empty; `abc`; 4,096 ASCII characters;
`ab👩‍💻é` repeated 100 times; `first\nsecond\nthird`. Render once at 40/80/120
columns before timing; no history entries or timed rendering. Across all 15
fixtures, baseline medians were 0.632–0.656 µs/key, after 0.680–0.702 µs/key;
the added guard cost 0.032–0.070 µs/key. No line-length scan was added to the
no-recall path. Terminal painting, successful-recall cost, interactive latency,
and 1.0.0 runtime behavior are not covered by these measurements.

## Package evidence

The following are historical pre-rebuild package measurements. Current totals
and enforced budgets live in `script/pack-check.ts` and the generated
[scoreboard](scoreboard.md); they supersede these snapshots.

The original unstacked PR measured 18 files / 59,181 bytes packed / 232,872 bytes
unpacked. Intake integration plus compatibility preflight, safe puts and README
contracts measured 19 files / 64,268 bytes packed / 250,897 bytes unpacked.
The degraded-mode follow-up measures **19 files / 64,380 bytes packed / 251,395 bytes unpacked**.
Budgets remain 19 files / 64,800 packed / 251,600 unpacked: 420 / 205 bytes headroom.
No dependency was added. Tests and development docs remain outside the package.

The original #51 history integration measured **19 files / 69,241 bytes packed / 268,090 bytes unpacked**.
Budgets become 19 files / 69,700 packed / 268,800 unpacked, leaving 459 / 710 bytes
headroom. Runtime growth is the guarded host action and its boolean setting;
README navigation/settings/limits prose is also shipped. No dependency or packed
file was added.
