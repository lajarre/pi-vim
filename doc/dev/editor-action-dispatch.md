# Direct Pi editor operations

`pi-editor-actions.ts` is the compatibility boundary for Pi's TypeScript-private
editor methods. Before the first input, `ModalEditor` checks the whole contract.
If any method is missing or non-callable, it warns once and disables editor input
for that instance before recording, mode changes, register writes, or edits. The
buffer, cursor, mode, registers and history stay intact. Reload with a compatible
Pi version or disable pi-vim to recover. The successful check is cached; replacing
host methods after the first input is not supported. Individual calls still check
the method and retain its receiver; unrelated host exceptions are not swallowed.

Decision (2026-10-10): notify once + no-op, not a throw from normal input. Both
reviewed Pi TUI versions call the focused editor without an exception boundary,
so a missing-method throw escapes terminal dispatch and can terminate Pi. Catching
only the failed call is too late: commands can already have changed mode, written
the register/clipboard, or inserted part of a put. A whole-contract preflight
avoids partial actions. There is deliberately no synthetic-key fallback: a
remapped, conflicting, or disabled binding cannot reliably express an operation.

Movement, deletion, undo, open-line commands, Insert-mode positioning shortcuts,
and register insertion bypass `CustomEditor.handleInput`. Actual user input
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

All seven action methods exist in the installed pi-tui 0.78.0 and the published
1.0.0 source. The latter was source-audited, not used as the runtime test host.

| operation | signature in both versions | relevant behavior |
| --- | --- | --- |
| undo | `undo()` | Pops one snapshot, no-op when empty; resets grouping/column and emits onChange. 1.0 also restores paste metadata. |
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

Three alternating base/head rounds of the existing five-operation benchmark,
eight samples per run. Base `4811b14` (the intake tip); head `935cf8e` (all runtime
fixes). Node v24.15.0, darwin-arm64, installed peers 0.78.0. Values below are the
median of the three per-run medians and the median of the three per-run p95s;
these are sampled microbenchmarks, not interactive end-to-end latency.

| operation | base median µs | head median µs | base p95 µs | head p95 µs |
| --- | ---: | ---: | ---: | ---: |
| `noop_key` | 0.642 | 0.637 | 0.765 | 0.767 |
| `motion_h_4k` | 425.698 | 418.594 | 429.155 | 423.988 |
| `motion_w_50` | 1.443 | 1.391 | 1.718 | 1.688 |
| `insert_type` | 8.816 | 9.179 | 9.007 | 9.552 |
| `insert_edit` | 12.879 | 13.080 | 13.362 | 13.626 |

Insert medians increased by 0.362 µs (+4.1%) and 0.200 µs (+1.6%); motion medians
did not regress. This migration fixes binding correctness, not performance.
No render optimization or speedup claim is made. The benchmark excludes terminal
painting, large puts, clipboard transport, and 1.0 runtime behavior.

To avoid creating another worktree, extract `git archive 4811b14` under
`.tmp/base-checkout`, then set `PIVIM_ENTRY=.tmp/base-checkout/index.ts` for the
base run. The nested files reuse the installed peers. Keep the archived Biome
configuration under a non-config filename so lint does not discover a nested
root; do not change the active checkout's lint configuration.

## Package evidence

The original unstacked PR measured 18 files / 59,181 bytes packed / 232,872 bytes
unpacked. Intake integration plus compatibility preflight, safe puts and README
contracts measures **19 files / 64,268 bytes packed / 250,897 bytes unpacked**.
Budgets are 19 files / 64,800 packed / 251,600 unpacked: 532 / 703 bytes headroom.
No dependency was added. Tests and development docs remain outside the package.
