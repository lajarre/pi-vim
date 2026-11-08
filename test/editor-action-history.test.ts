import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import {
  EDITOR_BINDING_VARIANTS,
  withEditorBindings,
} from "./editor-action-fixtures.js";
import {
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const ESC = "\x1b";
const REDO = "\x12";
const REGISTER = "qx\nyz\n";
const INITIAL = "ab\ncd";

function fixture() {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const writes: string[] = [];
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setText(INITIAL);
  editor.setRegister(REGISTER);
  editor.handleInput(ESC);
  setInternalCursor(editor, 0);
  const history = editor as unknown as {
    undoStack: { stack: unknown[] };
    redoStack: unknown[];
  };
  history.undoStack.stack.length = 0;
  return { editor, writes, history };
}

function snapshot(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

for (const variant of ["default", ...EDITOR_BINDING_VARIANTS] as const) {
  function withBindings(run: () => void) {
    if (variant === "default") run();
    else withEditorBindings(variant, run);
  }

  describe(`editor action history with ${variant} bindings`, () => {
    for (const [keys, text, undoCol, register, writes] of [
      [["D"], "\ncd", 0, "ab", ["ab"]],
      [["C", "Z", ESC], "Z\ncd", 0, "ab", ["ab"]],
      [["S", "Z", ESC], "Z\ncd", 0, "ab", ["ab"]],
      [["o", "Z", ESC], "ab\nZ\ncd", 2, REGISTER, []],
      [["O", "Z", ESC], "Z\nab\ncd", 0, REGISTER, []],
      [["2", "p"], "ab\nqx\nyz\nqx\nyz\ncd", 2, REGISTER, []],
      [["2", "P"], "qx\nyz\nqx\nyz\nab\ncd", 0, REGISTER, []],
    ] as const) {
      it(`${keys.join("")} is one undo window, clamps, and redoes once`, () =>
        withBindings(() => {
          const f = fixture();
          sendKeys(f.editor, [...keys]);
          const changed = snapshot(f.editor);
          assert.equal(changed.text, text);
          assert.equal(changed.mode, "normal");
          assert.equal(changed.register, register);
          assert.deepEqual(f.writes, writes);
          assert.equal(f.history.undoStack.stack.length, 1);

          sendKeys(f.editor, ["9", "u"]);
          // Pi snapshots after o/p's EOL positioning, unlike nvim. Keep this
          // existing cursor divergence explicit rather than masking with 0.
          assert.deepEqual(snapshot(f.editor), {
            text: INITIAL,
            cursor: { line: 0, col: undoCol },
            mode: "normal",
            register,
          });
          assert.equal(f.history.undoStack.stack.length, 0);
          assert.equal(f.history.redoStack.length, 1);
          sendKeys(f.editor, ["u", "z", "h", "9", REDO]);
          assert.deepEqual(snapshot(f.editor), changed);
          assert.equal(f.history.redoStack.length, 0);
          sendKeys(f.editor, [REDO]);
          assert.deepEqual(snapshot(f.editor), changed);
          assert.equal(f.history.undoStack.stack.length, 1);
          assert.deepEqual(f.writes, writes);
        }));
    }

    it("multiline 2P and dot keep copies intact and separate undo windows", () =>
      withBindings(() => {
        const f = fixture();
        sendKeys(f.editor, ["2", "P", "."]);
        assert.deepEqual(snapshot(f.editor), {
          text: REGISTER.repeat(4) + INITIAL,
          cursor: { line: 0, col: 0 },
          mode: "normal",
          register: REGISTER,
        });
        assert.equal(f.history.undoStack.stack.length, 2);
        sendKeys(f.editor, ["u"]);
        assert.equal(f.editor.getText(), REGISTER.repeat(2) + INITIAL);
        sendKeys(f.editor, ["u"]);
        assert.equal(f.editor.getText(), INITIAL);
        sendKeys(f.editor, ["2", REDO]);
        assert.equal(f.editor.getText(), REGISTER.repeat(4) + INITIAL);
        assert.deepEqual(f.writes, []);
      }));

    it("harmless input preserves redo but a real direct edit invalidates it", () =>
      withBindings(() => {
        const f = fixture();
        sendKeys(f.editor, ["2", "P", "u", "9", "u", "l"]);
        assert.deepEqual(f.editor.getCursor(), { line: 0, col: 1 });
        assert.equal(f.history.redoStack.length, 1);
        sendKeys(f.editor, ["h", "z", REDO]);
        assert.equal(f.editor.getText(), REGISTER.repeat(2) + INITIAL);
        sendKeys(f.editor, ["u", "O", "Z", ESC]);
        const edited = snapshot(f.editor);
        assert.equal(edited.text, "Z\nab\ncd");
        assert.equal(f.history.redoStack.length, 0);
        sendKeys(f.editor, [REDO]);
        assert.deepEqual(snapshot(f.editor), edited);
        sendKeys(f.editor, ["u", REDO]);
        assert.deepEqual(snapshot(f.editor), edited);
        assert.deepEqual(f.writes, []);
      }));
  });
}
