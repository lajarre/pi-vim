import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

// Paint is not visible to the headless oracle. Rendering at each input pins
// the semantic side: buffer, cursor, mode and unnamed register must still
// match nvim. Cell styling and the intentional text-plus-EOL (not full-width)
// linewise paint are asserted by visual-render.test.ts and documented in README.
const CASES: NvimParityCase[] = [
  {
    name: "render a live charwise selection across wrapped rows",
    initial: { text: "alpha beta gamma delta", cursor: { line: 0, col: 0 } },
    keys: ["v", "1", "5", "l"],
  },
  {
    name: "render a reversed wrapped selection then yank it",
    initial: { text: "alpha beta gamma delta", cursor: { line: 0, col: 0 } },
    keys: ["v", "1", "5", "l", "o", "y"],
  },
  {
    name: "render wide combining and astral graphemes before charwise yank",
    initial: { text: "a中e\u0301😀z", cursor: { line: 0, col: 0 } },
    keys: ["v", "3", "l", "y"],
  },
  {
    name: "render a live linewise selection through a blank row",
    initial: { text: "ab\n\ncd", cursor: { line: 0, col: 0 } },
    keys: ["V", "2", "j"],
  },
  {
    name: "render linewise wrapped Unicode before yank",
    initial: { text: "a中e\u0301😀z", cursor: { line: 0, col: 0 } },
    keys: ["V", "y"],
  },
  {
    name: "render a charwise selection ending on the final empty row",
    initial: { text: "ab\n", cursor: { line: 0, col: 0 } },
    keys: ["v", "j"],
  },
  {
    name: "render a selection then delete it",
    initial: { text: "alpha beta gamma delta", cursor: { line: 0, col: 0 } },
    keys: ["v", "9", "l", "d"],
  },
  {
    name: "render while toggling between charwise and linewise selections",
    initial: { text: "abcdef", cursor: { line: 0, col: 0 } },
    keys: ["v", "l", "V", "v", "y"],
  },
];

describe("nvim parity with visual rendering between inputs", () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim({ ...testCase, renderWidths: [8, 20] });
    });
  }
});
