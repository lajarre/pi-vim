import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDITOR_BINDING_VARIANTS,
  withEditorBindings,
} from "./editor-action-fixtures.js";
import {
  type NvimParityCase,
  runNvimParityCase,
  runPiParityCase,
} from "./nvim-oracle.js";

const ESC = "\x1b";
const CASES: NvimParityCase[] = [
  {
    name: "horizontal motions and line start bypass bindings",
    initial: { text: "abcdef", cursor: { line: 0, col: 1 }, register: "keep" },
    keys: ["2", "l", "h", "0", "l"],
  },
  {
    name: "counted horizontal motions preserve Unicode grapheme boundaries",
    initial: { text: "a😀bcd", cursor: { line: 0, col: 0 }, register: "keep" },
    keys: ["3", "l", "2", "h"],
  },
  {
    name: "logical vertical motions bypass bindings on long lines",
    initial: {
      text: `${"a".repeat(120)}\nbc\n${"d".repeat(120)}`,
      cursor: { line: 0, col: 1 },
      register: "keep",
    },
    keys: ["j", "j", "k"],
  },
  ...["D", "d$"].map(
    (command): NvimParityCase => ({
      name: `${command} deletes a whole line's content`,
      initial: {
        text: "abcdef\nghi",
        cursor: { line: 0, col: 0 },
        register: "keep",
      },
      keys: [...command],
    }),
  ),
  ...["C", "c$"].map(
    (command): NvimParityCase => ({
      name: `${command} changes the tail with Pi deletion bindings unavailable`,
      initial: {
        text: "abcdef",
        cursor: { line: 0, col: 2 },
        register: "keep",
      },
      keys: [...command, "Z", ESC],
    }),
  ),
  ...["a", "A", "o", "O"].map(
    (command): NvimParityCase => ({
      name: `${command} positions insert mode independently of Pi bindings`,
      initial: {
        text: "abc\ndef",
        cursor: { line: 0, col: 1 },
        register: "keep",
      },
      keys: [command, "Z", ESC],
    }),
  ),
  ...["p", "P"].map(
    (command): NvimParityCase => ({
      name: `${command} inserts literal action-bound characters and emoji`,
      initial: { text: "ab", cursor: { line: 0, col: 0 }, register: "qx😀" },
      keys: ["2", command],
    }),
  ),
  ...["p", "P"].map(
    (command): NvimParityCase => ({
      name: `${command} preserves counted multi-line linewise register order`,
      initial: {
        text: "ab\ncd",
        cursor: { line: 0, col: 0 },
        register: "qx\nyz\n",
      },
      keys: ["2", command],
    }),
  ),
  ...[
    ["2", "P", "."],
    ["2", "P", "u"],
    ["2", "P", "9", "u"],
    ["2", "P", ".", "u", "u", "9", "\x12"],
  ].map(
    (keys): NvimParityCase => ({
      name: `multiline put history ${JSON.stringify(keys)}`,
      initial: {
        text: "ab\ncd",
        cursor: { line: 0, col: 0 },
        register: "qx\nyz\n",
      },
      keys,
    }),
  ),
  ...["o", "O"].map(
    (command): NvimParityCase => ({
      name: `${command} opens at the empty buffer boundary`,
      initial: { text: "", cursor: { line: 0, col: 0 }, register: "keep" },
      keys: [command, "Z", ESC],
    }),
  ),
  {
    name: "o opens after the final long logical line",
    initial: {
      text: `first\n${"a".repeat(120)}`,
      cursor: { line: 1, col: 110 },
      register: "keep",
    },
    keys: ["o", "Z", ESC],
  },
  {
    name: "O opens above the first long logical line",
    initial: {
      text: `${"a".repeat(120)}\nlast`,
      cursor: { line: 0, col: 110 },
      register: "keep",
    },
    keys: ["O", "Z", ESC],
  },
  {
    name: "counted P preserves combining and joined graphemes",
    initial: {
      text: "ab",
      cursor: { line: 0, col: 0 },
      register: "e\u0301👩🏽‍💻",
    },
    keys: ["2", "P"],
  },
  {
    name: "dd lands at the next line start",
    initial: {
      text: "abc\ndef",
      cursor: { line: 0, col: 0 },
      register: "keep",
    },
    keys: ["d", "d"],
  },
  {
    name: "direct undo restores deletion and cursor",
    initial: { text: "abc", cursor: { line: 0, col: 1 }, register: "keep" },
    keys: ["x", "u"],
  },
  {
    name: "direct undo restores a complete inserted line's text",
    initial: { text: "abc", cursor: { line: 0, col: 1 }, register: "keep" },
    keys: ["o", "Z", ESC, "u", "0"],
  },
  {
    name: "dot repeat replays synthetic open-line actions",
    initial: { text: "abc", cursor: { line: 0, col: 0 }, register: "keep" },
    keys: ["o", "Z", ESC, "."],
  },
];

for (const variant of EDITOR_BINDING_VARIANTS) {
  describe(`nvim parity editor actions with ${variant} Pi bindings`, () => {
    for (const testCase of CASES) {
      it(testCase.name, async () => {
        const pi = withEditorBindings(variant, () => runPiParityCase(testCase));
        const nvim = await runNvimParityCase(testCase);
        assert.deepEqual(pi, nvim);
      });
    }
  });
}
