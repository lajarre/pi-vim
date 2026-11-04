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
positioning shortcuts, and register insertion bypass `CustomEditor.handleInput`.
Insert input still uses that dispatcher, including application and extension
shortcuts. Non-Insert modes resolve registered app actions before pending Vim
arguments and invoke their host callbacks; unsupported editor input is consumed.
EX's typed `<C-p>` / `<C-n>` take precedence over app actions and extension
interception; other app actions keep its line unless they are interrupt/clear. Explicit idle-Normal
Enter/Escape still use the host dispatcher. See the ownership contract below.
Calling the original operations retains Pi's kill ring, undo snapshots, and
change notifications. Register content is inserted in one public
`super.insertTextAtCursor(text)` call per copy, not input events, so it cannot
trigger shortcuts. The superclass call keeps the Vim undo/repeat window open
(unlike the override for external injections); the window collapses counted
puts and linewise positioning snapshots into one Vim undo unit. The host
cancels autocomplete and emits one onChange per non-empty register copy.
Before placement/counting, put text normalizes CRLF/CR and tabs as Pi does and
filters other C0, DEL, and C1 controls. Public programmatic insertion does not
filter controls; accepting raw ESC/BEL would let a clipboard OSC sequence reach terminal
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

## App versus editor ownership — 2026-11-04

Non-Insert input uses the injected live `KeybindingsManager` and the editor's
public `actionHandlers` map, not a chord allowlist. Only registered `app.*`
actions and CustomEditor's dynamic specials (interrupt, exit, suspend and
clipboard paste) are admitted. Contextual selector bindings do not become
main-editor actions merely because their default keys exist. Remaps, disabled
bindings, and registrations added/removed after construction apply immediately,
including printable remaps. Matching app input cancels argument, operator,
count and prefix state before extension interception or callback execution.
It preserves mode, selection, register, undo/redo and dot recording unless the
host callback itself changes them. EX retains its exact text except for
`app.interrupt` and `app.clear`, which cancel it. This is intentionally Pi
application behavior, not nvim parity.

Decision: invoke the resolved host callback rather than call the unrestricted
`CustomEditor.handleInput` for app chords. The audited 1.4 host sends nonempty
exit to delete-forward, and explicit editor-history remaps precede app handlers.
Either would reintroduce editing outside Insert. The app-only route retains
extension-shortcut precedence on admitted chords, dynamic `onEscape`/`onCtrlD`,
the empty-prompt exit guard, the interrupt autocomplete guard, and `onPasteImage`.
It deliberately omits the host's editor fallback, including autocomplete
cancellation by an interrupt when autocomplete is showing. It never fabricates
editing keys, mutates the binding manager or snapshots/restores around callbacks.
Alternatives were unrestricted forwarding (leaks editor bindings) or a hardcoded
control whitelist (breaks remaps). A new upstream app-only dispatcher could
replace this local routing when available. The host seam is covered with real
default/remapped bindings in `test/control-key-ownership.test.ts`.

### deliberate routing exceptions

| input / state | owner and behavior |
| --- | --- |
| Insert | Existing Pi dispatcher, plus existing Vim Escape and Alt insertion shims; unchanged |
| Idle Normal Enter | Existing prompt submission through `super.handleInput`; a pending count/operator/prefix consumes Enter instead |
| Typed EX Enter / Backspace | EX submit / grapheme deletion; never the prompt's readline bindings |
| Typed EX `<C-p>` / `<C-n>` | EX command-line history, even when an app action or extension binds the chord; no history navigation from pasted controls |
| Escape / control-left-bracket | Existing modal cancellation or Visual exit first; idle Normal forwards canonical Escape through `super.handleInput`, while EX cancellation invokes Pi's interrupt callback |
| Vim undo / redo controls | pi-vim's undo/redo; never contextual app actions, even if a remap shares the key |
| Bracketed paste | Insert passes through to Pi; Normal/Visual strip and discard it; EX takes only its first line and waits for typed Enter. Payload is never an app shortcut |
| Mouse reports | Unsupported non-Insert reports are consumed, not forwarded. Insert and any upstream fullscreen mouse routing remain Pi-owned |
| Compatibility fallback | Failed required-action preflight still forwards all input unchanged to stock Pi |

Application callbacks may intentionally change text (clear, external editor,
clipboard paste, dequeue); blocking readline fallthrough does not suppress these
app effects. Arbitrary extension shortcuts do not run in non-Insert modes unless
the key is admitted as an app chord (or explicit idle-Normal submit/Escape). No changes to the
pre-existing k/j logical-line history route, motion algorithms or paste policy.

## Cursor-binding aliases — 2026-11-04

The public `ExtensionUIContext.setEditorComponent` factory supplies a typed
`KeybindingsManager`; its inherited public `getKeys` returns resolved defaults,
replacements, lists and disabled actions. `input-keys.ts` snapshots only the
four cursor actions per editor construction and matches events with the existing
Pi `matchesKey` decoder. No runtime private import, TUI singleton, filesystem
parser or additional configuration is needed. The audited host reloads bindings
before re-emitting `session_start`, which installs a fresh editor and snapshot.

Decision: translate cursor bindings to `hjkl` after paste filtering but before
wanted-column bookkeeping and repeat recording. Normal/Visual, pending counts,
operators and `g` therefore share the exact existing motions; dot replays the
canonical motion without reinterpreting printable aliases. Literal arguments
(`f`/`t`/`r`, text objects and `Z`), EX, Escape and Vim undo/redo remain outside
motion translation. Cursor-bound controls cancel pending literal arguments
without invoking an overlapping app callback. Insert and compatibility fallback
retain the original host input path.

The installed 1.4 manager does **not** enforce one action per key. Reassigning
`ctrl+p` to `tui.editor.cursorUp` leaves `app.model.cycleForward`'s default in
place; `matches` returns true for both. Explicit duplicates are reported by
`getConflicts`, not removed, and implicit collisions with defaults are not even
reported. The public 1.5 reference likewise describes overlapping action
precedence. Left/right defaults also include `ctrl+b`/`ctrl+f`.

Cursor bindings take precedence over app callbacks outside Insert. Alternatives:
app-first would prevent the requested Ctrl-P alias; modifying the manager would
change Insert semantics; defaults-only/file parsing would ignore an available
public API. Insert still obeys host precedence, so its Ctrl-P cursor fixture
explicitly disables model cycling. If multiple cursor actions share a key,
resolution is Up, Down, Right, Left, matching the host editor's directional
checks. These conflicting configurations should be resolved in Pi's bindings.

Known `hjkl` gaps remain out of scope: Normal EOL/short-line clamps, `dk` column
zero, `yk` starting cursor, the dual-count vertical-delete rule, and unsupported
horizontal operator suffixes. Fixing these in the alias would create the second
motion path the feature forbids; changing the shared motions requires separate
coverage and scope. Unit tests compare full state against canonical keys,
including these gaps; curated nvim cases cover supported motions, linewise
operators, Visual, Unicode, wrapping, undo/redo and dot. Existing skipped
line-motion cases are unchanged for that reason. Edge prompt recall and app
conflicts are intentional Pi behavior, tested without an nvim equivalent.

## Cursor render preflight — 2026-11-02

After required-action validation, startup renders one detached `CustomEditor`
containing `a`, focused with its cursor on the EOL space at column one. It checks
`pi:c` followed by a bare cell, SGR-7 cell (reset 0 or 27), or the 1.4
`pi:fc`/`pi:/fc` pair, and runs the actual Visual raw-offset scanner over that
cell. A missing/misplaced marker, unknown grammar, malformed APC or probe
exception warns once and disables only Visual paint for that editor instance.
Normal/Insert/Visual commands, registers, undo/redo, EX, labels and hardware
cursor shaping continue. Required-action failure still uses stock pass-through.

Decision: use a detached editor, not temporary mutation/restoration of the live
buffer (would risk undo, autocomplete and onChange side effects), nor inspection
of the first live frame (unknown text/focus and not a startup guarantee). Cache
per editor, not globally, so a reconstructed editor probes its current host.
Constructor callers outside the startup factory get the same preflight on first
input/render. The cached hot path does no probe work. Probe errors are surfaced,
not classified as host bugs; actual live render/action exceptions still escape.

Tests assert one render, supported and rejected grammars, unchanged text/cursor,
mode/register/history, no terminal writes or render requests, and continued
editing/selection/EX after paint disables. This is a Pi presentation capability,
not Vim semantics; nvim cannot exercise it. See the dated hot-path/render
benchmark sections for first-probe, warmed probe and same-host control timings.
It is not a test of the real terminal compositor, wrapper stack or fullscreen UI.

## Clipboard host capability — 2026-11-04

Pi 0.x shipped `@mariozechner/clipboard`; the audited coding-agent 1.4.0 and
1.5.0 `package.json` files do not. A reusable Node executable is therefore not
proof that the legacy read helper can load its backend. `clipboard-mirror.ts`
resolves that dependency with `createRequire` anchored at Pi's entry module,
without loading the native addon in the editor process. Its lazy probe caches
both presence and absence; tests inject isolated resolvers. Missing Pi modules
also select platform commands, rather than disabling reads altogether.

The read route is Node + available module → legacy helper; otherwise → the
existing `clipboard-platform.ts` command list. All attempts retain the shared
750 ms monotonic deadline, 1 MiB output bound, display gating and empty-vs-failed
read distinction. No new notifier or recurring capability probe is added.
Dependency installation/removal during a running process requires restarting
Pi to refresh the decision. This is host compatibility, not a Vim put semantic
change; curated cases compare counted charwise/linewise puts through both
transports. The all-whitespace first-line `^` parity gap stays out of scope:
changing shared cursor placement is independent of clipboard module discovery.

Writes deliberately stay with Pi's exported `copyToClipboard` on Node. Both
published versions re-export it from `dist/index.js`; their identical
`dist/utils/clipboard.js` first tries pi-tui's native clipboard on macOS, then
`pbcopy` through `dist/utils/clipboard-command.js`. Remote sessions also emit
OSC 52 after the direct attempt. Local macOS command/native failure alone does
not trigger OSC 52. Pi 1.5 adds `cwd: "/"` to command spawns; pi-vim does not
need to reproduce either version's write policy.

Six isolated real-helper checks (native, forced `pbcopy`, remote OSC 52 for
both versions) transported UTF-8 stdin correctly. Native/command sinks were
replaced with file sinks, and OSC 52 was captured rather than forwarded to the
terminal. The 1.5 read-only tarball used matching already-installed host
dependencies through a resolver hook, with no installation or package edits;
1.4 dependencies cannot load its full entry point. Actual OS clipboard and
terminal behavior still require the maintainer QA runbook.

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

### Three-version dist seam audit — 2026-11-02

Audited the **published JavaScript dist**, not repository source: read-only
`npm pack @earendil-works/pi-tui@0.74.0` and `@0.78.0` for historical hosts,
and the installed **1.4.0** dev host. All gates run on coding-agent/pi-tui 1.4.0;
older versions are static audits, not full runtime certification. The minimum
pi-tui peer is now **1.0.0**: saved-draft history replaces the pre-1.0 empty-draft
guard. The 0.74/0.78 columns below are historical, no longer supported floors;
1.0.0 has not been runtime-certified by this audit. Coding-agent remains `*`. The 2026-11 public put migration
removed `insertCharacter` from the private action contract.

Line references below are package-relative: **E** =
`node_modules/@earendil-works/pi-tui/dist/components/editor.js`, **T** =
`node_modules/@earendil-works/pi-tui/dist/tui.js`, **U** =
`node_modules/@earendil-works/pi-tui/dist/undo-stack.js`, in each version's
artifact. These cover `pi-editor-actions.ts`, `ModalEditorInternals` and the
additional local casts in `index.ts`, Visual geometry/paint, cursor shaping,
and mode-label/border composition. Public dependencies are labelled explicitly.

| seam | 0.74.0 historical | 0.78.0 historical | 1.4.0 dev (min peer 1.0.0) | semantics / difference |
| --- | --- | --- | --- | --- |
| `undo()` | E1642 | E1614 | E1775 | Exits browsing, pops once, resets action/column and notifies; 1.4 also clears draft and restores paste metadata. |
| `navigateHistory(direction)` | E285 | E287 | E334 | -1 older / +1 newer; entry snapshot once, bounds clamp; recall placement and draft restoration differ below. |
| `moveToLineStart()` | E1197 | E1199 | E1349 | Same: clear lastAction, set column zero. |
| `moveToLineEnd()` | E1201 | E1203 | E1353 | Same: clear lastAction, set UTF-16 line length. |
| `deleteToEndOfLine()` | E1234 | E1236 | E1386 | Same snapshot/kill-ring/notification behavior; 1.4 also clears saved draft. |
| `addNewLine()` | E979 | E981 | E1108 | Same split/snapshot/column-zero behavior; 1.4 also clears saved draft. |
| `moveCursor(deltaLine, deltaCol)` | E1428 | E1430 | E1580 | Visual vertical rows, grapheme horizontal signs; 1.4 refreshes open autocomplete at E1637. |
| `state.lines/cursorLine/cursorCol` | E160–164 | E162–166 | E202–206 | Same mutable UTF-16 state shape; pi-vim mutates these for native range operations. |
| `preferredVisualCol`, `lastAction` | E202,198 | E204,200 | E250,246 | Same nullable preferred column and grouping fields. |
| `historyIndex` | E195 | E197 | E242 | -1 means not browsing; 1.4 additionally owns `historyDraft` at E243 (not a pi-vim field). |
| `pushUndoSnapshot()` | E1639 | E1611 | E1772 | 1.4 wraps state with pastes/counter; pi-vim keeps snapshots opaque. |
| `undoStack.stack`, `.length`, `.pop()` | E210; U8,21,14 | E212; U8,21,14 | E258; U8,21,14 | Same stack surface; pi-vim truncates/pops but never assumes snapshot payload shape. |
| `setCursorCol(col)` | E1076 | E1078 | E1228 | Same preferred-column reset; retains paste-marker-aware host snapping bookkeeping. |
| `onChange` (public callback) | E212 | E214 | E260 | Same optional callback; pi-vim chains it for redo/cache invalidation. |
| `tui`, `requestRender()` | E167; T330 | E169; T330 | E209; T658 | Same receiver/callback use; newer TUI coalescing stays host-owned. |
| `isInPaste`, `pasteBuffer`, `pasteCounter` | E192,191,189 | E194,193,191 | E239,238,236 | Same fields used to cancel pending EX paste; full paste registry remains host-owned. |
| `autocompleteState`, `updateAutocomplete()` | E179,1910 | E181,1851 | E226,2038 | Same optional refresh after pi-vim range replacement; provider trigger parsing expanded in 1.4. |
| `lastWidth`, `scrollOffset` | E171,173 | E173,175 | E213,217 | Same render-produced layout width and visual-row offset. |
| `buildVisualLineMap(width)` | E1378 | E1380 | E1530 | Same logicalLine/startCol/length fields; 1.4 adds CJK wrap opportunities in shared wordWrapLine (E148–158). |
| `render(width)` / `getPaddingX()` (public) | E320,231 | E322,233 | E393,279 | Same border/text/border layout and 30%-height/minimum-five viewport; autocomplete rows follow the lower border. |
| `borderColor` (public), border/label rows | E175,331,357–371,412–422 | E177,333,359–373,414–424 | E219,385–391,428,473 | Old hosts repeat per-glyph color runs; 1.4 colors full rows and centers scroll labels; overlay preserves annotation cells/SGR. |
| cursor metadata / focused emission | E372–395; T42 | E374–397; T42 | E430–457; T69–77 | Old SGR 7 cell becomes pi:fc/pi:/fc APCs; 1.4 emits pi:c even during autocomplete for IME. |
| compositor marker extraction | T716–739 | T716–739 | T1065–1093 | 1.4 resolves fake cursors before extracting pi:c; marker adjacency must survive Visual paint. |
| hardware-cursor getters/setters (public), terminal | T131,134,121 | T131,134,121 | T253,256,215 | Same receiver/boolean contract; terminal.write remains feature-detected; actual terminal glyphs need manual QA. |
| `insertTextAtCursor(text)` (public put path) | E809 | E811 | E939 | Same one snapshot, autocomplete cancellation and notification; 1.4 additionally clears historyDraft. |
| `insertCharacter` (removed dependency) | E867 | E869 | E997 | 1.4 expands provider/CJK completion triggers; Vim puts no longer call this method. |

Pi's `CustomEditor` still extends this editor and routes real user keys through
its application shortcut layer (coding-agent 1.4.0
`dist/modes/interactive/components/custom-editor.js:5,62–112`). No synthetic
key fallback is needed. TUI dispatch still lets editor exceptions propagate
(T425 in 0.74/0.78, T780 in 1.4); the required-action preflight stays important.

The 1.4 `system` theme deliberately returns reset-only `selectedBg` when terminal
colors are unknown (coding-agent `dist/modes/interactive/theme/theme.js:405–416`
and `system-theme.js:365–367,527–544`). This is not a host bug: pi-vim now treats identity
or `SGR 49 + text + SGR 49` as absent paint and uses reverse video. Tests retain
both host cursor grammars, narrow/centered border fixtures, and theme recovery.

Limit: method presence is not proof of private-field semantics. In particular,
pi-vim snapshots still store text/cursor, not the host's complete paste registry;
real large-paste undo and wrapper/fullscreen interactions remain manual QA.
A direct pi-vim restore sets historyIndex to -1 without owning historyDraft;
the next host edit or first browse clears/replaces it. No second draft store
or new host-private field dependency was added.

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
Up/Down input. All three audited hosts expose `history`, `historyIndex` (`-1` means
not browsing), and public `addToHistory`. They trim entries, deduplicate adjacent
entries, retain at most 100, clamp exhausted navigation, and push one undo
snapshot on entering history. Their dispatch conditions are not identical:

| behavior | pi-tui 0.74.0 historical | pi-tui 0.78.0 historical | pi-tui 1.4.0 dev (min peer 1.0.0) |
| --- | --- | --- | --- |
| insert Up entry | Empty, or browsing on first visual row (E617) | Same (E619) | First visual row and empty, browsing, or column zero; allows non-empty draft (E747) |
| insert Down | Browsing on last visual row (E635) | Same (E637) | Same (E761) |
| older recall cursor | End of last logical line (E301–310) | Same (E303–312) | Start of buffer (E363,371–375) |
| newer recall cursor | End of last logical line | Same | Same |
| returning to index -1 | Clears editor (E299) | Same (E301) | Restores saved historyDraft (E348–360) |
| undo | Clears browsing index, restores snapshot | Same | Also clears saved draft and restores paste metadata |

Normal-mode k enters history from any draft at the first logical line;
j at the last logical line requires browsing. Pi owns saving/restoring the
draft. Recalled entries normalize to the last grapheme of the last line, but
returning past newest preserves the host-restored draft cursor. Counts/operators and pending prefixes bypass this path; visual modes
and replay are rejected before host dispatch. Exhausted navigation does not
reposition the cursor. The new boolean defaults on, with project override; this
exposes existing host history without granting a capability or maintaining a
second history/draft store. Insert arrows remain host-owned.

No pi-vim undo window opens for recall. Pi's first-browse anchor survives
`collapseUndoStackTo`; `u` before further edits restores the pre-browse draft
(empty or non-empty) and exits browsing. Redo restores recalled text
and cursor but not browsing state. Pi's onChange clears stale redo; harmless
inputs do not. Recall preserves the last dot command. Seeded tests assert these
states plus register/clipboard neutrality, mode/label stability, Unicode,
wrapped/logical edges, disabled settings, and remapped host bindings. A simulated
start-of-buffer host checks cursor normalization; the same tests now also run
on the real 1.4.0 host. Earlier 1.0 source observations are superseded by the
three-version dist audit above.
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
