import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import { findDisplayLineTarget } from "../visual.js";
import {
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
const ESC = "\x1b";
const REDO = "\x12";
function fixture(buffer = text, width: number | null = 20, col = 5, line = 0) {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const writes: string[] = [];
  const notifications: string[] = [];
  editor.setClipboardFn((value) => writes.push(value));
  editor.setClipboardReadFn(() => null);
  editor.setNotifyFn((message) => notifications.push(message));
  editor.setText(buffer);
  editor.setRegister("keep");
  editor.handleInput(ESC);
  setInternalCursor(editor, col, line);
  const state = editor as unknown as {
    undoStack: { clear(): void; stack: unknown[] };
    redoStack: unknown[];
    historyIndex: number;
    buildVisualLineMap: unknown;
  };
  state.undoStack.clear();
  if (width !== null) editor.render(width + 1);
  return { editor, writes, notifications, state };
}
function keys(editor: ModalEditor, input: string) {
  sendKeys(editor, [...input]);
}
function snapshot(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

describe("gj / gk display-line motions", () => {
  it("uses wrapped rows while j / k still use logical lines", () => {
    const { editor, writes } = fixture(`${text}\n${text}`);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 25 });
    keys(editor, "gk");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
    keys(editor, "j");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 5 });
    keys(editor, "k");
    assert.deepEqual(snapshot(editor), {
      text: `${text}\n${text}`,
      cursor: { line: 0, col: 5 },
      mode: "normal",
      register: "keep",
    });
    assert.deepEqual(writes, []);
  });

  it("uses no-wrap rows before the first render and the latest width afterward", () => {
    const { editor } = fixture(`${text}\n${text}`, null);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 5 });
    keys(editor, "gk");
    editor.render(21);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 25 });
    editor.render(11);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 35 });
    editor.setPaddingX(2);
    editor.render(24); // 20 text cells with padding, no reserved cursor cell.
    keys(editor, "gk");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 15 });
  });

  it("keeps a wanted cell through short and empty rows, but resets on 0 / h", () => {
    const { editor } = fixture(`${text.slice(0, 23)}\n\n${text}`, 20, 15);
    for (const cursor of [
      { line: 0, col: 22 },
      { line: 1, col: 0 },
      { line: 2, col: 15 },
    ]) {
      keys(editor, "gj");
      assert.deepEqual(editor.getCursor(), cursor);
    }
    keys(editor, "2gk0gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 20 });
    keys(editor, "hgj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 22 });
    keys(editor, "hgjgj");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 1 });
  });

  it("consumes counts after clamp, no-op and invalid operator suffixes", () => {
    for (const prefix of [
      "999999gj",
      "999999gk",
      "2dgz",
      "2dg2",
      "2dg\x1b",
      "2g\x1b",
      "2g2j",
    ]) {
      const { editor } = fixture(text, 20, 0);
      keys(editor, prefix);
      const before = editor.getText();
      const col = editor.getCursor().col;
      keys(editor, "x");
      assert.equal(
        editor.getText(),
        before.slice(0, col) + before.slice(col + 1),
        prefix,
      );
      assert.equal(editor.getMode(), "normal", prefix);
    }
  });

  it("never recalls history at top/bottom, including empty and unrendered buffers", () => {
    for (const width of [20, null]) {
      for (const buffer of ["", "abc"]) {
        for (const input of ["gk", "gj", "9gk", "9gj", "dgk", "ygj", "cgj"]) {
          const { editor, writes, state } = fixture(buffer, width, 0);
          editor.addToHistory("old prompt");
          const before = snapshot(editor);
          keys(editor, input);
          assert.deepEqual(snapshot(editor), before, input);
          assert.equal(state.historyIndex, -1);
          assert.equal(state.undoStack.stack.length, 0);
          assert.deepEqual(writes, []);
        }
      }
    }
  });

  it("multiplies operator counts and deletes an exclusive charwise range", () => {
    const buffer = text.repeat(3);
    const { editor, writes } = fixture(buffer);
    keys(editor, "2d2gj");
    assert.deepEqual(snapshot(editor), {
      text: buffer.slice(0, 5) + buffer.slice(85),
      cursor: { line: 0, col: 5 },
      mode: "normal",
      register: buffer.slice(5, 85),
    });
    assert.deepEqual(writes, [buffer.slice(5, 85)]);
    keys(editor, "u");
    assert.equal(editor.getText(), buffer);
    keys(editor, REDO);
    assert.equal(editor.getText(), buffer.slice(0, 5) + buffer.slice(85));
  });

  it("keeps display-row register writes when best-effort clipboard mirroring fails", async () => {
    for (const command of ["dgj", "ygj"]) {
      const { editor } = fixture();
      const attempts: string[] = [];
      editor.setClipboardFn((value) => {
        attempts.push(value);
        throw new Error("clipboard unavailable");
      });
      keys(editor, command);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      assert.deepEqual(snapshot(editor), {
        text: command === "dgj" ? text.slice(0, 5) + text.slice(25) : text,
        cursor: { line: 0, col: 5 },
        mode: "normal",
        register: text.slice(5, 25),
      });
      assert.deepEqual(attempts, [text.slice(5, 25)]);
    }
  });

  it("yanks backward exclusively, rewinds, mirrors, and does not open undo", () => {
    const { editor, writes, state } = fixture(text, 20, 25);
    keys(editor, "ygk");
    assert.deepEqual(snapshot(editor), {
      text,
      cursor: { line: 0, col: 5 },
      mode: "normal",
      register: text.slice(5, 25),
    });
    assert.deepEqual(writes, [text.slice(5, 25)]);
    assert.equal(state.undoStack.stack.length, 0);
  });

  it("extends Visual and V-Line; retains the documented V-delete column divergence", () => {
    for (const mode of ["v", "V"]) {
      const { editor, writes } = fixture(`${text}\nsecond`, 20, 25);
      keys(editor, `${mode}gk`);
      assert.equal(editor.getMode(), mode === "v" ? "visual" : "visual-line");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
      keys(editor, "d");
      assert.deepEqual(snapshot(editor), {
        text:
          mode === "v"
            ? `${text.slice(0, 5)}${text.slice(26)}\nsecond`
            : "second",
        cursor: { line: 0, col: mode === "v" ? 5 : 0 },
        mode: "normal",
        register: mode === "v" ? text.slice(5, 26) : `${text}\n`,
      });
      assert.deepEqual(writes, [editor.getRegister()]);
    }
  });

  it("replays dgj at current width, preserves redo on motion, and clears it on edits", () => {
    const { editor, state } = fixture(text.repeat(3));
    keys(editor, "dgj");
    const edited = editor.getText();
    keys(editor, "u");
    keys(editor, "gjgk");
    assert.equal(state.redoStack.length, 1);
    keys(editor, REDO);
    assert.equal(editor.getText(), edited);
    editor.render(11);
    keys(editor, ".");
    assert.equal(editor.getText(), edited.slice(0, 5) + edited.slice(15));
    keys(editor, "u");
    assert.equal(editor.getText(), edited);
    keys(editor, "x");
    const changed = snapshot(editor);
    keys(editor, REDO);
    assert.deepEqual(snapshot(editor), changed);
    keys(editor, "999u");
    assert.equal(editor.getText(), text.repeat(3));
  });

  it("clears wanted cells and rebuilds rows after public text replacement", () => {
    const { editor } = fixture(text.slice(0, 23), 20, 15);
    keys(editor, "gj");
    editor.setText(`${text}\n${text}`);
    setInternalCursor(editor, 1);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 21 });
  });

  it("uses host word wrapping rather than nvim's hard-wrap boundaries", () => {
    const { editor } = fixture("alpha beta gamma delta epsilon", 8, 2);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 8 });
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 13 });
  });

  it("measures wide cells and never lands inside a combining or emoji cluster", () => {
    const { editor } = fixture("中e\u0301😀".repeat(6), 8, 3);
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });
    keys(editor, "gk");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
    keys(editor, "dgj");
    assert.equal(editor.getRegister(), "😀中e\u0301😀");
    assert.equal(editor.getText(), `中e\u0301${"中e\u0301😀".repeat(4)}`);
  });

  it("follows host-expanded tabs, not Vim tabstop cells", () => {
    const { editor } = fixture("ab\tcd\tuvwxyz", 8, 2);
    assert.equal(editor.getText(), "ab    cd    uvwxyz");
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 8 });
    keys(editor, "gj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 14 });
  });

  it("resets row preference after gg and preserves it through Visual entry", () => {
    const { editor } = fixture(`${text.slice(0, 23)}\nxy\n${text}`, 20, 15);
    keys(editor, "gjgggj");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 20 });
    keys(editor, "0lllllllllllllllgjvgjgj");
    assert.deepEqual(editor.getCursor(), { line: 2, col: 15 });
    assert.equal(editor.getMode(), "visual");
  });

  it("failed edge operators preserve the prior dot command and undo history", () => {
    const { editor, state } = fixture(text, 20, 0);
    keys(editor, "xdgk.");
    assert.equal(editor.getText(), text.slice(2));
    assert.equal(state.undoStack.stack.length, 2);
    keys(editor, "u");
    assert.equal(editor.getText(), text.slice(1));
    keys(editor, "u");
    assert.equal(editor.getText(), text);
  });

  it("fails closed with a notice if the optional host layout changes", () => {
    for (const map of [
      undefined,
      () => {
        throw new Error("changed API");
      },
      () => [{ logicalLine: 0, startCol: 3, length: 10 }],
    ]) {
      const { editor, writes, notifications } = fixture();
      const before = snapshot(editor);
      Object.assign(editor, { buildVisualLineMap: map });
      keys(editor, "2dgj");
      assert.deepEqual(snapshot(editor), before);
      assert.deepEqual(writes, []);
      assert.equal(notifications.length, 1);
    }
  });

  it("rejects incomplete maps instead of using a partial operator target", () => {
    assert.equal(
      findDisplayLineTarget(
        [text],
        [{ logicalLine: 0, startCol: 0, length: 20 }],
        { line: 0, col: 5 },
        1,
        null,
      ),
      null,
    );
  });
});
