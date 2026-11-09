import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import { KeybindingsManager } from "./control-key-fixtures.js";
import { sendKeys, setInternalCursor, stubTheme, stubTui } from "./harness.js";
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

  for (const keys of [[F], ["v", F], ["V", F]]) {
    it(`Pi default Ctrl-F/B page rather than alias l/h: ${JSON.stringify(keys)}`, async () => {
      const testCase = scenario(logical, keys);
      const pi = runPiParityCase(testCase, new KeybindingsManager());
      assert.deepEqual(pi, await runNvimParityCase(testCase));
      assert.deepEqual(pi.cursor, { line: 5, col: 3 });
    });
  }

  it("Pi default Ctrl-B pages back, intentionally independent of native viewport position", async () => {
    const testCase = scenario(logical, [F, B]);
    const pi = runPiParityCase(testCase, new KeybindingsManager());
    assert.deepEqual(
      pi,
      await runNvimParityCase({ ...testCase, keys: [..."5gj5gk"] }),
    );
    assert.deepEqual(pi.cursor, { line: 0, col: 3 });
    // Even unwrapped native paging can differ: Ctrl-B moves to the window bottom.
    assert.deepEqual(await runNvimParityCase(testCase), {
      ...pi,
      cursor: { line: 6, col: 3 },
    });
  });

  it("empty-prompt scrolling clamps without exiting or leaking a count", async () => {
    await assertMatchesNvim({
      ...scenario("", ["9", D, U, F, B]),
      initial: { text: "", cursor: { line: 0, col: 0 }, register: "keep" },
    });
  });

  it("5<C-d> then a rendered height change resets to half the new height", async () => {
    const testCase = scenario(logical, ["5", D, "<Cmd>set lines=13<CR>", D]);
    const tui = { ...stubTui, terminal: { ...stubTui.terminal, rows: 24 } };
    const editor = new ModalEditor(tui, stubTheme, new KeybindingsManager());
    editor.setText(logical);
    editor.setRegister("keep");
    editor.handleInput("\x1b");
    setInternalCursor(editor, 3);
    editor.render(21); // Seven text rows.
    sendKeys(editor, ["5", D]);
    assert.deepEqual(editor.getCursor(), { line: 5, col: 3 });
    tui.terminal.rows = 40;
    editor.render(21); // Twelve text rows: 'scroll' returns to six.
    editor.handleInput(D);
    const actual = {
      text: editor.getText(),
      cursor: editor.getCursor(),
      mode: editor.getMode(),
      register: editor.getRegister(),
    };
    assert.deepEqual(actual.cursor, { line: 11, col: 3 });
    assert.deepEqual(actual, await runNvimParityCase(testCase));
  });

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
