import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ModalEditor } from "../index.js";
import { createCursorBindingResolver } from "../input-keys.js";
import {
  assertNoPending,
  fixture,
  KeybindingsManager,
} from "./control-key-fixtures.js";
import { sendKeys, setInternalCursor, stubTheme, stubTui } from "./harness.js";

const ESC = "\x1b";
const UP = "\x10";
const DOWN = "\x0e";
const bindings = {
  "tui.editor.cursorUp": "ctrl+p",
  "tui.editor.cursorDown": "ctrl+n",
};

describe("cursor binding boundaries", () => {
  it("uses the public manager once per construction; replacement refreshes it", () => {
    const kb = new KeybindingsManager(bindings);
    const reads: string[] = [];
    const getKeys = kb.getKeys.bind(kb);
    kb.getKeys = (action) => {
      reads.push(action);
      return getKeys(action);
    };
    const create = () => {
      const editor = new ModalEditor(stubTui, stubTheme, kb);
      editor.setText("abc\ndef\nghi");
      editor.handleInput(ESC);
      setInternalCursor(editor, 1, 2);
      return editor;
    };
    const old = create();
    kb.setUserBindings({ "tui.editor.cursorUp": ["shift+up", "ctrl+k"] });
    old.handleInput(UP);
    assert.deepEqual(old.getCursor(), { line: 1, col: 1 });
    assert.equal(reads.length, 4);
    // The same factory is invoked after the host reloads its keybindings.
    const replacement = create();
    replacement.handleInput("\x1b[1;2A");
    assert.deepEqual(replacement.getCursor(), { line: 1, col: 1 });
    replacement.handleInput("\x0b");
    assert.deepEqual(replacement.getCursor(), { line: 0, col: 1 });
    assert.equal(reads.length, 8);
  });

  it("honors list/disabled bindings and all existing host event encodings", () => {
    const resolve = createCursorBindingResolver(
      new KeybindingsManager({
        "tui.editor.cursorUp": ["ctrl+p", "shift+up"],
        "tui.editor.cursorDown": [],
        "tui.editor.cursorLeft": "alt+left",
        "tui.editor.cursorRight": "q",
      }),
    );
    for (const raw of [UP, "\x1b[112;5u", "\x1b[27;5;112~", "\x1b[1;2A"])
      assert.equal(resolve(raw), "k", JSON.stringify(raw));
    for (const raw of ["\x1b[A", "\x1b[B", DOWN, "\x1b[D"])
      assert.equal(resolve(raw), undefined);
    assert.equal(resolve("\x1b[1;3D"), "h");
    assert.equal(resolve("q"), "l");
    assert.equal(resolve("\x1b[113u"), "l");
  });

  it("uses host direction order for duplicate cursor claims", () => {
    const resolve = createCursorBindingResolver(
      new KeybindingsManager({
        "tui.editor.cursorUp": "ctrl+p",
        "tui.editor.cursorDown": "ctrl+p",
        "tui.editor.cursorLeft": "q",
        "tui.editor.cursorRight": "q",
      }),
    );
    assert.equal(resolve(UP), "k");
    assert.equal(resolve("q"), "l");
  });

  it("does not invent aliases for disabled or replaced directions", () => {
    const f = fixture(["3", "d"], { ...bindings, "tui.editor.cursorLeft": [] });
    const before = f.snapshot();
    f.editor.handleInput("\x1b[D");
    assert.deepEqual(f.snapshot(), before);
    assertNoPending(f.state);
    f.editor.handleInput("\x1b[A");
    assert.deepEqual(f.snapshot(), before);
  });

  it("gives a cursor binding priority over retained app defaults outside Insert", () => {
    for (const explicit of [false, true]) {
      const config = {
        ...bindings,
        ...(explicit ? { "app.model.cycleForward": "ctrl+p" } : {}),
      };
      const f = fixture([], config);
      assert.equal(f.kb.matches(UP, "tui.editor.cursorUp"), true);
      assert.equal(f.kb.matches(UP, "app.model.cycleForward"), true);
      f.editor.handleInput(UP);
      assert.deepEqual(f.editor.getCursor(), { line: 1, col: 2 });
      assert.deepEqual(f.fired, []);
      // The extension probe declines; cursor ownership still beats the app.
      assert.deepEqual(f.forwarded, [UP]);
      const claimed = fixture(["3", "d"], config);
      const claimBefore = claimed.snapshot();
      claimed.editor.onExtensionShortcut = (data) => {
        claimed.forwarded.push(data);
        return true;
      };
      claimed.editor.handleInput(UP);
      assert.deepEqual(claimed.forwarded, [UP]);
      assert.deepEqual(claimed.fired, []);
      assert.deepEqual(claimed.snapshot(), claimBefore);
      assertNoPending(claimed.state);
      f.editor.handleInput("i");
      const before = f.snapshot();
      f.editor.handleInput(UP);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.fired, ["app.model.cycleForward"]);
      // No host manager mutation to manufacture single-action ownership.
      assert.equal(f.kb.matches(UP, "app.model.cycleForward"), true);
    }
  });

  it("keeps literal arguments, EX, Escape, undo and paste out of translation", () => {
    for (const setup of [["f"], ["t"], ["r"], ["d", "i"], ["Z"]]) {
      const f = fixture(setup, bindings);
      const before = f.snapshot();
      f.editor.handleInput(UP);
      assert.deepEqual(f.snapshot(), before);
      assertNoPending(f.state);
      assert.deepEqual(f.fired, []);
    }
    const ex = fixture([":", "q"], bindings);
    const before = ex.snapshot();
    ex.editor.handleInput(UP);
    assert.deepEqual(ex.snapshot(), { ...before, ex: ":ex-b" });
    ex.editor.handleInput(DOWN);
    assert.deepEqual(ex.snapshot(), before);
    for (const setup of [[], ["v"], ["3", "d"]]) {
      const f = fixture(setup, bindings);
      const snapshot = f.snapshot();
      sendKeys(f.editor, ["\x1b[200~", UP, DOWN, "\x1b[201~"]);
      assert.deepEqual(f.snapshot(), snapshot);
      assert.deepEqual(f.fired, []);
    }
    const reserved = fixture([], {
      "tui.editor.cursorUp": ["escape", "ctrl+r", "ctrl+_"],
    });
    const reference = fixture([]);
    for (const key of ["\x1b[114;5u", "\x1f", ESC]) {
      reserved.editor.handleInput(key);
      reference.editor.handleInput(key);
      assert.deepEqual(reserved.snapshot(), reference.snapshot());
      assert.deepEqual(reserved.fired, reference.fired);
    }
  });

  it("clamps counts and consumes no-op counts without recalling prompt history", () => {
    for (const setup of [[], ["d"], ["y"], ["v"], ["V"]]) {
      const actual = fixture(setup, bindings);
      const expected = fixture(setup);
      setInternalCursor(actual.editor, 0, 0);
      setInternalCursor(expected.editor, 0, 0);
      sendKeys(actual.editor, [..."999999999", UP]);
      sendKeys(expected.editor, [..."999999999", "k"]);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
      assert.equal(actual.state.historyIndex, -1);
      assertNoPending(actual.state);
      sendKeys(actual.editor, [ESC, "l"]);
      sendKeys(expected.editor, [ESC, "l"]);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
    }
  });

  it("shares logical sticky columns, grapheme movement and the existing EOL divergence", () => {
    const actual = fixture([], bindings);
    const expected = fixture([]);
    const text = `${"abcdef".repeat(8)}\nx\n${"abcdef".repeat(8)}\na👩🏽‍💻éz`;
    for (const f of [actual, expected]) {
      f.editor.setText(text);
      setInternalCursor(f.editor, 5, 0);
      f.editor.render(12);
    }
    for (const [input, vim] of [
      [DOWN, "j"],
      [DOWN, "j"],
      [UP, "k"],
      [UP, "k"],
    ]) {
      actual.editor.handleInput(input);
      expected.editor.handleInput(vim);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
    }
    assert.deepEqual(actual.editor.getCursor(), { line: 0, col: 5 });
    for (const f of [actual, expected]) setInternalCursor(f.editor, 1, 3);
    for (const [input, vim] of [
      ["\x1b[C", "l"],
      ["\x1b[C", "l"],
      ["\x1b[D", "h"],
    ]) {
      actual.editor.handleInput(input);
      expected.editor.handleInput(vim);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
    }
    // Intentional inherited Pi divergence: hjkl can reach the EOL space.
    sendKeys(actual.editor, ["9", "\x1b[C"]);
    sendKeys(expected.editor, ["9", "l"]);
    assert.deepEqual(actual.snapshot(), expected.snapshot());
    assert.equal(actual.editor.getCursor().col, "a👩🏽‍💻éz".length);
  });

  it("retains paste's existing display-column reset before alias translation", () => {
    for (const paste of [
      ["\x1b[200~ignored\x1b[201~"],
      ["\x1b[200~", UP, DOWN, "\x1b[201~"],
    ]) {
      const f = fixture([], bindings);
      f.editor.setText("abcdefghij\nx\nabcdefghij");
      setInternalCursor(f.editor, 7, 0);
      f.editor.render(21);
      sendKeys(f.editor, ["g", DOWN]);
      assert.deepEqual(f.editor.getCursor(), { line: 1, col: 0 });
      sendKeys(f.editor, [...paste, "g", DOWN]);
      assert.deepEqual(f.editor.getCursor(), { line: 2, col: 0 });
      assert.equal(f.editor.getText(), "abcdefghij\nx\nabcdefghij");
    }
  });

  it("records canonical motions for dot, undo, redo and redo invalidation", () => {
    const actual = fixture([], {
      ...bindings,
      "tui.editor.cursorUp": "h",
      "tui.editor.cursorDown": "k",
      "app.model.select": "k",
    });
    const expected = fixture([]);
    for (const f of [actual, expected]) setInternalCursor(f.editor, 0, 4);
    // h aliases k; recorded k must neither alias j nor trigger an app action.
    for (const [input, vim] of [
      ["d", "d"],
      ["h", "k"],
      [".", "."],
      ["u", "u"],
      ["\x12", "\x12"],
      ["u", "u"],
      ["x", "x"],
      ["\x12", "\x12"],
    ]) {
      actual.editor.handleInput(input);
      expected.editor.handleInput(vim);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
      assert.deepEqual(actual.fired, []);
    }
    assert.equal(actual.state.redoStack.length, 0);
  });

  it("replays counted vertical operators without history recall and honors historyNavigation=false", () => {
    const actual = fixture([], bindings);
    const expected = fixture([]);
    for (const f of [actual, expected]) setInternalCursor(f.editor, 0, 4);
    for (const [input, vim] of [
      ["2", "2"],
      ["d", "d"],
      [UP, "k"],
      [".", "."],
      ["u", "u"],
      ["\x12", "\x12"],
    ]) {
      actual.editor.handleInput(input);
      expected.editor.handleInput(vim);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
      assert.equal(actual.state.historyIndex, -1);
    }
    const f = fixture([], bindings);
    f.editor.setHistoryNavigation(false);
    setInternalCursor(f.editor, 2, 0);
    const before = f.snapshot();
    f.editor.handleInput(UP);
    assert.deepEqual(f.snapshot(), before);
    // A harmless motion retains the seeded redo; a real edit clears it.
    f.editor.handleInput("x");
    assert.equal(f.state.redoStack.length, 0);
  });

  it("leaves default/custom cursor dispatch untouched in stock compatibility fallback", () => {
    const actual = fixture(["i"], {
      ...bindings,
      "app.model.cycleForward": [],
    });
    const expected = fixture(["i"], {
      ...bindings,
      "app.model.cycleForward": [],
    });
    // Simulate failed whole-contract preflight, not a host-private action call.
    (
      actual.editor as unknown as { editorActionsAvailable: boolean }
    ).editorActionsAvailable = false;
    actual.editor.handleInput(UP);
    CustomEditor.prototype.handleInput.call(expected.editor, UP);
    assert.deepEqual(actual.snapshot(), expected.snapshot());
  });
});
