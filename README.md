# pi-vim

Vim in Pi's prompt. Draft in INSERT, edit in NORMAL, select in VISUAL — and run `:!git status` from the middle of a prompt without losing a word of your draft.

```bash
pi install npm:pi-vim
```

Restart Pi after install; requires `@earendil-works/pi-tui >= 0.74.0`.

[quickstart](#30-second-quickstart) · [key reference](#full-reference) · [settings](#settings-reference) · [limits](#limits-and-vim-differences)

<!-- gif slot (recording pending): hero — Esc into NORMAL, a few motions and edits, footer label and border tracking the mode -->

## highlights

### the everyday vim, in all four modes

Hit `Esc` and the prompt is a modal editor: INSERT, NORMAL, VISUAL, and V-LINE. Motions (`w`, `f{char}`, `%`, `25gg`), operators with counts (`3dw`, `ci"`, `ya{`), text objects, and `.` to repeat the last change. Undo is scoped like vim's: one `u` reverts one whole change — an insert session, a `cw`, a paste — and `<C-r>` brings it back. The boundaries (block visual, macros, search, vim ex semantics) are documented below rather than half-built.

<!-- gif slot (recording pending): a change, then . . . down the buffer, then u / <C-r> -->

### an ex line that talks to Pi

`:tree` runs Pi's `/tree` without leaving your half-written prompt; `:model opus` switches models; every builtin, extension, skill, and prompt command dispatches the same way. A leading `!` reaches Pi's shell — `:!ls` runs `ls`, `:!!cmd` keeps it out of context. The draft is snapshotted before every dispatch and restored after, so a command never eats your prompt.

<!-- gif slot (recording pending): half-written draft, :!ls, shell output appears, draft intact -->

### and the comfort layer

Yanks and deletes mirror to the OS clipboard (configurable), the cursor shape follows the mode on DECSCUSR terminals, the footer always shows `INSERT` / `NORMAL` / `VISUAL` / `V-LINE` / `EX`, and mode-colored borders and labels are one setting away — each mode choosing whether to paint its own color, show the host's border, or defer only while the host is thinking.

## 30-second quickstart

Try this on multi-line input:

```text
Esc            # NORMAL mode
3gg            # jump to absolute line 3
2dw            # delete two words
u              # undo
<C-r>          # redo last undone edit (safe no-op when empty)
:!git status   # run in Pi's shell; your draft is restored
```

Common quick wins:

| goal | keys |
|---|---|
| Jump to exact line 25 | `25gg` (or `25G`) |
| Delete two words | `2dw` |
| Change current whitespace-delimited WORD | `ciW` |
| Delete WORD plus adjacent whitespace | `daW` |
| Change inside double quotes | `ci"` |
| Delete inside parentheses | `di(` |
| Yank braces with contents | `ya{` |
| Change to end of line | `C` |
| Delete current + 2 lines below | `d2j` |
| Yank 3 lines | `3yy` |
| Join 3 lines with spacing | `3J` |
| Jump 2 paragraphs forward | `2}` |
| Run `ls` in Pi's shell | `:!ls` |
| Undo last edit | `u` |
| Redo last undone edit | `<C-r>` |

---

## full reference

### mode switching

| key | action |
|---|---|
| `Esc` / `Ctrl+[` | Insert → Normal mode |
| `Esc` / `Ctrl+[` | Normal mode → pass to Pi (aborts the agent under default Pi keybindings) |
| `:` | Normal → EX mini-mode |
| `i` | Normal → Insert at cursor |
| `a` | Normal → Insert after cursor |
| `I` | Normal → Insert at first non-whitespace |
| `A` | Normal → Insert at line end |
| `o` | Normal → open line below + Insert |
| `O` | Normal → open line above + Insert |
| `v` | Normal → character-wise Visual mode |
| `V` | Normal → line-wise Visual mode |
| `Esc` / `Ctrl+[` | Visual → Normal mode (never reaches Pi) |

Optional: move Pi's `app.interrupt` off bare `escape` in `~/.pi/agent/keybindings.json` if it overlaps with Insert→Normal; user config wins.

Insert-mode shortcuts (stay in Insert mode):

| key | action |
|---|---|
| `Shift+Alt+A` | Go to end of line |
| `Shift+Alt+I` | Go to start of line |
| `Alt+o` | Open line below |
| `Alt+Shift+O` | Open line above |

#### ex mini-mode

The ex line handles safe quit flows, dispatches known Pi commands, and sends `:!cmd` to Pi's shell.

| key / command | action |
|---------------|--------|
| `:` | Enter EX mini-mode |
| `Enter` | Execute pending ex command |
| `Esc` | Cancel EX mini-mode |
| `Backspace` / `Ctrl+h` | Delete one ex-command character; on bare `:` exits EX mode |
| `:q` | Quit the current Pi session only when the prompt is empty or whitespace-only; otherwise show a warning |
| `:q!` | Force quit the current Pi session even when the prompt has text |
| `:qa` | Same safe quit policy as `:q` |
| `:qa!` | Same force quit policy as `:q!` |
| `:quit` / `:qall` / `:quitall` | Long aliases with the same safe quit policy as `:q` |
| `:quit!` / `:qall!` / `:quitall!` | Long aliases with the same force quit policy as `:q!` |
| `:{command}` | Run the Pi slash command of that name, e.g. `:tree` runs `/tree` |
| `:{command} {args}` | Run it with everything after the first whitespace run, e.g. `:model opus` runs `/model opus` |
| `:!{cmd}` | Run `{cmd}` in Pi's shell via `!{cmd}`, e.g. `:!ls` runs `!ls`; `:!!{cmd}` runs it excluded from context |
| reserved `:{cmd}` | Show a reserved-command notification; never dispatched |
| unsupported `:{cmd}` | Show warning notification; no quit, no dispatch |

Quit commands match the exact forms above only; vim prefix abbreviations such as `:quita` are unsupported. A paste never auto-submits: only a typed `Enter` submits an ex command. Pasting into the ex line keeps the paste up to its first newline, holds that first line, and discards the rest, so pasted content can never execute until you type Enter yourself.

##### pi-command bridge

This is a bridge to Pi's command registry, not vim ex-command support. `:name` is exactly the user typing `/name` and pressing `Enter`: it dispatches builtin, extension, skill, and prompt commands alike, and it grants no capability the `/` palette does not already have. Vim ex-command *semantics* (`:s`, `:g`, `:w`, `:r`, …) remain out of scope.

An ex line resolves in a fixed order:

1. **quit names win** — the `:q` family above, unchanged. `:q!` is a quit form, so a leading `!` here never dispatches to the shell.
2. **`:!cmd` dispatches to the shell** — a bare leading `!` submits the line through the same seam, so `:!ls` is exactly typing `!ls` and pressing `Enter` in Pi's bash mode (`:!!cmd` excludes it from context). `:!` with no command is unsupported.
3. **reserved names win next** — `s`, `g`, `v`, `d`, `m`, `t`, `co`, `j`, `w`, `r`, `normal`, `sort`, `&`, `>`, `<` are held for future vim ex semantics. They are never dispatched, even if a Pi command of the same name is installed; use `/w` for that. A trailing `!` is stripped for this check, so `:w!` is reserved too.
4. **known Pi commands dispatch** — the union of Pi's builtins and whatever `pi.getCommands()` reports at the moment you press `Enter`, so a command registered mid-session is reachable without a restart.
5. **anything else is unsupported** — a warning notification. A typo never reaches the LLM as a message.

Names match exactly and case-sensitively: `:tree` works, `:tre` and `:tree!` do not.

Dispatch clears Pi's prompt buffer, so pi-vim snapshots the composed prompt before the command runs and restores it after; no command reads that buffer as an argument, so the restore is always safe. A dispatch is transparent: the prompt text, the cursor position, undo, redo, and the `.` repeat all survive it untouched. Pi's builtin and extension routes both clear the buffer synchronously before their first `await`, which the restore beats. Set `piVim.exCommand.copyInputToClipboard` to `true` if you want the prompt copied to the OS clipboard before each dispatch as a belt-and-braces fallback, or `piVim.exCommand.piDispatch` to `false` to switch the bridge off entirely.

Discoverability is Pi's `/` palette; ex-line completion of command names is not implemented.

---

### navigation (normal mode)

Most navigation keys accept a `{count}` prefix (max: `9999`); `%` intentionally does not.

| key | action |
|---|---|
| `h` / `l` / `j` / `k`; `{count}h/l/j/k` | Move left/right/down/up; line moves clamp to the buffer |
| `0` / `^` / `_` / `$` | Line start / first non-whitespace / counted first non-whitespace / line end |
| `gg` / `G`; `{count}gg` / `{count}G` | Buffer start/end or absolute 1-indexed line |
| `gM`; `{count}gM` | Halfway the text of the line; a count of `1`-`100` moves to that percentage of it (higher counts mean halfway, per nvim); text is measured in graphemes, not screen cells |
| `w` / `b` / `e`; `{count}w/b/e` | `word` start/back/end motions |
| `W` / `B` / `E`; `{count}W/B/E` | whitespace-delimited `WORD` motions |
| `{` / `}`; `{count}{` / `{count}}` | Previous/next paragraph start |
| `%` | Jump to the matching `()`, `[]`, or `{}` partner |

`word` splits punctuation from keyword chars; `WORD` treats any non-whitespace run as one token (`foo-bar`, `path/to`). Paragraph starts are non-blank lines at BOF or after blank lines (`^\s*$`). `{` / `}` are navigation-only; brace operator forms (`d{`, `c}`, `y{`, …) are out of scope.

`%` uses a delimiter under the cursor or scans forward on the current logical line. It matches `()`, `[]`, `{}` buffer-wide with lexical, nested, same-delimiter, parser-unaware matching; quotes/comments and mixed delimiters are not special. Missing/unmatched sources no-op. Counts are unsupported: `{count}%` consumes the count and no-ops; counted `d%` / `y%` / `c%` cancel without writes.

---

### character-find motions (normal mode)

A `{count}` prefix finds the Nth occurrence of `{char}` on the line.

| key | action |
|---|---|
| `f{char}` | Jump forward to `char` (inclusive) |
| `F{char}` | Jump backward to `char` (inclusive) |
| `t{char}` | Jump forward to one before `char` (exclusive) |
| `T{char}` | Jump backward to one after `char` (exclusive) |
| `{count}f{char}` | Jump to Nth occurrence of `char` forward |
| `;` | Repeat last `f/F/t/T` motion |
| `,` | Repeat last motion in reverse direction |

Char-find motions compose with operators: `df{char}`, `ct{char}`, `d{count}t{char}`, etc.

---

### edit operators (normal mode)

Register-writing edits write to the unnamed register. With the default clipboard mirror policy, they also mirror to the system clipboard best-effort (clipboard failure never breaks editing).

#### text objects

Text objects compose as `d`/`c`/`y` + `i`/`a` + object. `i` means inner; `a` means around.

| object | keys | range |
|---|---|---|
| word | `iw` / `aw` | Word, punctuation, or whitespace run under the cursor; `aw` adds adjacent whitespace |
| WORD | `iW` / `aW` | Line-local WORD or whitespace run under the cursor; `aW` adds adjacent whitespace |
| quotes | `i"` / `a"`, `i'` / `a'`, <code>i`</code> / <code>a`</code> | Smallest containing quote pair on the line |
| parentheses | `i(` / `a(`; aliases `i)` / `a)`, `ib` / `ab` | Smallest containing pair |
| brackets | `i[` / `a[`; aliases `i]` / `a]` | Smallest containing pair |
| braces | `i{` / `a{`; aliases `i}` / `a}`, `iB` / `aB` | Smallest containing pair |

Semantics:
- Word objects follow Neovim's three character classes — keyword (letters including accented and CJK, digits, `_`), punctuation, and whitespace. `iw` selects the run under the cursor (so on `.` or on a space it takes that run, not the next word), and counts span consecutive runs (`2iw` is a word plus the following whitespace). `aw` on a word adds trailing whitespace, or leading whitespace when there is none; on whitespace it adds the following word. `iW`/`aW` collapse punctuation into the WORD, leaving just non-blank and whitespace runs.
- WORD objects are line-local and whitespace-delimited.
- Quote objects are line-local; odd-backslash escapes are ignored; `a` includes delimiters only, not surrounding whitespace.
- Bracket objects are buffer-aware, nested, lexical, and not parser-aware; brackets inside strings/comments still count.
- Empty inner delimiter objects no-op for delete/yank; change enters Insert at the inner start without writing the register.
- Delimited counts cancel (`d2i"`, `2ci(`, `y2a{`). Counted word/WORD text objects work for delete/change only; counted yank text objects cancel.

#### delete `d{motion}` / `dd`

Prefix and operator counts are both supported as `{count}d{count}{motion}` for
word, WORD, char-find, and linewise motions; the counts multiply and clamp at
`9999`.

| command | deletes |
|---|---|
| `dw` / `de` / `db`; `dW` / `dE` / `dB` | word/WORD motion ranges; `{count}` repeats |
| `d$` / `d0` / `d^`; `{count}d$` | To EOL / BOL / first non-whitespace; a counted `$` spans down through that many line ends |
| `d_` / `dd`; `d{count}_` / `{count}dd` | Current or counted whole lines |
| `d{count}j` / `d{count}k` / `dG` | Linewise down/up/to EOF |
| `df{c}` / `dt{c}` / `dF{c}` / `dT{c}`; `d{count}f{c}` | Char-find ranges |
| `d%` | Inclusive range through the matching pair target |
| `diw` / `daw`; `diW` / `daW` | Inner/around word or WORD |
| `d{count}iw` / `d{count}iW`; `d{count}aw` / `d{count}aW` | Counted word/WORD text objects |
| `di"` / `da"` (`'`, <code>`</code>) | Inside/around quotes |
| `di(` / `da(`, `di[` / `da[`, `di{` / `da{` | Inside/around brackets; aliases `)`, `]`, `}`, `b`, `B` |

#### change `c{motion}` / `cc`

Deletes text then enters Insert mode. `c` supports `%`, `_`, char-find,
word/WORD, text-object, and `0` / `^` / `$` motions (counted `c$` spans line
ends like `d$`). `j`, `k`, `G`, and counted `cc` are unsupported and cancel.

| command | action |
|---|---|
| `cw` / `ce` / `cb`; `cW` / `cE` / `cB` | Change word/WORD motion ranges + Insert |
| `c{count}w/e/b`; `c{count}W/E/B` | Change counted word/WORD motions + Insert |
| `ciw` / `caw`; `ciW` / `caW` | Change word/WORD text objects + Insert |
| `c{count}iw` / `c{count}iW`; `c{count}aw` / `c{count}aW` | Change counted word/WORD text objects + Insert |
| `ci"` / `ca"` (`'`, <code>`</code>) | Change inside/around quotes + Insert |
| `ci(` / `ca(`, `ci[` / `ca[`, `ci{` / `ca{` | Change inside/around brackets + Insert |
| `cc` / `c_`; `c{count}_` | Change current or counted whole lines + Insert |
| `c$` / `c0` / `c^` | Delete to EOL / BOL / first non-whitespace + Insert |
| `c%` | Change inclusive range through the matching pair target + Insert |

#### single-key edits

A `{count}` prefix is supported for `x`, `X`, `p`, `P`. Maximum: `9999`.

| key | action |
|---|---|
| `x` | Delete char under cursor (no-op at/past EOL) |
| `X` | Delete char before cursor (no-op at column 0) |
| `{count}X` | Delete `{count}` chars before cursor, clamping at line start |
| `{count}x` | Delete `{count}` chars |
| `s` | Delete char under cursor + Insert mode |
| `S` | Delete line content + Insert mode |
| `D` | Delete cursor to EOL (captures `\n` if at EOL with next line) |
| `C` | Delete cursor to EOL + Insert mode |
| `r{char}` | Replace char under cursor with `{char}` (stays in Normal) |
| `{count}r{char}` | Replace next `{count}` chars with `{char}` |

#### join lines

| key | action |
|---|---|
| `J` / `{count}J` | Join two or `{count}` lines, normalizing boundary whitespace |
| `gJ` / `{count}gJ` | Join two or `{count}` lines without whitespace normalization |

---

### yank `y{motion}` / `yy`

Same motion set as `d`. Writes to register, **no text mutation**.

| command | yanks |
|---|---|
| `yy` / `Y`; `{count}yy` / `{count}Y` | Whole line(s) + trailing `\n` |
| `y{count}j` / `y{count}k` / `yG`; `y_` / `y{count}_` | Linewise ranges |
| `yw` / `ye` / `yb`; `yW` / `yE` / `yB` | word/WORD motion ranges |
| `y$` / `y0` / `y^`; `yf{c}` | EOL / BOL / first non-whitespace / char-find |
| `y%` | Inclusive range through the matching pair target |
| `yiw` / `yaw`; `yiW` / `yaW` | Inner/around word or WORD |
| `yi"` / `ya"` (`'`, <code>`</code>) | Inside/around quotes |
| `yi(` / `ya(`, `yi[` / `ya[`, `yi{` / `ya{` | Inside/around brackets; aliases `)`, `]`, `}`, `b`, `B` |

Counted `word`/`WORD` yank motions and counted yank text objects (`y2w`,
`2yw`, `y2W`, `2yW`, `y2aw`, `2yaw`, `y2aW`, `y2a{`, …) are intentionally not
implemented and cancel the pending operator. Linewise counted yank (`{count}yy`,
`y{count}j/k`) is supported.

---

### put / paste

| key | action |
|---|---|
| `p` | Put after cursor (char-wise) / new line below (line-wise) |
| `P` | Put before cursor (char-wise) / new line above (line-wise) |
| `{count}p` | Put `{count}` times after cursor |
| `{count}P` | Put `{count}` times before cursor |

Put normally reads the OS clipboard first, but uses the shadow register when the latest mirror was skipped by policy, is still pending, or failed. Paste text ending in `\n` is line-wise. Repeated puts stop at a 512 KiB payload safety cap; one register payload is always inserted whole.

Cursor placement matches Vim except when the first pasted line is all whitespace, where pi-vim lands at column 0. A line-wise put (`yyp`, `yyP`, or any register ending in `\n`) lands on the **first non-blank** of the **first** pasted line, not the end of the pasted text. A char-wise put lands on the **last** inserted character.

---

### undo / redo / repeat

| key | action |
|-----|--------|
| `u` | Undo one change in normal mode |
| `{count}u` | Undo up to `{count}` changes in normal mode; clamps at available history |
| `Ctrl+_` | Undo in normal mode (alias for `u`) |
| `<C-r>` | Redo one undone change in normal mode; safe no-op when redo history is empty |
| `{count}<C-r>` | Redo up to `{count}` undone changes in order; clamps at available history and consumes count state (no leak to the next command) |
| `.` | Repeat the last repeatable normal-mode edit/change (for example `x`, `dw`, `cw...Esc`, `p`, `J`, insert entries like `i...Esc`) |
| `{count}.` | Repeat the last change with `{count}` replacing the stored command count |

One `u` undoes one whole vim change and one `<C-r>` redoes one, matching Neovim: a complete insert session (single- or multi-line, count-prefixed included) is one undo unit, and so is each change command (`cw`, `3dw`, `ved`, `p`, `o`, `r`, …). One `u` reverts it; `<C-r>` restores its buffer text and cursor; each `.` replay is its own unit, separate from the change it repeats. Count-insert *repeat* (`3i…<Esc>` producing `hihihi`) is out of scope; whatever `3i…<Esc>` types today is still one undo unit.

Repeat tracks changes only: motions and yanks preserve the stored change, while mutating visual edits deliberately clear it. Plain `.` preserves the original command count; `{count}.` uses the new count for that replay.

Typing done in an implicit insert session is repeatable too: the prompt opens in insert mode and re-enters it after a submit, so the first keystroke records an `i…<Esc>` change even though no `i` was pressed. A submit (`<Enter>`) is never part of the recording, so a later `.` re-types the run but never resubmits.

---

### visual mode

`v` starts a character-wise selection and `V` a line-wise one, anchored where you pressed the key. Every normal-mode motion listed above moves the cursor and resizes the selection; counts work as usual (`v2ld`, `V2jd`).

| key | action |
|-----|--------|
| `v` | Start a character-wise selection; in Visual mode exit, in V-Line switch to character-wise |
| `V` | Start a line-wise selection; in V-Line exit, in Visual switch to line-wise |
| `Esc` / `Ctrl+[` | Leave visual mode; the cursor stays where it is |
| `o` / `O` | Swap the anchor and the cursor so the other end of the selection moves |
| `d` / `x` | Delete the selection; the cursor lands on its first character |
| `y` | Yank the selection; the cursor rewinds to its start |
| `c` / `s` | Delete the selection and enter Insert mode |
| `D` / `X` | Delete every touched line, even from a character-wise selection |
| `Y` | Yank every touched line |
| `C` / `S` | Replace every touched line with one empty line and enter Insert mode |

**The selection is not highlighted.** The footer reads ` VISUAL ` or ` V-LINE ` and the block cursor marks the moving end, but the span between the anchor and the cursor renders as ordinary text. Selection highlighting needs a render-layer change and is deferred.

Line-wise selections put a trailing newline in the register, so a following `p` pastes whole lines. A count typed before `v` or `V` is discarded rather than sizing the selection (`2v` behaves as `v`).

Visual-mode edits are deliberately **not** dot-repeatable: running one clears the stored repeatable command, so a later `.` does nothing instead of replaying an unrelated change. Keys with no visual-mode meaning here — `p`, `P`, `r`, `J`, `u`, `<C-r>`, `.`, `:`, `i`, `a`, `A`, `I`, `~`, `>`, `<` — are inert while a selection is live rather than falling through to their normal-mode behaviour.

---

## settings reference

Settings are read from `~/.pi/agent/settings.json` and project `.pi/settings.json`. All keys are optional; omitting `piVim` is equivalent to the defaults. Project settings override global for `clipboardMirror`, `exCommand.piDispatch`, `modeColors`, `borderSync`, and `labelSync` (each replaced as a whole object, missing modes defaulting below); `modeChange` and `exCommand.copyInputToClipboard` are user-global only — `modeChange` because it executes shell commands.

Default-equivalent `settings.json`:

```json
{
  "piVim": {
    "clipboardMirror": "all",
    "exCommand": {
      "piDispatch": true,
      "copyInputToClipboard": false
    },
    "modeColors": {
      "insert": "borderMuted",
      "normal": "borderAccent",
      "visual": "customMessageLabel",
      "ex": "warning"
    },
    "borderSync": {
      "insert": "host",
      "normal": "host",
      "visual": "host",
      "ex": "host"
    },
    "labelSync": {
      "insert": "mode",
      "normal": "mode",
      "visual": "mode",
      "ex": "mode"
    }
  }
}
```

### clipboardMirror

`all` mirrors unnamed writes; `yank` mirrors yanks; `never` keeps writes internal. Non-mirrored writes stay local for `p` / `P`. See [register and clipboard policy](#register-and-clipboard-policy) for the full read/write contract.

### exCommand

`exCommand.piDispatch`: `true` lets the ex line run Pi slash commands (see [pi-command bridge](#pi-command-bridge)); `false` restores a quit-only ex line. `piDispatch` is read from project settings too: the bridge only reaches commands Pi already trusts, so it grants no capability a project file could not already use.

`exCommand.copyInputToClipboard`: `false` leaves the clipboard alone; `true` copies the non-empty composed prompt to the OS clipboard before each dispatch, as a safety net if a command clears the prompt. It is read only from the user-global settings file — writing the prompt to the OS clipboard is an exfiltration capability, so a checked-in project file must not be able to turn it on.

### borderSync and labelSync

`borderSync` and `labelSync` set a per-mode paint policy for two surfaces: `borderSync` for Pi's input border, `labelSync` for the footer mode label. Each maps the mode keys `insert`, `normal`, `visual`, `ex` to one of three values:

| value | effect |
|---|---|
| `mode` | always paint that mode's color (from `modeColors`) |
| `host` | always show the host's current border color |
| `thinking` | show the host color while its border is away from the resting default, otherwise paint the mode color |

Defaults: every `borderSync` mode is `host`, so Pi's border is left untouched; every `labelSync` mode is `mode`, so the label always carries its mode color. Each map is replaced as a whole object; modes you omit fall back to these defaults.

`thinking` keys on the host border being away from its neutral resting ("thinking off") color, so any non-resting border counts — a raised thinking level, bash-mode's border, or another extension's highlight. Detection is an exact match against Pi's `thinkingOff` color, not a saturation guess, so it leaves the gray `minimal` level alone too.

Paint the visual-mode border with its own color while leaving every other mode on the host:

```json
{
  "piVim": {
    "borderSync": { "visual": "mode" }
  }
}
```

Give insert a solid mode color, let normal defer to thinking, and make both mode labels follow the thinking state:

```json
{
  "piVim": {
    "borderSync": { "insert": "mode", "normal": "thinking" },
    "labelSync": { "insert": "thinking", "normal": "thinking" }
  }
}
```

`syncBorderColorWithMode` is deprecated but still accepted: `false` (or absent) is the defaults; `true` sets `borderSync` to `mode` for every mode; the never-released `"inherit"` sets both `borderSync` and `labelSync` to `thinking` for every mode. A present `borderSync` or `labelSync` wins over it for that surface.

### modeColors

`piVim.modeColors` accepts Pi theme foreground tokens. Missing, invalid, or unknown tokens use the defaults above.

`visual` colors both VISUAL and V-LINE (the footer label already tells them apart); its `customMessageLabel` default is the purple/violet token both bundled themes ship, keeping visual distinct from normal's `borderAccent`. Override it like any other mode.

Usual/safest tokens: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`.

### escapeSequence

`piVim.escapeSequence` lets Insert mode also be left by typing a short character sequence (default `jk`) within a timeout, mirroring Vim's `inoremap {seq} <Esc>` + `timeoutlen`. There's no `enabled` flag: setting it at all turns it on, and leaving it unset keeps it off.

```json
{ "piVim": { "escapeSequence": "jk" } }
```

Use an object to also override the timeout: `{ "escapeSequence": { "sequence": "jk", "timeoutMs": 300 } }`. `sequence` must be 2–8 printable non-whitespace ASCII characters (e.g. `kj`, `jj`, `fd`, `;;`); an invalid value falls back to `"jk"` with a warning. `timeoutMs` defaults to `300`, clamped `50–2000`. A mismatched key, the timeout elapsing, or a real `Esc` types the buffered prefix as ordinary text instead of escaping. Read from project settings too, like `exCommand.piDispatch`.

### modeChange

`modeChange`: user-global shell commands run on mode transitions. `insert` runs on every transition into Insert; `normal` runs on every transition into a non-Insert editing mode — Normal, Visual, and V-Line alike. Both keys are optional. The command runs asynchronously via the system shell, stdio is discarded, failures are silenced, and a hung command is timed out so editing never blocks or breaks. If mode changes happen while a hook command is still running, pi-vim keeps only the latest pending command. Hooks fire only on actual transitions: not on the initial mode, not on EX entry/exit (EX is a sub-state of normal), and not on no-op `Esc` from normal. Because this is arbitrary shell, project `.pi/settings.json` values are ignored. pi-vim also emits `pi-vim:mode-change` on `pi.events` with `{ mode, previousMode }` for other extensions.

A typical use is automatic IME switching. Point `modeChange` at any CLI that switches your input method. For example, `im-select` prints your current IME id when run with no arguments; plug the ids into the config (another tool has its own syntax):

```json
{
  "piVim": {
    "modeChange": {
      "insert": "im-select im.rime.inputmethod.Squirrel.Hans",
      "normal": "im-select com.apple.keylayout.ABC"
    }
  }
}
```

pi-vim does not bundle any such tool and does not care which one you use — any shell command works.

---

## register and clipboard policy

- `piVim.clipboardMirror = "all"` is the default: every unnamed-register write mirrors to the OS clipboard best-effort.
- `piVim.clipboardMirror = "yank"` mirrors yanks only; deletes and changes update only pi-vim's internal shadow.
- `piVim.clipboardMirror = "never"` disables write mirroring while keeping internal register writes synchronous.
- Rapid mirrored writes coalesce: only the latest pending value is guaranteed to be mirrored.
- `p` / `P` read the OS clipboard first when no local write was skipped by policy, falling back to the shadow on read failure/timeout.
- If policy skipped the last local write, `p` / `P` use the shadow so delete/yank → put works without touching the OS clipboard.
- While a mirror is in flight, `p` / `P` use the shadow so immediate yank/delete → put stays ordered.
- If the last mirror write failed or was skipped by the mirror circuit breaker, `p` / `P` use the non-empty shadow until a mirror write lands again, so put never trusts a stale OS clipboard.
- Pi owns the terminal clipboard backends; on Wayland external state may lag while the shadow stays authoritative for immediate puts.

---

## limits and vim differences

| area | this extension | full Vim |
|---|---|---|
| Visual `$` motion | Moves to the visible EOL position | Moves to the last character |
| Line-wise put onto an all-whitespace first line | Lands at col 0 (shares the `^`/`I` all-whitespace behavior) | `^` lands on the last char of the line |
| Undo / redo | Vim-change-scoped: one `u` reverts one whole vim change (insert session or change command), one `<C-r>` redoes it, and `.` is its own unit; a linear undo/redo list, no undo tree | Full per-change undo tree with `g+`/`g-`/`:earlier` time-travel |
| Visual mode | `v` and `V` with `d`/`x`, `y`, `c`/`s` and the line-forcing `D`/`X`/`Y`/`C`/`S`; no `<C-v>`, no visual `p`/`r`/`J`/`~`/`>`/`<`/`gv`, no text objects, no `{count}v` | `v`, `V`, `<C-v>` with the full operator set |
| Visual selection rendering | No highlight; only the footer label and the block cursor mark the selection | Selection is highlighted |
| Visual line-wise delete | Leaves the cursor at column 0, like `dd` does today | Preserves the cursor column |
| Visual dot-repeat | A visual edit clears the repeatable command; `.` afterwards does nothing | `.` repeats the operator over an equally sized region |
| Text objects | `iw` / `aw`, `iW` / `aW`, quote objects, and paren/bracket/brace objects; delimited counts cancel | Full text-object set |
| `%` matching | `()`, `[]`, `{}` only; lexical same-delimiter matching with no counts, quote/angle matching, parser/matchit logic, or mixed-delimiter validation | Also supports percentage jumps and broader matching |
| Count prefix | Operators, motions, navigation, `x`, `r`, `p`, `P`; capped at `MAX_COUNT=9999` | Full support |
| Named registers / macros / search | Not implemented; the unnamed register is supported | Supported |
| Ex commands | EX mini-mode quits (`:q`, `:qa`, `:quit`, `:qall`, `:quitall`, and their `!` forms), dispatches non-conflicting Pi slash commands (`:tree`, `:model opus`), and runs shell commands via `:!cmd`; vim ex semantics are reserved, not implemented | Full ex command-line surface |
| Multi-line operators | `d/c/y` with `w/e/b`, `W/E/B`, `j/k`, and `G`; not the full Vim motion matrix | Rich cross-line semantics |

---

Also out of scope (not already covered by a row above):

- Tag (`it`, `at`), paragraph/sentence (`ip`, `ap`, `is`, `as`), and angle-bracket (`i<`, `a<`) text objects
- Vim ex-command semantics (`:s`, `:g`, `:w`, `:r`, …) — those names are reserved; the ex line supports quit flows, known Pi commands, and `:!cmd`, not vim ex semantics
- Ex-line completion of Pi command names, and `::name` force-dispatch of a reserved name
- Replace mode (`R`) — only `r{char}` is supported
- Insert-mode `<C-r>` register expansion; cross-session redo persistence
- Window / tab / buffer management, plugin ecosystem compatibility

---

## development and integration

### wrapping pi-vim

- Supported extension order: `pi-vim` first, `@jordyvd/pi-image-attachments` second. pi-vim does not wrap previous editors.
- Wrappers decorate in place or forward the CustomEditor surface: lifecycle (`handleInput`, `render`, `invalidate`), text (`getText`, `setText`, `insertTextAtCursor`, `getExpandedText`), callbacks, `actionHandlers`, flags, and reads (`getLines`, `getCursor`, `getMode()`). `getMode()` returns `normal`, `insert`, `visual`, or `visual-line`, so a wrapper can tell the two visual sub-modes apart.
- Inverse order, insert delegates, and generic composition are unsupported.

Smoke:

```bash
pi -e ./index.ts -e ../pi-image-attachments/index.ts
pi -e ./index.ts -e ../../../pi-image-attachments/index.ts
```

Check: insert text; add/paste image path; see `[Image #1]`; submit text+image stripped; switch INSERT/NORMAL.

### contributor setup

Hooks install with `npm install` after cloning. To wire them explicitly:

```bash
npm run hooks:install
```

Run checks with `npm run check`. `index.ts` handles modal keys; `motions.ts` and `text-objects.ts` hold pure range logic; `types.ts` holds shared types/constants; `test/` uses Node's runner.
