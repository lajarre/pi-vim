/**
 * Quit itself cannot be snapshotted by the oracle. ZZ's prompt-only safe quit
 * (no write) and normal-only aliases intentionally diverge from Vim; the host
 * seams are asserted in normal-quit.test.ts. Z-prefix cancellation is Vim-like
 * and compared here, including count consumption and operator precedence.
 * nvim clears queued typeahead on an invalid command, so invalid-suffix cases
 * stop at that suffix. Subsequent separately typed keys are covered by units.
 */
import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const MODE_SWITCH_PARITY_CASES: NvimParityCase[] = [
  {
    name: "i - inserts before the cursor",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
    },
    keys: ["i", "X", "\x1b"],
  },
  {
    name: "i - inserts before the final character",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 2 },
      mode: "normal",
    },
    keys: ["i", "X", "\x1b"],
  },
  {
    name: "a - appends after the cursor",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
    },
    keys: ["a", "X", "\x1b"],
  },
  {
    name: "a - appends after the final character",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 2 },
      mode: "normal",
    },
    keys: ["a", "X", "\x1b"],
  },
  {
    name: "I - inserts before the first non-blank",
    initial: {
      text: "  abc",
      cursor: { line: 0, col: 3 },
      mode: "normal",
    },
    keys: ["I", "X", "\x1b"],
  },
  {
    name: "A - appends at line end",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
    },
    keys: ["A", "X", "\x1b"],
  },
  {
    name: "o - opens a line below",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
    },
    keys: ["o", "X", "\x1b"],
  },
  {
    name: "O - opens a line above",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
    },
    keys: ["O", "X", "\x1b"],
  },
  {
    name: "Escape - leaves insert mode",
    initial: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "insert",
    },
    keys: ["\x1b"],
  },
];

const Z_PREFIX_PARITY_CASES: NvimParityCase[] = [
  {
    name: "Zx drops the invalid suffix without deleting or moving",
    initial: {
      text: "abc\ndef",
      cursor: { line: 0, col: 1 },
      register: "saved\n",
    },
    keys: ["Z", "x"],
  },
  {
    name: "Zi drops insert entry and stays in normal mode",
    initial: { text: "abc", cursor: { line: 0, col: 1 } },
    keys: ["Z", "i"],
  },
  {
    name: "3Z Escape discards the count; the next x deletes one",
    initial: { text: "abc", cursor: { line: 0, col: 1 } },
    keys: ["3", "Z", "\x1b", "x"],
  },
  {
    name: "3Zx drops the invalid suffix without a counted delete",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 } },
    keys: ["3", "Z", "x"],
  },
  {
    name: "Z2 drops the digit instead of starting a count",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 } },
    keys: ["Z", "2"],
  },
  {
    name: "2d3Z cancels the operator/count without starting a Z prefix",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 } },
    keys: ["2", "d", "3", "Z"],
  },
  {
    name: "gZ cancels g without starting a Z prefix",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 } },
    keys: ["g", "Z"],
  },
  {
    name: "Zx leaves Unicode text and a linewise register intact",
    initial: {
      text: "中🙂é",
      cursor: { line: 0, col: 0 },
      register: "saved\n",
    },
    keys: ["Z", "x"],
  },
];

describe("nvim parity Z-prefix cancellation", () => {
  for (const testCase of Z_PREFIX_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});

describe("nvim parity mode switching", () => {
  for (const testCase of MODE_SWITCH_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
