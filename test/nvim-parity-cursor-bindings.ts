import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeybindingsManager } from "./control-key-fixtures.js";
import {
  type NvimParityCase,
  runNvimParityCase,
  runPiParityCase,
} from "./nvim-oracle.js";

const initial = {
  text: "alpha\nbravo\ncider\ndelta\neagle",
  cursor: { line: 2, col: 2 },
  register: "keep",
};
// Keep the existing hjkl gaps explicit rather than changing algorithms here:
// Normal EOL clamps, dk/yk cursor placement, dual counts and unsupported d/c/y
// horizontal suffixes are pinned against canonical keys in the ownership tests
// and documented in README. Prompt-history recall is intentionally Pi-only.
const cases: NvimParityCase[] = [
  ...[
    "k",
    "j",
    "h",
    "l",
    "2k",
    "2j",
    "2h",
    "2l",
    "yj",
    "vk",
    "Vj",
    "v2hy",
    "Vky",
  ].map((keys) => ({
    name: keys,
    initial,
    keys: [...keys],
  })),
  {
    name: "counted linewise deletion",
    initial: { ...initial, cursor: { line: 4, col: 0 } },
    keys: ["2", "d", "k"],
  },
  {
    name: "linewise delete repeat",
    initial: { ...initial, cursor: { line: 4, col: 0 } },
    keys: ["d", "k", "."],
  },
  {
    name: "linewise delete repeat undo redo",
    initial: { ...initial, cursor: { line: 4, col: 0 } },
    typedInput: true,
    keys: ["d", "k", ".", "u", "\x12"],
  },
  {
    name: "edge count clamps without prompt history",
    initial: { ...initial, cursor: { line: 0, col: 0 } },
    keys: [..."999999k"],
  },
  {
    name: "horizontal no-op clamps at start",
    initial: { ...initial, cursor: { line: 0, col: 0 } },
    keys: ["9", "h"],
  },
  {
    name: "grapheme-safe horizontal movement",
    initial: { ...initial, text: "a😀éz", cursor: { line: 0, col: 0 } },
    keys: ["2", "l", "h"],
  },
  {
    name: "sticky column restored beyond short line",
    initial: {
      ...initial,
      text: "abcdef\nx\nabcdef",
      cursor: { line: 0, col: 5 },
    },
    keys: ["j", "j"],
  },
  {
    name: "wrapped lines stay logical",
    initial: {
      ...initial,
      text: `${"abcdef".repeat(10)}\n${"ghijkl".repeat(10)}`,
      cursor: { line: 0, col: 2 },
    },
    displayWidth: 20,
    keys: ["j", "k", "j"],
  },
  {
    name: "g prefix shares display-row sticky column",
    initial: {
      ...initial,
      text: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      cursor: { line: 0, col: 2 },
    },
    displayWidth: 20,
    keys: ["g", "j", "g", "j", "g", "k"],
  },
];

for (const custom of [false, true]) {
  describe(`nvim parity cursor aliases (${custom ? "custom" : "default"})`, () => {
    const kb = new KeybindingsManager(
      custom
        ? {
            "tui.editor.cursorUp": "ctrl+p",
            "tui.editor.cursorDown": "ctrl+n",
          }
        : {},
    );
    const aliases: Record<string, string> = {
      h: "\x1b[D",
      j: custom ? "\x0e" : "\x1b[B",
      k: custom ? "\x10" : "\x1b[A",
      l: "\x1b[C",
    };
    const nvimAliases: Record<string, string> = {
      h: "<Left>",
      j: "<Down>",
      k: "<Up>",
      l: "<Right>",
    };
    for (const testCase of cases) {
      it(testCase.name, async () => {
        const pi = runPiParityCase(
          {
            ...testCase,
            keys: testCase.keys.map((key) => aliases[key] ?? key),
          },
          kb,
        );
        const nvim = await runNvimParityCase({
          ...testCase,
          // Custom host bindings promise hjkl semantics, not nvim's Ctrl keys.
          keys: custom
            ? testCase.keys
            : testCase.keys.map((key) => nvimAliases[key] ?? key),
        });
        assert.deepEqual(pi, nvim);
      });
    }
  });
}
