import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const PUT_PARITY_CASES: NvimParityCase[] = [
  ...["p", "P"].flatMap((key) => [
    {
      name: `${key} counted public insertion keeps graphemes and supports dot`,
      initial: {
        text: "ab",
        cursor: { line: 0, col: 0 },
        register: "👩‍💻e\u0301",
      },
      keys: ["3", key, "."],
    },
    {
      name: `${key} counted multiline public insertion has one undo unit`,
      initial: {
        text: "ab\ncd",
        cursor: { line: 0, col: 0 },
        register: "qx\nyz\n",
      },
      keys: ["3", key, ".", "u", "0"],
      typedInput: true,
    },
  ]),
  {
    name: "p puts a character-wise register after the cursor",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "X" },
    keys: ["p"],
  },
  {
    name: "P puts a character-wise register before the cursor",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "X" },
    keys: ["P"],
  },
  {
    name: "p leaves the cursor on a pasted emoji grapheme",
    initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "💩" },
    keys: ["p"],
  },
  {
    name: "p puts a line-wise register below the current line",
    initial: { text: "a\nb", cursor: { line: 0, col: 0 }, register: "X\n" },
    keys: ["p"],
  },
  {
    name: "P puts a line-wise register above the current line",
    initial: { text: "a\nb", cursor: { line: 1, col: 0 }, register: "X\n" },
    keys: ["P"],
  },
  {
    name: "yy then p lands on the first non-blank of the pasted line",
    initial: { text: "hello", cursor: { line: 0, col: 2 }, register: "" },
    keys: ["y", "y", "p"],
  },
  {
    name: "counted line-wise p lands on the first pasted line",
    initial: { text: "a\nb", cursor: { line: 0, col: 0 }, register: "X\n" },
    keys: ["3", "p"],
  },
  {
    name: "counted line-wise P lands on the first pasted line",
    initial: { text: "a\nb", cursor: { line: 1, col: 0 }, register: "X\n" },
    keys: ["3", "P"],
  },
  {
    name: "multi-line line-wise register p lands on the first pasted line",
    initial: { text: "a\nb", cursor: { line: 0, col: 0 }, register: "X\nY\n" },
    keys: ["p"],
  },
  {
    name: "2P keeps multiline register copies intact with default bindings",
    initial: {
      text: "ab\ncd",
      cursor: { line: 0, col: 0 },
      register: "qx\nyz\n",
    },
    keys: ["2", "P"],
  },
  {
    name: "line-wise p with a leading-whitespace first line lands on its first non-blank",
    initial: { text: "a\nb", cursor: { line: 0, col: 0 }, register: "  foo\n" },
    keys: ["p"],
  },
  {
    // Documented divergence: Vim's `^` lands on the last char of an
    // all-whitespace line; the shared first-non-blank helper returns col 0.
    name: "line-wise p with an all-whitespace first line (^ divergence)",
    initial: {
      text: "a\nb",
      cursor: { line: 0, col: 0 },
      register: "   \nyz\n",
    },
    keys: ["p"],
  },
];

const KNOWN_NVIM_PUT_PARITY_GAPS = new Set([
  "line-wise p with an all-whitespace first line (^ divergence)",
]);

const JOIN_PARITY_CASES: NvimParityCase[] = [
  {
    name: "J joins the next line with a separating space",
    initial: {
      text: "foo\nbar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
  {
    name: "J trims leading whitespace from the right line",
    initial: {
      text: "foo\n  bar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
  {
    name: "J preserves trailing whitespace on the left line",
    initial: {
      text: "foo  \nbar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
  {
    name: "gJ joins without whitespace normalization",
    initial: {
      text: "foo\nbar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["g", "J"],
  },
  {
    name: "gJ preserves leading whitespace on the right line",
    initial: {
      text: "foo\n  bar",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["g", "J"],
  },
  {
    name: "3J joins three lines with normalization",
    initial: {
      text: "a\nb\nc\nd",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["3", "J"],
  },
  {
    name: "3gJ joins three lines without normalization",
    initial: {
      text: "a\nb\nc\nd",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["3", "g", "J"],
  },
  {
    name: "J on the last line is a no-op",
    initial: {
      text: "foo\nbar",
      cursor: { line: 1, col: 0 },
      register: "keep",
    },
    keys: ["J"],
  },
];

describe("nvim parity put", () => {
  for (const testCase of PUT_PARITY_CASES) {
    if (KNOWN_NVIM_PUT_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }

    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});

describe("nvim parity joins", () => {
  for (const testCase of JOIN_PARITY_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
