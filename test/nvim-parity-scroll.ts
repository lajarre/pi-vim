import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertMatchesNvim,
  type NvimParityCase,
  runNvimParityCase,
  runPiParityCase,
} from "./nvim-oracle.js";

const D = "\x04",
  U = "\x15",
  F = "\x06",
  B = "\x02";
const logical = Array(40).fill("abcdefghij").join("\n");
const wrapped = "abcdefghijklmnopqrstuvwxyz".repeat(30);
function scenario(text: string, keys: string[], height = 7): NvimParityCase {
  return {
    name: JSON.stringify(keys),
    initial: { text, cursor: { line: 0, col: 3 }, register: "keep" },
    keys,
    displayWidth: 20,
    displayHeight: height,
    scrollKeys: true,
  };
}

describe("nvim scroll parity (wrap, fixed width/height, nostartofline)", () => {
  for (const height of [6, 7, 12]) {
    for (const keys of [
      [D],
      [U],
      [F],
      [B],
      [D, U],
      ["3", D, D],
      ["3", D, U],
      ["v", D],
      ["V", D],
      ["v", F],
      ["V", F],
      ["2", D, "l"],
      [D, "1", U, "x"],
    ]) {
      it(`${height} rows: ${JSON.stringify(keys)} matches native scrolling on unwrapped text`, async () => {
        await assertMatchesNvim(scenario(logical, keys, height));
      });
    }
  }

  // Intentional divergence: this feature is a fixed display-row cursor motion,
  // not Vim's viewport scroll. Native Ctrl-D can traverse a whole wrapped logical
  // line, and Ctrl-F/B depends on the window's top line. Assert against gj/gk for
  // the requested geometry, not a false assertion of native-scroll equivalence.
  for (const [keys, oracleKeys] of [
    [[D], [..."4gj"]],
    [[F], [..."5gj"]],
    [[D, U], [..."4gj4gk"]],
    [[F, B], [..."5gj5gk"]],
    [["3", D, D], [..."6gj"]],
    [["2", F], [..."10gj"]],
    [["v", D], [..."v4gj"]],
    [["V", F], [..."V5gj"]],
    [["9", "9", "9", D], [..."999gj"]],
    [["9", "9", "9", B], [..."999gk"]],
  ]) {
    it(`${JSON.stringify(keys)} intentionally uses display-row motion on wrapped text`, async () => {
      const testCase = scenario(wrapped, keys);
      assert.deepEqual(
        runPiParityCase(testCase),
        await runNvimParityCase({ ...testCase, keys: oracleKeys }),
      );
    });
  }
  it("pins the intentional native Ctrl-D wrapped-line divergence", async () => {
    const testCase = scenario(wrapped, [D]);
    const pi = runPiParityCase(testCase);
    const nvim = await runNvimParityCase(testCase);
    assert.deepEqual(pi, {
      text: wrapped,
      cursor: { line: 0, col: 83 },
      mode: "normal",
      register: "keep",
    });
    assert.deepEqual(nvim, { ...pi, cursor: { line: 0, col: 763 } });
  });
});
