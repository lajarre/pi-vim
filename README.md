# pi-vim

Modal vim-like editing for Pi's input prompt. Covers the high-frequency 90% command surface.

## why

You love Pi, you love Vim, you'll love pi-vim.

## install

```bash
pi install npm:pi-vim
```

Restart Pi after install.

## stats

- **112 commands**: motions, operators, counts, text objects, undo/redo
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

Mode indicator (`INSERT` / `NORMAL`) appears at bottom-right.
Its label is theme-colored: reverse-video `borderMuted` for
INSERT, `borderAccent` for NORMAL.

## why pi-vim

- Fast modal editing without leaving Pi.
- Count-aware motions/operators (`2dw`, `3G`, `d2j`, `2}`).
- Strong REPL-focused defaults; safe out-of-scope boundaries documented.
- Clipboard/register behavior is explicit and tested.

## for you / not for you

Use pi-vim if you want fast Vim muscle-memory in Pi prompts.
Skip it if you need full Vim feature parity (visual mode, macros, search,
ex-commands, etc.).

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
| `Esc` / `Ctrl+[` | Normal mode → pass to Pi (abort agent) |
| `i`      | Normal → Insert at cursor              |
| `a`      | Normal → Insert after cursor           |
| `I`      | Normal → Insert at first non-whitespace |
| `A`      | Normal → Insert at line end            |
| `o`      | Normal → open line below + Insert      |
| `O`      | Normal → open line above + Insert      |

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

Paragraph boundary definition (this extension wave):
- blank line: matches `^\s*$`
- paragraph start: non-blank line at BOF, or non-blank line immediately after a blank line

Standalone `{` / `}` motions are navigation-only (no text/register mutation).
Counted forms (`{count}{`, `{count}}`) step paragraph-by-paragraph.
If no further paragraph boundary exists, motions clamp at BOF/EOF.
Operator forms with braces (`d{`, `d}`, `c{`, `c}`, `y{`, `y}`) are out of scope for this wave.

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

Counted yank caveat: counted `word`/`WORD` yank motions are intentionally not
implemented (`y2w`, `2yw`, `y2W`, `2yW`, etc. cancel the pending operator).
Linewise counted yank (`{count}yy`, `y{count}j/k`) remains supported.

---

### put / paste

| key          | action                                                      |
|--------------|-------------------------------------------------------------|
| `p`          | Put after cursor (char-wise) / new line below (line-wise)   |
| `P`          | Put before cursor (char-wise) / new line above (line-wise)  |
| `{count}p`   | Put `{count}` times after cursor                            |
| `{count}P`   | Put `{count}` times before cursor                           |

Put reads from the **unnamed register** (not OS clipboard).  
Line-wise detection: register content ending in `\n` is treated as line-wise.

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

- One unnamed register (like Vim's `""` register).
- Every `d`, `c`, `x`, `s`, `S`, `D`, `C`, `y` operator form
  (including `dd`/`d_`, `{count}dd`, `d{count}j/k`, `dG`, `yy`/`y_`, `{count}yy`,
  `y{count}j/k`, `yG`) writes to the register and mirrors to the OS clipboard
  (via `copyToClipboard`, best-effort).
- `p` / `P` read from the unnamed register only (not the OS clipboard).
- This gives stable behaviour across local terminals and SSH / OSC52 setups.

---

## known differences from full Vim

| area                  | this extension                         | full Vim                      |
|-----------------------|----------------------------------------|-------------------------------|
| `$` motion            | Moves past last char (readline CTRL+E) | Moves to last char            |
| `w` / `e` / `b` + `W` / `E` / `B` | Cross-line for `word` + `WORD` motions | Cross-line                    |
| `0` / `$` operators   | Exclusive of anchor col                | `0` inclusive of col 0        |
| Undo depth            | Delegates to underlying readline undo  | Full per-change undo tree     |
| Redo                  | Normal-mode `<C-r>` supported (safe no-op when empty; counted redo is stepwise, clamps to available history, and preserves single-step undo granularity) | `<C-r>`                       |
| Visual mode           | Not implemented                        | `v`, `V`, `<C-v>`            |
| Text objects          | Supports `iw`/`aw` only               | Full text-object set           |
| Count prefix          | Supported for operators, word/char motions, navigation, and edits (`x`, `r`, `p`/`P`); capped at `MAX_COUNT=9999` to prevent abuse | Full support |
| Named registers       | Not implemented (`"a`, etc.)           | Supported                     |
| Macros                | Not implemented (`q`, `@`)             | Supported                     |
| Search                | Not implemented (`/`, `?`, `n`, `N`)   | Supported                     |
| Ex commands           | Not implemented (`:s`, `:g`, etc.)     | Supported                     |
| Multi-line operators  | Supports `d/c/y` with `w/e/b` and `W/E/B`, plus `j/k` counts and `G`; not full Vim motion matrix | Rich cross-line semantics |

---

## out of scope

These are **explicitly deferred** and not planned for this feature:

- Visual modes (`v`, `V`, block visual)
- Extended text objects beyond word (`ip`, `i"`, `i(`, etc.)
- Named registers (`"a`, `"b`, …)
- Macros (`q{char}`, `@{char}`)
- Ex command surface (`:s`, `:g`, `:r`, …)
- Search mode (`/`, `?`, `n`, `N`)
- Repeat (`.`)
- Replace mode (`R`) — only single-char `r{char}` is supported
- Extended count prefix beyond currently supported motions (e.g. `:`, global operator counts)
- No insert-mode `<C-r>` feature expansion beyond current underlying-editor behavior.
- No cross-session redo persistence.
- No upstream `pi-tui` redo prerequisite in this wave.
- Window / tab / buffer management
- Plugin / runtime ecosystem compatibility

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
