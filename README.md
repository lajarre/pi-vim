# pi-vim

Modal vim-like editing for Pi's input prompt. Covers the high-frequency 90% command surface.

## install

```bash
pi install npm:pi-vim
```

Restart Pi after install.

## contributor setup

Hooks install with `npm install` after cloning. To wire them explicitly:

```bash
npm run hooks:install
```

## stats

- **116 commands**: motions, operators, counts, text objects, undo/redo, ex quit
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

Mode indicator (`INSERT` / `NORMAL` / `EX`) appears at bottom-right,
theme-colored (reverse `borderMuted` / `borderAccent` / `warning`).

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

A `{count}` prefix can be prepended to any navigation key (max: `9999`).

| key           | action                        |
|---------------|-------------------------------|
| `h`           | Left                          |
| `l`           | Right                         |
| `j`           | Down                          |
| `k`           | Up                            |
| `{count}h/l`  | Move left/right `{count}` cols  |
| `{count}j/k`  | Move down/up `{count}` lines (clamped to buffer size) |
| `0`           | Line start                    |
| `^`           | First non-whitespace char of line |
| `_`           | First non-whitespace char; with `{count}`, move down `count - 1` lines first |
| `$`           | Line end                      |
| `gg`          | Buffer start (line 1)         |
| `{count}gg`   | Go to line `{count}` (1-indexed, clamped) |
| `G`           | Buffer end (last line)        |
| `{count}G`    | Go to line `{count}` (1-indexed, clamped) |
| `w`           | Next `word` start (keyword/punctuation aware) |
| `b`           | Previous `word` start         |
| `e`           | `word` end (inclusive)        |
| `W`           | Next `WORD` start (whitespace-delimited token) |
| `B`           | Previous `WORD` start         |
| `E`           | `WORD` end (inclusive)        |
| `{count}w/b/e`| Move `{count}` `word` motions |
| `{count}W/B/E`| Move `{count}` `WORD` motions |
| `}`           | Move to next paragraph start (line start col `0`) |
| `{`           | Move to previous paragraph start (line start col `0`) |
| `{count}}`    | Repeat `}` `{count}` times |
| `{count}{`    | Repeat `{` `{count}` times |

`word` (`w/b/e`) splits punctuation from keyword chars. `WORD` (`W/B/E`)
treats any non-whitespace run as one token (`foo-bar`, `path/to`, `x.y`).

Paragraph boundary:
- blank line matches `^\s*$`
- paragraph start = non-blank at BOF, or non-blank line after a blank line

`{` / `}` are navigation-only (no text/register mutation); counted forms step
paragraph-by-paragraph and clamp at BOF/EOF. Brace operator forms (`d{`, `c}`, `y{`, …) are out of scope.

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

All operators write to the unnamed register and mirror to the system clipboard
(best-effort; clipboard failure never breaks editing).

#### delete `d{motion}` / `dd`

A `{count}` or dual-count prefix (`{pfx}d{op}{motion}`) is supported for
word, char-find, and linewise motions. Maximum total count: `9999`.

| command           | deletes                                                   |
|-------------------|-----------------------------------------------------------|
| `dw`              | Forward to next `word` start (exclusive, can cross lines) |
| `de`              | Forward to `word` end (inclusive, can cross lines)        |
| `db`              | Backward to `word` start (exclusive, can cross lines)     |
| `dW`              | Forward to next `WORD` start (exclusive, can cross lines) |
| `dE`              | Forward to `WORD` end (inclusive, can cross lines)        |
| `dB`              | Backward to `WORD` start (exclusive, can cross lines)     |
| `d{count}w/e/b`   | Forward/backward `{count}` `word` motions                 |
| `d{count}W/E/B`   | Forward/backward `{count}` `WORD` motions                 |
| `d$`              | To end of line                                            |
| `d0`              | To start of line                                          |
| `d^`              | To first non-whitespace char of line                      |
| `d_`              | Current line (linewise, same as `dd`)                     |
| `d{count}_`       | `{count}` lines (linewise, same as `{count}dd`)           |
| `dd`              | Current line (linewise)                                   |
| `{count}dd`       | `{count}` lines (linewise)                                |
| `d{count}j`       | Current line + `{count}` lines below (linewise)           |
| `d{count}k`       | Current line + `{count}` lines above (linewise)           |
| `dG`              | Current line to end of buffer (linewise)                  |
| `df{char}`        | To and including `char`                                   |
| `d{count}f{char}` | To and including Nth `char`                               |
| `dt{char}`        | Up to (not including) `char`                              |
| `dF{char}`        | Backward to and including `char`                          |
| `dT{char}`        | Backward to one after `char`                              |
| `diw`             | Inner word                                                |
| `daw`             | Around word (includes surrounding spaces)                 |
| `d{count}aw`      | Around `{count}` words                                    |

#### change `c{motion}` / `cc`

Same motion and count set as `d`. Deletes text then enters Insert mode.

| command         | action                             |
|-----------------|------------------------------------|
| `cw`            | Change `word` + Insert                        |
| `ce` / `cb`     | Change to `word` end / previous `word` start  |
| `cW`            | Change `WORD` + Insert (`cW` on non-space behaves like `cE`) |
| `cE` / `cB`     | Change to `WORD` end / previous `WORD` start  |
| `c{count}w/e/b` | Change `{count}` `word` motions + Insert      |
| `c{count}W/E/B` | Change `{count}` `WORD` motions + Insert      |
| `ciw`           | Change inner word                             |
| `caw`           | Change around word                            |
| `cc`            | Delete line content + Insert                  |
| `c_`            | Change line (linewise, same as `cc`)                  |
| `c{count}_`     | Change `{count}` lines (linewise)                     |
| `c$` / `c0` / `c^` | Delete to EOL / BOL / first non-whitespace + Insert |
| …               | All `d` motions apply                         |

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

| command | yanks                           |
|---------|---------------------------------|
| `yy`         | Whole line + trailing `\n`                     |
| `Y`          | Whole line + trailing `\n` (same as `yy`)      |
| `{count}yy`  | `{count}` whole lines + trailing `\n`          |
| `{count}Y`   | `{count}` whole lines + trailing `\n` (same as `{count}yy`) |
| `y{count}j`  | Current line + `{count}` lines below (linewise) |
| `y{count}k`  | Current line + `{count}` lines above (linewise) |
| `yG`         | Current line to end of buffer (linewise)         |
| `yw`         | Forward to next `word` start                      |
| `ye`         | To `word` end (inclusive)                         |
| `yb`         | Backward to `word` start                          |
| `yW`         | Forward to next `WORD` start                      |
| `yE`         | To `WORD` end (inclusive)                         |
| `yB`         | Backward to `WORD` start                          |
| `y$`         | To end of line                                    |
| `y0`         | To start of line                                  |
| `y^`         | To first non-whitespace char of line              |
| `y_`         | Whole line (linewise, same as `yy`)               |
| `y{count}_`  | `{count}` whole lines (linewise)                  |
| `yf{c}`      | To and including `char`                           |
| `yiw`        | Inner word                                        |
| `yaw`        | Around word (includes spaces)                     |

Counted `word`/`WORD` yank (`y2w`, `2yw`, `y2W`, `2yW`, …) is intentionally
not implemented and cancels the pending operator. Linewise counted yank
(`{count}yy`, `y{count}j/k`) is supported.

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

- Unnamed register is OS-backed by default (roughly Vim's `clipboard=unnamed`).
- `d` / `c` / `y` write a synchronous internal shadow, then mirror to the OS clipboard best-effort.
- Rapid writes coalesce: only the latest pending value is guaranteed to be mirrored.
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
| Text objects | `iw` / `aw` only | Full text-object set |
| Count prefix | Operators, motions, navigation, `x`, `r`, `p`, `P`; capped at `MAX_COUNT=9999` | Full support |
| Registers / macros / search | Not implemented | Supported |
| Ex commands | Quit-only EX mini-mode (`:q`, `:q!`, `:qa`, `:qa!`) | Full ex command-line surface |
| Multi-line operators | `d/c/y` with `w/e/b`, `W/E/B`, `j/k`, and `G`; not the full Vim motion matrix | Rich cross-line semantics |

---

## out of scope

Explicitly deferred:

- Visual modes (`v`, `V`, block visual)
- Text objects beyond word (`ip`, `i"`, `i(`, …)
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
