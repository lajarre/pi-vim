import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type NvimParityCase,
  runNvimParityCase,
  runPiParityCase,
} from "./nvim-oracle.js";

// pi-vim's insert escape matches nvim's `inoremap {sequence} <Esc>` when each
// key lands inside the timeout (the oracle feeds nvim the whole key string).
// Pi's implicit startup insert has no nvim counterpart (`startinsert` records
// no `i`), so its dot-repeat is covered in test/insert-escape.test.ts instead.
// Prompt-history browsing and Ctrl+] jump-to-char are Pi-only; their
// interaction with the sequence is covered there too. Count-insert repeat
// (`3i…<Esc>`) is out of scope (README): unit-tested against Esc only.
const INSERT_ESCAPE_CASES: NvimParityCase[] = [
  {
    name: "jk leaves insert mid-line like Esc",
    initial: { text: "hello world", cursor: { line: 0, col: 6 } },
    keys: ["i", "a", "b", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: "jk right after entering insert at column 0",
    initial: { text: "abc", cursor: { line: 0, col: 0 } },
    keys: ["i", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: "jk in an opened line",
    initial: { text: "one\ntwo", cursor: { line: 0, col: 1 } },
    keys: ["o", "x", "y", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: "jjk escapes and leaves one j",
    initial: { text: "abc", cursor: { line: 0, col: 2 } },
    keys: ["a", "j", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: "an interrupted jk stays text",
    initial: { text: "abc", cursor: { line: 0, col: 0 } },
    // nvim's feedkeys ends insert mode at the end; Esc makes that explicit.
    keys: ["i", "j", "x", "k", "\x1b"],
    insertEscape: "jk",
  },
  {
    name: "jj as the configured sequence",
    initial: { text: "abc", cursor: { line: 0, col: 1 } },
    keys: ["i", "x", "j", "j"],
    insertEscape: "jj",
  },
  {
    name: "a 3-key sequence",
    initial: { text: "abc", cursor: { line: 0, col: 1 } },
    keys: ["a", "x", "j", "k", "l"],
    insertEscape: "jkl",
  },
  {
    name: "an overlapping repeated-letter prefix",
    initial: { text: "z", cursor: { line: 0, col: 0 } },
    keys: ["A", "a", "a", "a", "b"],
    insertEscape: "aab",
  },
  {
    name: "the escape keeps the unnamed register",
    initial: { text: "abc", cursor: { line: 0, col: 0 }, register: "keep" },
    keys: ["i", "x", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: ". replays the insert without the sequence",
    initial: { text: "x", cursor: { line: 0, col: 0 } },
    keys: ["A", "a", "b", "j", "k", "."],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "u undoes the insert without resurrecting the letters",
    initial: { text: "start", cursor: { line: 0, col: 0 } },
    keys: ["A", " ", "f", "o", "o", "j", "k", "u"],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "u undoes the insert without resurrecting the letters (cursor normalized)",
    initial: { text: "start", cursor: { line: 0, col: 0 } },
    keys: ["A", " ", "f", "o", "o", "j", "k", "u", "0"],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "an escape-only insert is no change for u",
    initial: { text: "abc", cursor: { line: 0, col: 0 } },
    keys: ["x", "i", "j", "k", "u"],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "an escape-only insert keeps redo",
    initial: { text: "abc", cursor: { line: 0, col: 0 } },
    keys: ["x", "u", "i", "j", "k", "\x12"],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "cw plus the sequence, then . elsewhere",
    initial: { text: "one two three", cursor: { line: 0, col: 0 } },
    keys: ["c", "w", "n", "e", "w", "j", "k", "w", "."],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "cw on whitespace plus the sequence, then . elsewhere",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 3 } },
    keys: ["c", "w", "-", "j", "k", "w", "e", "l", "."],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "a no-op Backspace before the sequence adds no undo step",
    initial: { text: "", cursor: { line: 0, col: 0 } },
    keys: ["i", "a", "b", "c", "\x1b", "0", "i", "\x7f", "j", "k", "u"],
    insertEscape: "jk",
    typedInput: true,
  },
  {
    name: "the sequence at column 0 of a second line",
    initial: { text: "one\ntwo", cursor: { line: 1, col: 0 } },
    keys: ["i", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: "a multi-byte character before the cursor",
    initial: { text: "x", cursor: { line: 0, col: 0 } },
    keys: ["A", "é", "j", "k"],
    insertEscape: "jk",
  },
  {
    name: "a skin-tone emoji before the cursor",
    initial: { text: "x", cursor: { line: 0, col: 0 } },
    keys: ["A", "👍🏽", "j", "k"],
    insertEscape: "jk",
  },
];

// Pi receives Backspace as DEL; nvim's feedkeys needs the `<BS>` keycode.
const NVIM_KEYS: Record<string, string> = { "\x7f": "<BS>" };

// Pre-existing gaps, identical with a plain Esc, so not insert-escape
// behavior. Undo (`A foo<Esc>u`): Pi restores the cursor one column right of
// nvim. `cw` on a word (`cwnew<Esc>`): Pi changes like `dw` and eats the
// trailing space, where Vim changes like `ce`.
const KNOWN_NVIM_PARITY_GAPS = new Set([
  "u undoes the insert without resurrecting the letters",
  "cw plus the sequence, then . elsewhere",
]);

describe("nvim parity: insert escape sequence", () => {
  for (const testCase of INSERT_ESCAPE_CASES) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }
    it(testCase.name, async () => {
      assert.deepEqual(
        runPiParityCase(testCase),
        await runNvimParityCase({
          ...testCase,
          keys: testCase.keys.map((key) => NVIM_KEYS[key] ?? key),
        }),
      );
    });
  }
});
