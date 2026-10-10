import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import type { PiEditorAction } from "../pi-editor-actions.js";
import { stubKeybindings, stubTheme, stubTui } from "./harness.js";

const ACTIONS = [
  "undo",
  "moveToLineStart",
  "moveToLineEnd",
  "deleteToEndOfLine",
  "addNewLine",
  "moveCursor",
  "insertCharacter",
] as const satisfies readonly PiEditorAction[0][];

describe("editor action compatibility preflight", () => {
  for (const action of ACTIONS) {
    for (const value of [undefined, false]) {
      it(`${action}=${String(value)} notifies once before any input changes state`, () => {
        const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
        const notifications: string[] = [];
        const changes: string[] = [];
        const writes: string[] = [];
        let submits = 0;
        let shortcuts = 0;
        editor.setNotifyFn((message) => notifications.push(message));
        editor.setClipboardFn((text) => writes.push(text));
        editor.setClipboardReadFn(() => null);
        editor.setText("keep\ntext");
        editor.setRegister("register\n");
        editor.onChange = (text) => changes.push(text);
        editor.onSubmit = () => {
          submits++;
        };
        editor.onExtensionShortcut = () => {
          shortcuts++;
          return true;
        };
        Object.defineProperty(editor, action, { value, configurable: true });
        const history = editor as unknown as {
          undoStack: { stack: unknown[] };
          redoStack: unknown[];
        };
        const before = structuredClone({
          text: editor.getText(),
          cursor: editor.getCursor(),
          mode: editor.getMode(),
          undo: history.undoStack.stack,
          redo: history.redoStack,
        });
        assert.doesNotThrow(() => {
          for (const key of [
            "\x1b",
            "2",
            "P",
            "D",
            "o",
            "Z",
            "u",
            "\x12",
            "\r",
          ]) {
            editor.handleInput(key);
          }
        });
        assert.deepEqual(
          {
            text: editor.getText(),
            cursor: editor.getCursor(),
            mode: editor.getMode(),
            undo: history.undoStack.stack,
            redo: history.redoStack,
          },
          before,
        );
        assert.equal(editor.getRegister(), "register\n");
        assert.deepEqual(writes, []);
        assert.deepEqual(changes, []);
        assert.equal(submits, 0);
        assert.equal(shortcuts, 0);
        assert.equal(notifications.length, 1);
        assert.match(
          notifications[0],
          new RegExp(`${action}\\(\\) unavailable`),
        );
        assert.match(notifications[0], /input disabled/);
      });
    }
  }

  it("does not swallow unrelated host operation errors", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    const failure = new Error("host operation failed");
    Object.defineProperty(editor, "moveToLineEnd", {
      value: () => {
        throw failure;
      },
    });
    editor.handleInput("\x1b");
    assert.throws(
      () => editor.handleInput("A"),
      (error) => error === failure,
    );
  });
});
