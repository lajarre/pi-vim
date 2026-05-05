# pi-vim

Modal vim-like editing for Pi's input prompt. Covers the high-frequency 90% command surface.

## install

```bash
pi install npm:pi-vim
```

Restart Pi after install.

## configure

pi-vim reads persistent Pi settings from `~/.pi/agent/settings.json` and project `.pi/settings.json`.

Clipboard write mirroring is controlled by `piVim.clipboardMirror`:

```json
{
  "piVim": {
    "clipboardMirror": "all"
  }
}
```

| value | behavior |
|-------|----------|
| `all` | Mirror every unnamed-register write (default/current behavior) |
| `yank` | Mirror yanks only; deletes/changes update only pi-vim's internal register |
| `never` | Never mirror register writes to the OS clipboard |

The setting controls write mirroring only. `p` / `P` keep the paste policy documented below.

Mode indicator and optional input-border colors are controlled by `piVim.modeIndicatorColors`, `piVim.syncBorderColorWithMode`, and `piVim.inputBorderModeColors`:

```json
{
  "piVim": {
    "modeIndicatorColors": {
      "insert": "borderMuted",
      "normal": "borderAccent",
      "ex": "warning"
    },
    "syncBorderColorWithMode": true,
    "inputBorderModeColors": {
      "insert": "borderMuted",
      "normal": "borderAccent",
      "ex": "warning"
    }
  }
}
```

Each color object may define `insert`, `normal`, and `ex`. Project settings override global settings per mode. Color values may be Pi theme color tokens or `#RRGGBB` hex colors.

Input-border color syncing is disabled by default and requires `syncBorderColorWithMode: true`. When enabled, the editor border follows mode indicator colors unless `inputBorderModeColors` defines separate per-mode colors.

## contributor setup

Hooks install with `npm install` after cloning. To wire them explicitly:

```bash
npm run hooks:install
```

## stats

- **188 commands**: motions, operators, counts, text objects, undo/redo, ex quit
- **sub-µs word motions** via precomputed boundary cache (~4ms startup, ~150KB memory)
- **0 dependencies**

## 30-second quickstart

Try on multi-line input:

```text
Esc        # NORMAL mode
3gg        # jump to absolute line 3
2dw        # delete two words
u          # undo
<C-r>      # redo last undone edit (safe no-op when empty)
2}         # jump two paragraphs forward
```

Mode indicator (`INSERT` / `NORMAL` / `EX`) appears bottom-right, theme-colored and configurable.

Requires `@mariozechner/pi-tui >= 0.47.0`. With `pi-tui >= 0.49.3` and DECSCUSR support, cursor shape follows mode; otherwise software cursor remains.

## why pi-vim

- Fast modal editing without leaving Pi.
- Count-aware motions/operators (`2dw`, `3G`, `d2j`, `2}`).
- REPL-focused defaults; out-of-scope boundaries documented.
- Clipboard/register behavior is explicit and tested.

Use pi-vim for fast Vim muscle-memory in Pi prompts. Skip it if you need
full Vim parity (visual mode, macros, search, extended ex-commands, …).

## common recipes

| goal | keys |
|------|------|
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
| Undo last edit | `u` |
| Redo last undone edit | `<C-r>` |

---

## full reference

### mode switching

| key      | action                                 |
|----------|----------------------------------------|
| `Esc` / `Ctrl+[` | Insert → Normal mode                   |
| `Esc` / `Ctrl+[` | Normal mode → pass to Pi (aborts the agent under default Pi keybindings) |
| `:`      | Normal → EX mini-mode                   |
| `i`      | Normal → Insert at cursor              |
| `a`      | Normal → Insert after cursor           |
| `I`      | Normal → Insert at first non-whitespace |
| `A`      | Normal → Insert at line end            |
| `o`      | Normal → open line below + Insert      |
| `O`      | Normal → open line above + Insert      |

Optional: heavy users may want to move Pi's `app.interrupt` off bare `escape` in `~/.pi/agent/keybindings.json` since it overlaps with Insert→Normal. Pick your own replacement; user config overrides defaults.

#### ex mini-mode

Quit-only ex flows.

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
| unsupported `:{cmd}` | Show warning notification; no quit |

Insert-mode shortcuts (stay in Insert mode):

| key             | action                 |
|-----------------|------------------------|
| `Shift+Alt+A`   | Go to end of line      |
| `Shift+Alt+I`   | Go to start of line    |
| `Alt+o`         | Open line below        |
| `Alt+Shift+O`   | Open line above        |

---

### navigation (normal mode)

A `{count}` prefix can be prepended to navigation keys (max: `9999`).

| key | action |
|-----|--------|
| `h` / `l` / `j` / `k`; `{count}h/l/j/k` | Move left/right/down/up; line moves clamp to the buffer |
| `0` / `^` / `_` / `$` | Line start / first non-whitespace / counted first non-whitespace / line end |
| `gg` / `G`; `{count}gg` / `{count}G` | Buffer start/end or absolute 1-indexed line |
| `w` / `b` / `e`; `{count}w/b/e` | `word` start/back/end motions |
| `W` / `B` / `E`; `{count}W/B/E` | whitespace-delimited `WORD` motions |
| `{` / `}`; `{count}{` / `{count}}` | Previous/next paragraph start |

`word` splits punctuation from keyword chars; `WORD` treats any non-whitespace run as one token (`foo-bar`, `path/to`). Paragraph starts are non-blank lines at BOF or after blank lines (`^\s*$`). `{` / `}` are navigation-only; brace operator forms (`d{`, `c}`, `y{`, …) are out of scope.

---

### character-find motions (normal mode)

A `{count}` prefix finds the Nth occurrence of `{char}` on the line.

| key              | action                                         |
|------------------|------------------------------------------------|
| `f{char}`        | Jump forward to `char` (inclusive)             |
| `F{char}`        | Jump backward to `char` (inclusive)            |
| `t{char}`        | Jump forward to one before `char` (exclusive)  |
| `T{char}`        | Jump backward to one after `char` (exclusive)  |
| `{count}f{char}` | Jump to Nth occurrence of `char` forward       |
| `;`              | Repeat last `f/F/t/T` motion                   |
| `,`              | Repeat last motion in reverse direction         |

Char-find motions compose with operators: `df{char}`, `ct{char}`, `d{count}t{char}`, etc.

---

### edit operators (normal mode)

Register-writing edits write to the unnamed register. With the default clipboard mirror policy, they also mirror to the system clipboard best-effort (clipboard failure never breaks editing).

#### text objects

Text objects compose as `d`/`c`/`y` + `i`/`a` + object. `i` means inner; `a` means around.

| object | keys | range |
|--------|------|-------|
| word | `iw` / `aw` | Keyword word; `aw` includes spaces |
| WORD | `iW` / `aW` | Line-local whitespace-delimited WORD; `aW` includes adjacent whitespace |
| quotes | `i"` / `a"`, `i'` / `a'`, <code>i`</code> / <code>a`</code> | Smallest containing quote pair on the line |
| parentheses | `i(` / `a(`; aliases `i)` / `a)`, `ib` / `ab` | Smallest containing pair |
| brackets | `i[` / `a[`; aliases `i]` / `a]` | Smallest containing pair |
| braces | `i{` / `a{`; aliases `i}` / `a}`, `iB` / `aB` | Smallest containing pair |

Semantics:
- WORD objects are line-local and whitespace-delimited.
- Quote objects are line-local; odd-backslash escapes are ignored; `a` includes delimiters only, not surrounding whitespace.
- Bracket objects are buffer-aware, nested, lexical, and not parser-aware; brackets inside strings/comments still count.
- Empty inner delimiter objects no-op for delete/yank; change enters Insert at the inner start without writing the register.
- Delimited counts cancel (`d2i"`, `2ci(`, `y2a{`). Counted word/WORD text objects work for delete/change only; counted yank text objects cancel.

#### delete `d{motion}` / `dd`

A `{count}` or dual-count prefix (`{pfx}d{op}{motion}`) is supported for word,
WORD, char-find, and linewise motions. Maximum total count: `9999`.

| command | deletes |
|---------|---------|
| `dw` / `de` / `db`; `dW` / `dE` / `dB` | word/WORD motion ranges; `{count}` repeats |
| `d$` / `d0` / `d^` | To EOL / BOL / first non-whitespace |
| `d_` / `dd`; `d{count}_` / `{count}dd` | Current or counted whole lines |
| `d{count}j` / `d{count}k` / `dG` | Linewise down/up/to EOF |
| `df{c}` / `dt{c}` / `dF{c}` / `dT{c}`; `d{count}f{c}` | Char-find ranges |
| `diw` / `daw`; `diW` / `daW` | Inner/around word or WORD |
| `d{count}iw` / `d{count}iW`; `d{count}aw` / `d{count}aW` | Counted word/WORD text objects |
| `di"` / `da"` (`'`, <code>`</code>) | Inside/around quotes |
| `di(` / `da(`, `di[` / `da[`, `di{` / `da{` | Inside/around brackets; aliases `)`, `]`, `}`, `b`, `B` |

#### change `c{motion}` / `cc`

Same motion and count set as `d`. Deletes text then enters Insert mode.

| command | action |
|---------|--------|
| `cw` / `ce` / `cb`; `cW` / `cE` / `cB` | Change word/WORD motion ranges + Insert |
| `c{count}w/e/b`; `c{count}W/E/B` | Change counted word/WORD motions + Insert |
| `ciw` / `caw`; `ciW` / `caW` | Change word/WORD text objects + Insert |
| `c{count}iw` / `c{count}iW`; `c{count}aw` / `c{count}aW` | Change counted word/WORD text objects + Insert |
| `ci"` / `ca"` (`'`, <code>`</code>) | Change inside/around quotes + Insert |
| `ci(` / `ca(`, `ci[` / `ca[`, `ci{` / `ca{` | Change inside/around brackets + Insert |
| `cc` / `c_`; `c{count}_` | Change current or counted whole lines + Insert |
| `c$` / `c0` / `c^` | Delete to EOL / BOL / first non-whitespace + Insert |
| … | All `d` motions apply |

#### single-key edits

A `{count}` prefix is supported for `x`, `p`, `P`. Maximum: `9999`.

| key          | action                                                        |
|--------------|---------------------------------------------------------------|
| `x`          | Delete char under cursor (no-op at/past EOL)                  |
| `{count}x`   | Delete `{count}` chars                                        |
| `s`          | Delete char under cursor + Insert mode                        |
| `S`          | Delete line content + Insert mode                             |
| `D`          | Delete cursor to EOL (captures `\n` if at EOL with next line) |
| `C`          | Delete cursor to EOL + Insert mode                            |
| `r{char}`    | Replace char under cursor with `{char}` (stays in Normal)     |
| `{count}r{char}` | Replace next `{count}` chars with `{char}`               |

---

### yank `y{motion}` / `yy`

Same motion set as `d`. Writes to register, **no text mutation**.

| command | yanks |
|---------|-------|
| `yy` / `Y`; `{count}yy` / `{count}Y` | Whole line(s) + trailing `\n` |
| `y{count}j` / `y{count}k` / `yG`; `y_` / `y{count}_` | Linewise ranges |
| `yw` / `ye` / `yb`; `yW` / `yE` / `yB` | word/WORD motion ranges |
| `y$` / `y0` / `y^`; `yf{c}` | EOL / BOL / first non-whitespace / char-find |
| `yiw` / `yaw`; `yiW` / `yaW` | Inner/around word or WORD |
| `yi"` / `ya"` (`'`, <code>`</code>) | Inside/around quotes |
| `yi(` / `ya(`, `yi[` / `ya[`, `yi{` / `ya{` | Inside/around brackets; aliases `)`, `]`, `}`, `b`, `B` |

Counted `word`/`WORD` yank motions and counted yank text objects (`y2w`,
`2yw`, `y2W`, `2yW`, `y2aw`, `2yaw`, `y2aW`, `y2a{`, …) are intentionally not
implemented and cancel the pending operator. Linewise counted yank (`{count}yy`,
`y{count}j/k`) is supported.

---

### put / paste

| key          | action                                                      |
|--------------|-------------------------------------------------------------|
| `p`          | Put after cursor (char-wise) / new line below (line-wise)   |
| `P`          | Put before cursor (char-wise) / new line above (line-wise)  |
| `{count}p`   | Put `{count}` times after cursor                            |
| `{count}P`   | Put `{count}` times before cursor                           |

Put reads the OS clipboard first, falling back to the internal unnamed-register shadow on slow read.
Paste text ending in `\n` is treated as line-wise.

---

### undo / redo

| key | action |
|-----|--------|
| `u` | Undo one change in normal mode |
| `{count}u` | Undo up to `{count}` changes in normal mode; clamps at available history |
| `Ctrl+_` | Undo in normal mode (alias for `u`) |
| `<C-r>` | Redo one undone change in normal mode; safe no-op when redo history is empty |
| `{count}<C-r>` | Redo up to `{count}` undone changes in order; clamps at available history and consumes count state (no leak to the next command) |

---

## register and clipboard policy

- `piVim.clipboardMirror = "all"` is the default: every unnamed-register write mirrors to the OS clipboard best-effort.
- `piVim.clipboardMirror = "yank"` mirrors yanks only; deletes and changes update only pi-vim's internal shadow.
- `piVim.clipboardMirror = "never"` disables write mirroring while keeping internal register writes synchronous.
- Rapid mirrored writes coalesce: only the latest pending value is guaranteed to be mirrored.
- `p` / `P` read the OS clipboard first, falling back to the shadow on read failure/timeout.
- While a mirror is in flight, `p` / `P` use the shadow so immediate yank/delete → put stays ordered.
- Pi owns the terminal clipboard backends; on Wayland external state may lag while the shadow stays authoritative for immediate puts.

---

## known differences from full Vim

| area | this extension | full Vim |
|------|----------------|----------|
| `$` motion | Moves past the last char (readline `Ctrl+E`) | Moves to the last char |
| `w` / `e` / `b` + `W` / `E` / `B` | Cross-line for both `word` and `WORD` motions | Cross-line |
| `0` / `$` operators | Exclusive of the anchor col | `0` is inclusive of col 0 |
| Undo / redo | Delegates undo to readline; normal-mode `<C-r>` redo is supported | Full per-change undo tree |
| Visual mode | Not implemented | `v`, `V`, `<C-v>` |
| Text objects | `iw` / `aw`, `iW` / `aW`, quote objects, and paren/bracket/brace objects; delimited counts cancel | Full text-object set |
| Count prefix | Operators, motions, navigation, `x`, `r`, `p`, `P`; capped at `MAX_COUNT=9999` | Full support |
| Registers / macros / search | Not implemented | Supported |
| Ex commands | Quit-only EX mini-mode (`:q`, `:q!`, `:qa`, `:qa!`) | Full ex command-line surface |
| Multi-line operators | `d/c/y` with `w/e/b`, `W/E/B`, `j/k`, and `G`; not the full Vim motion matrix | Rich cross-line semantics |

---

## out of scope

Explicitly deferred:

- Visual modes (`v`, `V`, block visual)
- Tag text objects (`it`, `at`)
- Paragraph/sentence text objects (`ip`, `ap`, `is`, `as`)
- Angle bracket text objects (`i<`, `a<`)
- Visual-mode text-object selection
- Parser-aware delimiter matching
- Delimited-object counts (`d2i"`, `2ci(`, `y2a{`)
- Named registers (`"a`, `"b`, …), macros (`q{char}`, `@{char}`)
- Ex surface beyond quit (`:s`, `:g`, `:w`, `:r`, …)
- Search (`/`, `?`, `n`, `N`), repeat (`.`)
- Replace mode (`R`) — only `r{char}` is supported
- Count prefix beyond currently supported motions
- No insert-mode `<C-r>` expansion, no cross-session redo persistence
- No upstream `pi-tui` redo prerequisite
- Window / tab / buffer management, plugin ecosystem compatibility

---

## architecture notes

- `index.ts` — `ModalEditor` subclass of `CustomEditor`; all key handling.
- `motions.ts` — pure motion calculation helpers (`findWordMotionTarget`,
  `findCharMotionTarget`); no side effects.
- `types.ts` — shared types and escape-sequence constants.
- `test/` — Node test runner suite; no browser / full runtime required.

Run checks:

```
cd pi-vim
npm run check
```
