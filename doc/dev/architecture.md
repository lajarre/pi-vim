# architecture

How pi-vim is put together: the module/ownership map, the modal state
machine, and the input-dispatch pipeline. This is the high-level map for
review and onboarding; behavior details live in the `README.md` reference
and the per-behavior tests under `test/`.

pi-vim is one `ModalEditor` class (in `index.ts`) that subclasses Pi's
`CustomEditor`, plus a ring of small single-purpose modules it delegates
to. The class owns all mutable editor state and the key-dispatch loop; the
modules are either pure range/string logic, render helpers, or the
side-effecting host integrations (clipboard, mode-change shell hooks).

## module / ownership map

```mermaid
flowchart TD
    subgraph entry["entry / host integration"]
        index["index.ts — ModalEditor class + pi.on session hooks"]
    end

    subgraph pure["pure range / input logic"]
        motions["motions.ts — char / word / paragraph motions, graphemes"]
        textobjects["text-objects.ts — word / delimiter / matching-pair ranges"]
        wbcache["word-boundary-cache.ts — line-local word-boundary cache"]
        inputkeys["input-keys.ts — keyboard-input classification predicates"]
        exhistory["ex-history.ts — in-memory command-line history + draft"]
        visual["visual.ts — visual-selection geometry"]
    end

    subgraph render["render / presentation"]
        cursorshape["cursor-shape.ts — cursor-shape sequences + marker strip"]
        modelabel["mode-label.ts — footer mode-label fitting"]
        modecolors["mode-colors.ts — mode colorizers from settings + theme"]
    end

    subgraph sidefx["side-effecting integrations"]
        clipmirror["clipboard-mirror.ts — mirror writes to system clipboard"]
        clippolicy["clipboard-policy.ts — resolve all / yank / never policy"]
        modechange["mode-change-command.ts — run shell hook on transitions"]
    end

    subgraph shared["shared vocabulary"]
        types["types.ts — Mode / motion / operator types + key maps"]
        settings["settings.ts — read + shape piVim settings"]
    end

    index --> motions
    index --> textobjects
    index --> wbcache
    index --> inputkeys
    index --> exhistory
    index --> visual
    index --> cursorshape
    index --> modelabel
    index --> modecolors
    index --> clipmirror
    index --> clippolicy
    index --> modechange
    index --> types
    index --> settings

    motions --> types
    wbcache --> motions
    inputkeys --> motions
    visual --> motions
    visual --> types
    modelabel --> motions
    modecolors --> settings
    modechange --> settings
    modechange --> types
```

Every arrow is a direct `import`. The graph is acyclic and one-directional:
`index.ts` depends on everything; nothing depends on `index.ts`. `types.ts`
and `settings.ts` are the shared leaves. The `pure` and `render` modules
hold no host editor state (`ex-history` owns only its local entries and draft;
`mode-label`, `input-keys`, `cursor-shape`,
`motions`, `text-objects` are free functions), which is what makes them
safe to unit-test in isolation and to move out of the class without
changing behavior.

| module | owns | pure? |
| --- | --- | --- |
| `index.ts` | modal state machine, key dispatch, operators, undo/redo, dot-repeat, visual selection anchor, put/register, render composition, EX mini-mode and the pi-command bridge, session hooks | no (all mutable state) |
| `types.ts` | `Mode`, `CharMotion`, `PendingMotion`, `PendingOperator`, `LastCharMotion`, `NORMAL_KEYS` | n/a (types + constants) |
| `settings.ts` | `PiVimSettings` shape + `readPiVimSettings` + the `exCommand` resolver | reads settings |
| `motions.ts` | char-find / word / paragraph motion targets, grapheme splitting | yes |
| `text-objects.ts` | word / delimited / matching-pair range resolution | yes |
| `word-boundary-cache.ts` | line-keyed cache of word-motion boundaries | stateful cache, no editor state |
| `input-keys.ts` | escape/enter/backspace/printable/digit/count classification; snapshot the public manager's cursor bindings into a pure raw-input → hjkl resolver | resolver is pure after construction |
| `ex-history.ts` | session-local submitted EX lines (100 distinct, newest first), browse position and draft restoration | stateful store, no I/O or host editor state |
| `visual.ts` | anchor/cursor ordering, line-wise line range, grapheme-aware inclusive selection end, stale-anchor clamping | yes |
| `cursor-shape.ts` | cursor-shape escape sequences, software-cursor marker stripping | render helpers |
| `mode-label.ts` | grapheme-aware fitting of the footer mode label | yes |
| `mode-colors.ts` | resolve/build per-mode colorizers from settings + theme | resolves config |
| `mode-change-command.ts` | debounced shell command on mode transitions | side effect (spawn) |
| `clipboard-mirror.ts` | mirror register writes to the system clipboard via child process, with a failure circuit breaker | side effect (spawn) |
| `clipboard-policy.ts` | resolve the `all` / `yank` / `never` mirror policy | yes |

## modal state machine

`this.mode` is one of `"insert"`, `"normal"`, `"visual"`, or
`"visual-line"`. EX mini-mode is not a fifth `Mode`: it is
`this.mode === "normal"` with `pendingExCommand !== null`.
`getActiveMode()` reports `"ex"` for border/label coloring and folds both
visual modes onto `"normal"`, so EX entry/exit and visual entry/exit reuse
the normal-mode colors. Mode-change shell hooks *do* fire on visual
transitions (they receive `"visual"` / `"visual-line"` and run the
`modeChange.normal` command) but not on EX entry/exit. Within normal mode,
several short-lived *pending* sub-states capture the next key(s) of a
multi-key command.

```mermaid
stateDiagram-v2
    [*] --> Insert
    Insert --> Normal: Esc
    Normal --> Insert: i a o O A I s S C ...
    Normal --> Ex: ":"
    Ex --> Normal: Enter submits / Esc cancels
    Normal --> Visual: v
    Normal --> VisualLine: V
    Visual --> Normal: Esc / v / d x y
    VisualLine --> Normal: Esc / V / d x y
    Visual --> VisualLine: V
    VisualLine --> Visual: v
    Visual --> Insert: c / s / C / S
    VisualLine --> Insert: c / s / C / S

    state Normal {
        [*] --> Ready
        Ready --> OperatorPending: d / c / y
        Ready --> MotionPending: f / F / t / T
        Ready --> ReplacePending: r
        Ready --> GPending: g
        OperatorPending --> Ready: motion or text-object resolves / aborts
        MotionPending --> Ready: target char
        ReplacePending --> Ready: replacement char
        GPending --> Ready: second key
    }

    note right of Ex
        pendingExCommand holds the ":..." buffer.
        this.mode is still "normal"; only the
        active-mode color/label read as "ex".
    end note

    note right of Visual
        visualAnchor holds the position where
        v / V was pressed. Motions move only the
        cursor; the selection is the pair.
    end note
```

Counts (`prefixCount`, `operatorCount`) accumulate alongside these pending
states and are consumed by `takeTotalCount()`, which combines a prefix count
and an operator count — multiplying when both are present — and clamps the
result to `MAX_COUNT`.

## input-dispatch pipeline

`handleInput(data)` is the single entry point for every keystroke. Two
pre-passes run before the main dispatch: EX input normalization (the paste
/ newline wait policy, which prevents a pasted line from auto-submitting)
and bracketed-paste stripping in normal mode. The main dispatch is then
wrapped in `prepareRepeatRecordingForInput` / `finishRepeatRecordingAfterInput`
(a `try` / `finally`) so dot-repeat records the keystrokes of the last
change regardless of which branch handles them. Between paste filtering and
that wrapper, host cursor bindings translate to canonical `hjkl` in motion
contexts (Normal, Visual, counts/operators and `g`), before wanted-column
bookkeeping too. The public editor-factory `KeybindingsManager.getKeys` is
read once per construction; `/reload` supplies the refreshed manager to a new
editor. `matchesKey` remains the only decoder. Insert, EX, literal arguments,
Escape and Vim undo/redo bypass translation. Canonical replay bypasses alias
translation and app interception for `hjkl`, so printable remaps cannot
change the recorded motion. See the cursor-binding decision in
[editor action dispatch](editor-action-dispatch.md#cursor-binding-aliases--2026-11-04). The branch order is a
strict precedence: after modal Escape and Insert routing, EX's typed `<C-p>` /
`<C-n>` / `<Up>` / `<Down>` browse its own history before any app callback (pasted
controls never browse); other registered Pi app bindings cancel pending arguments/counts and
reach their host callbacks. EX is
retained unless the app action is interrupt/clear. Paste payload and Vim undo/redo
controls do not take this route. Pending state then precedes normal-mode keys,
which is why `f.`, `r.`, and `d.` take `.` as their argument rather than as
a repeat. Between app routing and pending commands, Normal offers control/Alt
and Backspace input to `onExtensionShortcut`, preserving raw bytes through
cursor-alias translation. A claim beats aliases/scrolling and cancels pending
state and active repeat recording; a miss leaves Vim ownership unchanged.
EX/Visual, modal Escape, undo/redo, printable/submit keys and paste are excluded
from that extension-only route. App chords already invoke the hook once.
Unsupported Normal/Visual editor input is consumed, including
pending-argument cancellation. EX ignores unsupported editing controls in place.
Only explicit idle-Normal Enter/Escape and Insert (or stock compatibility
fallback) use the unrestricted host dispatcher; app routing excludes editor
fallthrough.
See [editor action dispatch](editor-action-dispatch.md) for the exceptions and
host precedence decisions.

```mermaid
flowchart TD
    input["handleInput(data)"] --> hook["ensureOnChangeHook()"]
    hook --> exnorm{"pendingExCommand != null?"}
    exnorm -- yes --> exwait["normalizePendingExCommandInput<br/>(paste / newline wait policy)"]
    exnorm -- no --> notinsert{"mode != insert?"}
    notinsert -- yes --> paste["strip bracketed paste in normal mode"]
    notinsert -- no --> recwrap
    exwait --> recwrap
    paste --> recwrap["prepareRepeatRecordingForInput<br/>try / finally finishRepeatRecordingAfterInput"]
    recwrap --> esc{"escape-like?"}
    esc -- yes --> doEsc["handleEscape()"]
    esc -- no --> ins{"mode == insert?"}
    ins -- yes --> doIns["alt-key shims, else super.handleInput"]
    ins -- no --> exhist{"typed EX Ctrl-P / Ctrl-N / Up / Down?"}
    exhist -- yes --> browse["recall EX history / restore draft"]
    exhist -- no --> app{"registered app chord?"}
    app -- yes --> doApp["cancel pending state<br/>invoke host app callback, no editor fallback"]
    app -- no --> ext{"Normal extension-only chord claimed?"}
    ext -- yes --> doExt["cancel pending state and active repeat recording<br/>no editor fallback"]
    ext -- no --> rep{"pendingReplace?"}
    rep -- yes --> doRep["r{char}"]
    rep -- no --> exd{"pendingExCommand?"}
    exd -- yes --> doEx["handlePendingExCommand"]
    exd -- no --> tobj{"pendingTextObject?"}
    tobj -- yes --> doTobj["handlePendingTextObject"]
    tobj -- no --> mot{"pendingMotion?"}
    mot -- yes --> doMot["handlePendingMotion"]
    mot -- no --> op{"pendingOperator d/c/y?"}
    op -- yes --> doOp["handlePendingDelete / Change / Yank"]
    op -- no --> vis{"visual mode?"}
    vis -- yes --> doVis["handleVisualMode<br/>consumes v V o d x y c s D X Y C S<br/>and the inert keys"]
    doVis -- "not consumed<br/>(motions, counts)" --> normal
    vis -- no --> normal["handleNormalMode"]
```

`handleVisualMode` returns a boolean rather than owning the whole key
space: motions and counts deliberately fall through to `handleNormalMode`,
so a visual selection resizes using exactly the same motion code paths as
normal mode. It also declines to consume anything while `pendingG` or
`pendingMotion` is set, which keeps `vgg` and `vfx` working.

### EX mini-mode dispatch

`:` in normal mode calls `startPendingExCommand()`, seeding the buffer with
`":"` and resetting the history draft. `ExHistory` is owned by that editor
instance, never shared across sessions or persisted. Typed `<C-p>` / `<C-n>`
recall whole lines; `<Up>` / `<Down>` share the browse position but only match
entries beginning with the saved draft (literal and case-sensitive). Both use
the end-of-line underscore cursor, clamp at the oldest match and restore the
draft past the newest. These fixed EX keys bypass cursor-motion aliases and app
bindings. Appending or backspacing resets the browse position and makes the
edited line the draft and prefix. Esc resets browsing without recording
(both policies intentionally differ from nvim).
Subsequent keys append through `handlePendingExCommand` (with the
paste/newline wait policy applied in the pre-pass, so a pasted newline is
truncated away rather than submitting). `Esc` cancels and invokes Pi's interrupt;
a **typed** `Enter` —
the only thing that can submit — calls `submitPendingExCommand()`, which
records the non-empty line verbatim in history before resolving it in a fixed
precedence order (so even rejected commands are recallable):

1. strip the leading `:`, trim, and detect a trailing `!` (force);
2. if the name is a reserved quit name (`q`, `qa`, `quit`, `qall`,
   `quitall`), quit — guarding a non-empty prompt unless forced;
3. split the remainder into `name` and verbatim `args` on the first
   whitespace run;
4. if `name` is in `EX_RESERVED_NAMES` (held for future vim ex semantics),
   surface a "Reserved ex command" notice — never dispatch;
5. if `piDispatch` is on and `name` is a known Pi command, dispatch it;
6. otherwise surface an "Unsupported ex command" notice.

```mermaid
flowchart TD
  Enter["typed Enter"] --> Quit{"quit name?"}
  Quit -- yes --> DoQuit["quitFn (guard non-empty prompt)"]
  Quit -- no --> Reserved{"in EX_RESERVED_NAMES?"}
  Reserved -- yes --> Notice["notify: Reserved ex command"]
  Reserved -- no --> Known{"piDispatch AND known Pi command?"}
  Known -- yes --> Dispatch["dispatchSlashCommand(name, args)"]
  Known -- no --> Unsupported["notify: Unsupported ex command"]
```

### the pi-command bridge

Pi exposes no public command-dispatch API, so `dispatchSlashCommand` reuses
the one mechanism that reaches every command kind: the editor's own submit
path. `:name args` becomes `/name args` in the buffer, then `onSubmit` runs —
byte-for-byte what happens when the user types the slash command themselves.
Two seams keep that coupling injectable and testable without a live runtime:

| seam | default | supplied at `session_start` |
| --- | --- | --- |
| `setRunCommandFn` | `setText(line)` then `onSubmit(line)` | not overridden (the editor owns its submit) |
| `setCommandNamesFn` | the mirrored builtin names | union of builtins and `pi.getCommands()` |
| `setExCommandSettings` | dispatch on, clipboard copy off | `resolveExCommandSettings` |

`getCommands()` is called inside the thunk, so the known-command set is
recomputed on every submit and a command registered mid-session is reachable.
Pi's builtin list is not re-exported from the package entry point, so
`EX_BUILTIN_COMMAND_NAMES` mirrors it; a name missing from that mirror simply
falls through to "unsupported".

Every dispatch route clears the prompt buffer, and no command reads that buffer
as an argument. So `dispatchSlashCommand` brackets the call with the same
`captureSnapshot` / `restoreSnapshot` pair the dot-repeat rollback uses,
restoring text *and* cursor in a `finally`. Both of Pi's routes clear
synchronously before their first `await`, so the restore wins; a route that
cleared after an `await` would defeat it, which is what the opt-in
`copyInputToClipboard` setting exists to cover.

Restoring the text is not enough on its own. The dispatch's own `setText("")`
is a buffer mutation the user never typed, and it leaves three traces: an entry
on the host editor's undo stack, a cleared redo stack, and a cleared repeatable
command (both via the `setText` override). Left alone, the first `u` after any
`:command` would be silently swallowed undoing the dispatch's churn. So the
`finally` also pops the undo stack back to its pre-dispatch depth and restores
`redoStack` and `lastRepeatableCommand`. The invariant worth remembering: a
dispatch is transparent to the buffer, the cursor, undo, redo, and `.`.

## where the larger behaviors live in `index.ts`

- **undo / redo**: snapshot capture/restore + a `redoStack`; `performUndo`
  / `performRedo` around the host editor's own history.
- **dot-repeat**: a keystroke recorder (`repeatRecording`) captured by the
  dispatch wrap; `repeatLastCommand` replays the recorded key stream, with
  a snapshot rollback if a replay fails. The recorder is disabled in visual
  mode, and `applyVisualOperator` calls `clearRepeatState()` so a later `.`
  cannot replay a normal-mode command the user has moved past.
- **visual mode**: `visualAnchor` plus `this.mode`; `applyVisualOperator`
  resolves the selection through `visual.ts` and then reuses the existing
  `deleteRangeByAbsolute` / `yankRangeByAbsolute` / `deleteLineRange` /
  `yankLineRange` primitives, so `Vd` and `dd` share their cursor
  behaviour (and their known nvim divergence).
- **put / register**: `unnamedRegister` plus the clipboard-mirror policy;
  `putAfter` / `putBefore` handle char-wise vs line-wise placement.
- **render**: `render()` composes lines, fits the mode label
  (`mode-label.ts`), applies mode colorizers (`mode-colors.ts`), and syncs
  the cursor shape (`cursor-shape.ts`) — the cursor-shape write is the one
  side effect on the render path.

## testing model

- `npm test` runs `test/**/*.test.ts` on Node's built-in runner — unit
  tests over the pure modules and the class's observable behavior.
- `npm run test:nvim` runs the parity suites (`test/nvim-parity-*.ts`),
  which drive real headless nvim and compare text / cursor / mode /
  register, pinning pi-vim's behavior to the reference editor.
- `test/**` is excluded from the npm package, so tests never affect the
  `pack:check` size budget.
- `npm run scoreboard` re-derives `doc/dev/scoreboard.md` from those two
  suites plus `script/perf-bench.ts` and `npm pack --dry-run`: the
  committed snapshot of parity coverage, known gaps, per-keystroke cost,
  and published footprint. It refuses to publish a red tree, and every
  number in it is generated rather than transcribed.
