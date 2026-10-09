import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const CASES: NvimParityCase[] = [
  {
    name: "/ searches forward",
    initial: { text: "alpha beta alpha", cursor: { line: 0, col: 0 } },
    keys: ["/", "beta", "\n"],
  },
  {
    name: "? searches backward",
    initial: { text: "alpha beta alpha", cursor: { line: 0, col: 11 } },
    keys: ["?", "beta", "\n"],
  },
  {
    name: "/ wraps",
    initial: { text: "alpha beta alpha", cursor: { line: 0, col: 15 } },
    keys: ["/", "beta", "\n"],
  },
  {
    name: "2/ uses next match",
    initial: { text: "aa aa aa aa", cursor: { line: 0, col: 0 } },
    keys: ["2", "/", "aa", "\n"],
  },
  {
    name: "n repeats, N reverses",
    initial: { text: "aa aa aa aa", cursor: { line: 0, col: 0 } },
    keys: ["/", "aa", "\n", "n", "N"],
  },
  {
    name: "d/ deletes to target",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["d", "/", "baz", "\n"],
  },
  {
    name: "c? changes through target",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 10 } },
    keys: ["c", "?", "foo", "\n", "Z", "\x1b"],
  },
  {
    name: "y/ yanks without editing",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["y", "/", "baz", "\n"],
  },
  {
    name: "d/ spans lines",
    initial: { text: "foo\nbar\nbaz", cursor: { line: 0, col: 1 } },
    keys: ["d", "/", "baz", "\n"],
  },
  {
    name: "d/ from first column to a later first column",
    initial: { text: "foo\nbar\nbaz", cursor: { line: 0, col: 0 } },
    keys: ["d", "/", "baz", "\n"],
  },
  {
    name: "y/ across lines preserves the register type",
    initial: { text: "foo\nbar\nbaz", cursor: { line: 0, col: 0 } },
    keys: ["y", "/", "baz", "\n"],
  },
  {
    name: "c/ from first column to a later first column",
    initial: { text: "foo\nbar\nbaz", cursor: { line: 0, col: 0 } },
    keys: ["c", "/", "baz", "\n", "Z", "\x1b"],
  },
  {
    name: "c/ from first non-blank to a later first column",
    initial: { text: "  foo\nbar\nbaz", cursor: { line: 0, col: 2 } },
    keys: ["c", "/", "baz", "\n", "Z", "\x1b"],
  },
  {
    name: "search over a Unicode grapheme",
    initial: { text: "a 🦊 b 🦊", cursor: { line: 0, col: 0 } },
    keys: ["/", "🦊", "\n"],
  },
  {
    name: "N does not reverse the direction of the next n",
    initial: { text: "aa aa aa aa", cursor: { line: 0, col: 0 } },
    keys: ["/", "aa", "\n", "N", "n"],
  },
  {
    name: "? change does not eat the match",
    initial: { text: "one two three", cursor: { line: 0, col: 12 } },
    keys: ["c", "?", "two", "\n", "Z", "\x1b"],
  },
  {
    name: "d? deletes back to target",
    initial: { text: "one two three", cursor: { line: 0, col: 9 } },
    keys: ["d", "?", "one", "\n"],
  },
  {
    name: "2d/ multiplies operator search count",
    initial: { text: "a b c b d b", cursor: { line: 0, col: 0 } },
    keys: ["2", "d", "/", "b", "\n"],
  },
  {
    name: "d2/ multiplies operator search count",
    initial: { text: "a b c b d b", cursor: { line: 0, col: 0 } },
    keys: ["d", "2", "/", "b", "\n"],
  },
  {
    name: "Esc completes a pending operator search in Neovim",
    initial: { text: "one two", cursor: { line: 0, col: 0 } },
    keys: ["d", "/", "two", "\x1b"],
  },
  {
    name: "Ctrl+C cancels a pending search",
    initial: { text: "one two", cursor: { line: 0, col: 0 } },
    keys: ["d", "/", "two", "\x03"],
  },
  {
    name: "operator repeat without a prior search clears dot repeat",
    initial: { text: "abcd", cursor: { line: 0, col: 0 } },
    keys: ["x", "d", "n", "."],
  },
  {
    name: "failed search leaves the buffer alone",
    initial: { text: "one two", cursor: { line: 0, col: 0 } },
    keys: ["d", "/", "missing", "\n"],
  },
  {
    name: "search count does not leak to the next motion",
    initial: { text: "aa aa aa aa", cursor: { line: 0, col: 0 } },
    keys: ["2", "/", "aa", "\n", "l"],
  },
  {
    name: "dot repeats a search-based delete",
    initial: { text: "a b a b a b", cursor: { line: 0, col: 0 } },
    keys: ["d", "/", "b", "\n", "."],
  },
  {
    name: "search finds overlapping matches",
    initial: { text: "aaaa", cursor: { line: 0, col: 0 } },
    keys: ["/", "aa", "\n"],
  },
  {
    name: "magic . matches any character",
    initial: { text: "xx axb ayb", cursor: { line: 0, col: 0 } },
    keys: ["/", "a.b", "\n"],
  },
  {
    name: "magic escaped plus repeats",
    initial: { text: "x ab abb", cursor: { line: 0, col: 0 } },
    keys: ["/", "ab\\+", "\n"],
  },
  {
    name: "\u005cv turns on very magic",
    initial: { text: "x ab abb", cursor: { line: 0, col: 0 } },
    keys: ["/", "\\vab+", "\n"],
  },
];

describe("nvim search motion parity", () => {
  for (const testCase of CASES)
    it(testCase.name, async () => assertMatchesNvim(testCase));
});
