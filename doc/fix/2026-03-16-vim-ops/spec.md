# spec: vim ops batch fix (2026-03-16)

Three changes in one branch. All stay in normal mode unless
noted. All must pass the existing test suite plus new tests.

## 1. `r{char}` — replace character

**Behavior:** Replace char under cursor with `{char}`, stay
in normal mode.

- `r{char}` — replace single char at cursor position
- `{count}r{char}` — replace next N chars with `{char}`
- non-printable input cancels the pending `r`
- if fewer than `{count}` chars remain on line, cancel (vim
  behavior)
- cursor stays on last replaced char (or doesn't move for
  single)

**Implementation notes:**
- new pending state `pendingReplace: boolean`
- count via existing `prefixCount` mechanism
- use `replaceTextInBuffer` or direct state mutation
  (buffer-level, not ESC_DELETE replay)

**Tests:**
- `ra` on `"hello"` col 0 → `"aello"`, cursor col 0
- `3rx` on `"hello"` col 0 → `"xxxlo"`, cursor col 2
- `r` + Escape cancels
- `5rx` on `"hi"` cancels (not enough chars)
- `r\n` — decide: cancel or no-op (vim inserts newline; we
  can cancel for simplicity)

## 2. `_` motion — first non-whitespace (correct impl)

Porting the intent of PR #5 but fixing the issues found in
review.

**Behavior:**
- `_` → jump to first non-whitespace char on current line
  (same as `^` for standalone motion)
- `{count}_` → move down `count-1` lines, then first non-ws

**Operator forms — linewise (vim-correct):**
- `d_` ≡ `dd` (delete current line)
- `d{count}_` — delete count lines (like `{count}dd`)
- `c_` ≡ `cc` (change current line)
- `y_` ≡ `yy` (yank current line)

**Implementation notes:**
- reuse existing `findFirstNonWhitespaceColumn()` from
  motions.ts — do NOT duplicate
- standalone `_` can reuse/extend existing
  `moveCursorToFirstNonWhitespace()` with optional count
- operator forms route through existing linewise delete/
  yank/change infrastructure (`deleteLinewiseByDelta`,
  etc.)
- add `_` to count-prefix allowlists

**Tests:**
- standalone `_` on indented line
- `2_` moves down 1 line + first non-ws
- `d_` deletes entire line (linewise)
- `d3_` deletes 3 lines
- `c_` changes line + enters insert
- `y_` yanks line

## 3. `dd` surrogate pair fix (correct impl)

Porting the approach of PR #6 but fixing the line-boundary
clamping bug found in review.

**The fix:** Replace ESC_DELETE replay with direct buffer
replacement (`replaceTextInBuffer`).

**Critical fix from review:** `deleteRange` must clamp
`col`/`targetCol` to `line.length` before converting to
absolute indices — otherwise counted `x`/`s` near EOL
crosses newlines.

**Implementation notes:**
- add `replaceTextInBuffer()` + `getCursorFromAbsoluteIndex()`
  as in PR #6
- refactor `deleteRangeByAbsolute` to use buffer replacement
- refactor `deleteRange` (line-local) to delegate to
  `deleteRangeByAbsolute` BUT clamp to current line first
- remove `ESC_DELETE` import if no longer used

**Tests:**
- `dd` on line with surrogate pairs (`"😀x\nkeep"`)
- `9x` on `"ab\ncd"` col 0 → `"\ncd"` (must not cross
  newline)
- existing test suite must pass unchanged

## definition of done

- all 3 features implemented
- `node --import tsx/esm --test test/modal-editor.test.ts`
  passes (0 failures)
- `npx tsc --noEmit` passes
- code committed (atomic per feature or single if clean)
