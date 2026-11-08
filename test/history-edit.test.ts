import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import { sendKeys, stubKeybindings, stubTheme, stubTui } from "./harness.js";

const REDO = "\x12";

function fixture() {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const writes: string[] = [];
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setRegister("keep");
  editor.handleInput("\x1b");
  editor.addToHistory("older");
  editor.addToHistory("one\ntwo");
  const state = editor as unknown as {
    historyIndex: number;
    redoStack: unknown[];
    undoStack: { stack: unknown[] };
  };
  return { editor, state, writes };
}

function snapshot(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

// Prompt recall is an intentional non-Vim host feature. Once edited, the
// recalled text behaves like any draft: counted edge motions stay buffer-local,
// while bare k at the first logical line starts a fresh browse.
describe("edits end host prompt browsing", () => {
  for (const keys of [["J"], ["g", "J"]]) {
    for (const repeat of [false, true]) {
      it(`${repeat ? "dot-" : ""}${keys.join("")} keeps the edited recall through counted edge motions and undo`, () => {
        const { editor, state, writes } = fixture();
        if (repeat) {
          sendKeys(editor, ["k", "g", "g", ...keys, "u", "u"]);
          assert.equal(editor.getText(), "");
        }
        sendKeys(editor, ["k", "g", "g"]);
        const recalled = snapshot(editor);
        sendKeys(editor, repeat ? ["."] : keys);
        const joined = {
          text: keys.length === 1 ? "one two" : "onetwo",
          cursor: { line: 0, col: 3 },
          mode: "normal",
          register: "keep",
        };
        assert.deepEqual(snapshot(editor), joined);
        assert.equal(state.historyIndex, -1);
        assert.equal(state.undoStack.stack.length, 2);
        assert.equal(state.redoStack.length, 0);
        sendKeys(editor, ["j", "1", "k", "z"]);
        assert.deepEqual(snapshot(editor), joined);
        assert.equal(state.historyIndex, -1);
        editor.handleInput("u");
        assert.deepEqual(snapshot(editor), recalled);
        assert.equal(state.historyIndex, -1);
        assert.equal(state.redoStack.length, 1);
        editor.handleInput(REDO);
        assert.deepEqual(snapshot(editor), joined);
        assert.equal(state.historyIndex, -1);
        assert.equal(state.redoStack.length, 0);
        sendKeys(editor, ["u", "u", "u"]);
        assert.equal(editor.getText(), "");
        sendKeys(editor, ["9", REDO, REDO]);
        assert.deepEqual(snapshot(editor), joined);
        assert.deepEqual(writes, []);
      });
    }

    it(`no-op ${keys.join("")} preserves browsing and creates no undo unit`, () => {
      const { editor, state, writes } = fixture();
      editor.handleInput("k");
      const before = snapshot(editor);
      const depth = state.undoStack.stack.length;
      sendKeys(editor, keys);
      assert.deepEqual(snapshot(editor), before);
      assert.equal(state.historyIndex, 0);
      assert.equal(state.undoStack.stack.length, depth);
      editor.handleInput("j");
      assert.equal(editor.getText(), "");
      assert.deepEqual(writes, []);
    });

    it(`${keys.join("")} clears stale redo only on a real edit`, () => {
      const { editor, state, writes } = fixture();
      sendKeys(editor, ["k", "g", "g", ...keys, "u", "G"]);
      assert.equal(state.redoStack.length, 1);
      sendKeys(editor, keys);
      assert.equal(state.redoStack.length, 1);
      sendKeys(editor, ["g", "g", ...keys]);
      assert.equal(state.redoStack.length, 0);
      const after = snapshot(editor);
      editor.handleInput(REDO);
      assert.deepEqual(snapshot(editor), after);
      assert.deepEqual(writes, []);
    });
  }

  it("a new browse saves an edited recall as its own draft and undo anchor", () => {
    const { editor, state, writes } = fixture();
    sendKeys(editor, ["k", "g", "g", "x"]);
    const edited = snapshot(editor);
    assert.equal(state.historyIndex, -1);
    sendKeys(editor, ["k", "g", "g", "k", "j", "j"]);
    assert.deepEqual(snapshot(editor), edited);
    assert.equal(state.historyIndex, -1);
    assert.equal(state.undoStack.stack.length, 3);
    editor.handleInput("u");
    assert.deepEqual(snapshot(editor), edited);
    // Undoing the identical returned draft consumes the host anchor, not a
    // new redo unit; this is the existing snapshot-change policy.
    assert.equal(state.redoStack.length, 0);
    editor.handleInput("u");
    assert.equal(editor.getText(), "one\ntwo");
    assert.equal(state.redoStack.length, 1);
    assert.deepEqual(writes, ["o"]);
  });

  it("1J is harmless and consumes its count while browsing", () => {
    const { editor, state, writes } = fixture();
    sendKeys(editor, ["k", "1", "J"]);
    assert.equal(editor.getText(), "one\ntwo");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
    assert.equal(state.historyIndex, 0);
    assert.equal(state.undoStack.stack.length, 1);
    editor.handleInput("j");
    assert.equal(editor.getText(), "");
    assert.equal(state.historyIndex, -1);
    assert.deepEqual(writes, []);
  });

  for (const [keys, text, col, register, mirrored] of [
    [["x"], "ne\ntwo", 0, "o", ["o"]],
    [["p"], "okeepne\ntwo", 4, "keep", []],
    [["r", "X"], "Xne\ntwo", 0, "keep", []],
    [["v", "d"], "ne\ntwo", 0, "o", ["o"]],
  ] as const) {
    it(`${keys.join("")} also exits browsing without changing register policy`, () => {
      const { editor, state, writes } = fixture();
      sendKeys(editor, ["k", "g", "g", ...keys]);
      const edited = {
        text,
        cursor: { line: 0, col },
        mode: "normal",
        register,
      };
      assert.deepEqual(snapshot(editor), edited);
      assert.equal(state.historyIndex, -1);
      sendKeys(editor, ["1", "k"]);
      assert.deepEqual(snapshot(editor), edited);
      sendKeys(editor, ["G", "j"]);
      assert.equal(editor.getText(), text);
      assert.equal(state.historyIndex, -1);
      const bottom = snapshot(editor);
      editor.handleInput("u");
      assert.equal(editor.getText(), "one\ntwo");
      assert.equal(state.historyIndex, -1);
      editor.handleInput(REDO);
      assert.deepEqual(snapshot(editor), bottom);
      assert.deepEqual(writes, mirrored);
    });
  }
});
