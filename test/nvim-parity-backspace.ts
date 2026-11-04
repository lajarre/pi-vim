import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runNvimParityCase, runPiParityCase } from "./nvim-oracle.js";

for (const [piKey, nvimKey] of [
  ["h", "h"],
  ["\x08", "<C-h>"],
  ["\x7f", "<BS>"],
]) {
  describe(`nvim parity left alias ${nvimKey}`, () => {
    for (const keys of [
      "h",
      "2h",
      "999999h",
      "v2h",
      "Vh",
      "v2hy",
      "dh",
      "chX\x1b",
      "yh",
      "2d2h",
      "2c2hX\x1b",
      "2y2h",
      "dhu\x12",
      "dh.",
      "0dh",
      "0yh",
      "999999dh",
      "999999yh",
      "0hxl",
    ]) {
      it(keys, async () => {
        const initial = {
          text: "abcdefghij\nnext",
          cursor: { line: 0, col: 7 },
          register: "keep",
        };
        const testCase = {
          name: keys,
          initial,
          keys: [...keys],
          typedInput: true,
        };
        assert.deepEqual(
          runPiParityCase({
            ...testCase,
            keys: testCase.keys.map((key) => (key === "h" ? piKey : key)),
          }),
          await runNvimParityCase({
            ...testCase,
            keys: testCase.keys.map((key) => (key === "h" ? nvimKey : key)),
          }),
        );
      });
    }
    it("Unicode combining and wide graphemes", async () => {
      const testCase = {
        name: "unicode left operator",
        initial: {
          text: "a😀éz",
          cursor: { line: 0, col: 5 },
          register: "keep",
        },
        keys: ["d", "2", piKey],
      };
      assert.deepEqual(
        runPiParityCase(testCase),
        await runNvimParityCase({ ...testCase, keys: ["d", "2", nvimKey] }),
      );
    });
  });
}
