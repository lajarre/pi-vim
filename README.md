# vim-bindings — Pi REPL Vim Mode

A modal vim-like editing extension for Pi's REPL prompt, covering the
high-frequency ("90%") command surface without trying to clone full Vim.

## Loading

```
pi --extension /path/to/vim-bindings/index.ts
```

Or add to `.pi/settings.json`:

```json
{
  "extensions": ["./pi-extensions/vim-bindings/index.ts"]
}
```

The mode indicator (`INSERT` / `NORMAL`) is shown in the bottom-right corner
of the prompt.

---

## Supported command surface

### Mode switching

| Key      | Action                                 |
|----------|----------------------------------------|
| `Esc`    | Insert → Normal mode                   |
| `Esc`    | Normal mode → pass to Pi (abort agent) |
| `i`      | Normal → Insert at cursor              |
| `a`      | Normal → Insert after cursor           |
| `I`      | Normal → Insert at line start          |
| `A`      | Normal → Insert at line end            |
| `o`      | Normal → open line below + Insert      |
| `O`      | Normal → open line above + Insert      |

Insert-mode shortcuts (stay in Insert mode):

| Key             | Action                 |
|-----------------|------------------------|
| `Shift+Alt+A`   | Go to end of line      |
| `Shift+Alt+I`   | Go to start of line    |
| `Alt+o`         | Open line below        |
| `Alt+Shift+O`   | Open line above        |

---

### Navigation (Normal mode)

| Key   | Action                  |
|-------|-------------------------|
| `h`   | Left                    |
| `l`   | Right                   |
| `j`   | Down                    |
| `k`   | Up                      |
| `0`   | Line start              |
| `$`   | Line end                |
| `w`   | Next word start         |
| `b`   | Previous word start     |
| `e`   | Word end (inclusive)    |

---

### Character-find motions (Normal mode)

| Key        | Action                                         |
|------------|------------------------------------------------|
| `f{char}`  | Jump forward to `char` (inclusive)             |
| `F{char}`  | Jump backward to `char` (inclusive)            |
| `t{char}`  | Jump forward to one before `char` (exclusive)  |
| `T{char}`  | Jump backward to one after `char` (exclusive)  |
| `;`        | Repeat last `f/F/t/T` motion                   |
| `,`        | Repeat last motion in reverse direction         |

Char-find motions compose with operators: `df{char}`, `ct{char}`, etc.

---

### Edit operators (Normal mode)

All operators write to the unnamed register and mirror to the system clipboard
(best-effort; clipboard failure never breaks editing).

#### Delete `d{motion}` / `dd`

| Command    | Deletes                                     |
|------------|---------------------------------------------|
| `dw`       | Forward to next word start (exclusive, can cross lines) |
| `de`       | Forward to word end (inclusive, can cross lines)        |
| `db`       | Backward to word start (exclusive, can cross lines)     |
| `d$`       | To end of line                              |
| `d0`       | To start of line                            |
| `dd`       | Whole line content                          |
| `df{char}` | To and including `char`                     |
| `dt{char}` | Up to (not including) `char`                |
| `dF{char}` | Backward to and including `char`            |
| `dT{char}` | Backward to one after `char`                |
| `diw`      | Inner word                                  |
| `daw`      | Around word (includes surrounding spaces)   |

#### Change `c{motion}` / `cc`

Same motion set as `d`. Deletes text then enters Insert mode.

| Command | Alias |
|---------|-------|
| `cw`    | delete word + Insert |
| `ciw`   | change inner word |
| `caw`   | change around word |
| `cc`    | delete line + Insert |
| `c$`    | delete to EOL + Insert |
| …       | all `d` motions apply |

#### Single-key edits

| Key | Action                                       |
|-----|----------------------------------------------|
| `x` | Delete char under cursor (no-op at/past EOL) |
| `s` | Delete char under cursor + Insert mode       |
| `S` | Delete line content + Insert mode            |
| `D` | Delete cursor to EOL (captures `\n` if at EOL with next line) |
| `C` | Delete cursor to EOL + Insert mode           |

---

### Yank `y{motion}` / `yy`

Same motion set as `d`. Writes to register, **no text mutation**.

| Command | Yanks                           |
|---------|---------------------------------|
| `yy`    | Whole line + trailing `\n`      |
| `yw`    | Forward to next word start      |
| `ye`    | To word end (inclusive)         |
| `yb`    | Backward to word start          |
| `y$`    | To end of line                  |
| `y0`    | To start of line                |
| `yf{c}` | To and including `char`         |
| `yiw`   | Inner word                      |
| `yaw`   | Around word (includes spaces)   |

---

### Put / Paste

| Key | Action                                                      |
|-----|-------------------------------------------------------------|
| `p` | Put after cursor (char-wise) / new line below (line-wise)   |
| `P` | Put before cursor (char-wise) / new line above (line-wise)  |

Put reads from the **unnamed register** (not OS clipboard).  
Line-wise detection: register content ending in `\n` is treated as line-wise.

---

### Undo

| Key | Action                                          |
|-----|-------------------------------------------------|
| `u` | Undo — sends `ctrl+_` (`\x1f`) to the underlying readline editor |

Redo (`<C-r>`) is **not implemented** — see [Out of scope](#out-of-scope).

---

## Register and clipboard policy

- One unnamed register (like Vim's `""` register).
- Every `d`, `c`, `x`, `s`, `S`, `D`, `C`, `y`, `yy` writes to the register
  and mirrors to the OS clipboard (via `copyToClipboard`, best-effort).
- `p` / `P` read from the unnamed register only (not the OS clipboard).
- This gives stable behaviour across local terminals and SSH / OSC52 setups.

---

## Known differences from full Vim

| Area                  | This extension                         | Full Vim                      |
|-----------------------|----------------------------------------|-------------------------------|
| `$` motion            | Moves past last char (readline CTRL+E) | Moves to last char            |
| `w` / `e` / `b`       | Cross-line for word motions            | Cross-line                    |
| `0` / `$` operators   | Exclusive of anchor col                | `0` inclusive of col 0        |
| Undo depth            | Delegates to underlying readline undo  | Full per-change undo tree     |
| Redo                  | Not implemented                        | `<C-r>`                       |
| Visual mode           | Not implemented                        | `v`, `V`, `<C-v>`            |
| Text objects          | Supports `iw`/`aw` only               | Full text-object set           |
| Count prefix          | Not implemented (e.g. `3dw`)           | Supported                     |
| Named registers       | Not implemented (`"a`, etc.)           | Supported                     |
| Macros                | Not implemented (`q`, `@`)             | Supported                     |
| Search                | Not implemented (`/`, `?`, `n`, `N`)   | Supported                     |
| Ex commands           | Not implemented (`:s`, `:g`, etc.)     | Supported                     |
| Multi-line operators  | `w/e/b`-based ops can cross lines; others line-local | Rich cross-line semantics |

---

## Out of scope

These are **explicitly deferred** and not planned for this feature:

- Visual modes (`v`, `V`, block visual)
- Extended text objects beyond word (`ip`, `i"`, `i(`, etc.)
- Named registers (`"a`, `"b`, …)
- Macros (`q{char}`, `@{char}`)
- Ex command surface (`:s`, `:g`, `:r`, …)
- Search mode (`/`, `?`, `n`, `N`)
- Repeat (`.`)
- Count prefixes (`3dw`, `2j`, …)
- Redo (`<C-r>`) — no native redo primitive in the underlying readline editor;
  deferred until a suitable hook is available.
- Window / tab / buffer management
- Plugin / runtime ecosystem compatibility

---

## Architecture notes

- `index.ts` — `ModalEditor` subclass of `CustomEditor`; all key handling.
- `motions.ts` — pure motion calculation helpers (`findWordMotionTarget`,
  `findCharMotionTarget`); no side effects.
- `types.ts` — shared types and escape-sequence constants.
- `test/` — Node test runner suite; no browser / full runtime required.

Run tests:

```
cd vim-bindings
npm test
```
