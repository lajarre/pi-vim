import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ModalEditor } from "../index.js";
import type { PiEditorAction } from "../pi-editor-actions.js";
import {
  createCursorShapeTui,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const ACTIONS = [
  "undo",
  "navigateHistory",
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
      it(`${action}=${String(value)} warns once and uses stock input/rendering`, (t) => {
        const tui = createCursorShapeTui();
        const theme = { ...stubTheme, borderColor: (s: string) => `host:${s}` };
        const color = (s: string) => `vim:${s}`;
        const editor = new ModalEditor(tui, theme, stubKeybindings, {
          labelColorizers: {
            insert: color,
            normal: color,
            visual: color,
            ex: color,
          },
          borderColorizers: {
            insert: color,
            normal: color,
            visual: color,
            ex: color,
          },
          borderSync: {
            insert: "mode",
            normal: "mode",
            visual: "mode",
            ex: "mode",
          },
        });
        const stock = new CustomEditor(
          createCursorShapeTui(),
          theme,
          stubKeybindings,
        );
        editor.focused = stock.focused = true;
        const notifications: string[] = [];
        const writes: string[] = [];
        const submits: string[] = [];
        const forwarded: string[] = [];
        const modeChanges: string[] = [];
        editor.setNotifyFn((message) => notifications.push(message));
        editor.setClipboardFn((text) => writes.push(text));
        editor.setClipboardReadFn(() => null);
        editor.setText("keep\ntext");
        stock.setText("keep\ntext");
        editor.setRegister("register\n");
        editor.setModeChangeFn((mode) => modeChanges.push(mode));
        editor.onSubmit = (text) => submits.push(text);
        editor.onExtensionShortcut = (data) => data === "\x1b";
        stock.onExtensionShortcut = editor.onExtensionShortcut;

        // Model an upgraded host whose public input path still works but whose
        // old private action name is unavailable to the adapter. The installed
        // host itself still needs that name (notably insertCharacter), so expose
        // it only while exercising its real, otherwise unchanged dispatcher.
        const hostAction = (editor as unknown as Record<string, unknown>)[
          action
        ];
        const hostInput = CustomEditor.prototype.handleInput;
        Object.defineProperty(editor, action, { value, configurable: true });
        t.mock.method(
          CustomEditor.prototype,
          "handleInput",
          function (this: CustomEditor, data: string) {
            if (this !== editor) return hostInput.call(this, data);
            forwarded.push(data);
            Object.defineProperty(editor, action, {
              value: hostAction,
              configurable: true,
            });
            try {
              hostInput.call(this, data);
            } finally {
              Object.defineProperty(editor, action, {
                value,
                configurable: true,
              });
            }
          },
        );

        const history = editor as unknown as {
          undoStack: { stack: unknown[] };
          redoStack: unknown[];
        };
        const state = () => ({
          text: editor.getText(),
          cursor: editor.getCursor(),
          mode: editor.getMode(),
          register: editor.getRegister(),
          undo: history.undoStack.stack,
          redo: history.redoStack,
        });
        history.redoStack.push({ text: "redo", cursor: { line: 0, col: 1 } });
        const before = structuredClone(state());
        // Rendering can precede input: preflight itself must not edit state,
        // claim the cursor, recolor the border, or display a Vim mode label.
        assert.deepEqual(editor.render(80), stock.render(80));
        assert.deepEqual(state(), before);
        assert.equal(notifications.length, 1);
        assert.match(
          notifications[0],
          new RegExp(`${action}\\(\\) unavailable`),
        );
        assert.match(notifications[0], /stock Pi editor/);
        assert.deepEqual(tui.terminalWrites, []);
        assert.deepEqual(tui.hardwareCursorValues, []);
        assert.deepEqual(forwarded, []);

        // Start the input assertions empty only after checking preflight kept
        // the seeded buffer, cursor and both histories intact.
        editor.setText("");
        stock.setText("");
        for (const data of ["a", "b", "c"]) {
          editor.handleInput(data);
          stock.handleInput(data);
        }
        assert.equal(editor.getText(), "abc");
        assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
        assert.deepEqual(editor.render(80), stock.render(80));
        assert.doesNotMatch(
          editor.render(80).join("\n"),
          /INSERT|NORMAL|VISUAL|V-LINE|vim:/,
        );
        editor.handleInput("\r");
        assert.deepEqual(submits, ["abc"]);
        assert.equal(editor.getText(), "");

        const moreInput = [
          "\x1b",
          "text",
          "\r",
          "/reload",
          "\r",
          "/quit",
          "\r",
        ];
        for (const data of moreInput) editor.handleInput(data);
        assert.deepEqual(forwarded, ["a", "b", "c", "\r", ...moreInput]);
        assert.deepEqual(submits, ["abc", "text", "/reload", "/quit"]);
        assert.equal(editor.getText(), "");
        assert.equal(notifications.length, 1);
        assert.equal(editor.getRegister(), "register\n");
        assert.deepEqual(writes, []);
        assert.deepEqual(modeChanges, []);
        assert.deepEqual(tui.terminalWrites, []);
        assert.deepEqual(tui.hardwareCursorValues, []);
        // Later host border assignments remain visible in degraded mode.
        editor.borderColor = stock.borderColor = (s: string) => `new-host:${s}`;
        stock.handleInput("\r");
        assert.deepEqual(editor.render(80), stock.render(80));
        assert.deepEqual(tui.terminalWrites, []);
        assert.deepEqual(tui.hardwareCursorValues, []);
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
