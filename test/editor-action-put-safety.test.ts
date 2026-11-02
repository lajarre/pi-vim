import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ModalEditor } from "../index.js";
import {
  EDITOR_BINDING_VARIANTS,
  withEditorBindings,
} from "./editor-action-fixtures.js";
import {
  sendKeys,
  setInternalCursor,
  stripHostCursorMarkers,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

function fixture(text: string, source: "register" | "clipboard") {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const writes: string[] = [];
  let submits = 0;
  editor.setClipboardFn((value) => writes.push(value));
  editor.setClipboardReadFn(() => (source === "clipboard" ? text : null));
  editor.setText("ab");
  editor.setRegister(source === "register" ? text : "keep");
  editor.handleInput("\x1b");
  setInternalCursor(editor, 0);
  editor.onSubmit = () => {
    submits++;
  };
  return {
    editor,
    writes,
    get submits() {
      return submits;
    },
  };
}

for (const variant of EDITOR_BINDING_VARIANTS) {
  describe(`safe register puts with ${variant} bindings`, () => {
    for (const source of ["register", "clipboard"] as const) {
      for (const key of ["p", "P"]) {
        it(`${source} ${key} cannot render terminal control sequences (intentional nvim divergence)`, () =>
          withEditorBindings(variant, () => {
            const text = "\x1b]52;c;SGVsbG8=\x07\x9d52;c;Yg==\x9cZ";
            const safe = "]52;c;SGVsbG8=52;c;Yg==Z";
            const f = fixture(text, source);
            sendKeys(f.editor, [key]);
            assert.equal(
              f.editor.getText(),
              key === "p" ? `a${safe}b` : `${safe}ab`,
            );
            assert.deepEqual(f.editor.getCursor(), {
              line: 0,
              col: safe.length - (key === "P" ? 1 : 0),
            });
            assert.equal(f.editor.getMode(), "normal");
            assert.equal(
              f.editor.getRegister(),
              source === "register" ? text : "keep",
            );
            assert.deepEqual(f.writes, []);
            assert.equal(f.submits, 0);
            const rendered = stripHostCursorMarkers(
              f.editor.render(80).join("\n"),
            );
            assert.equal(rendered.includes("\x1b]52;"), false);
            for (const control of ["\x07", "\x9d", "\x9c"]) {
              assert.equal(rendered.includes(control), false);
            }
            sendKeys(f.editor, ["u"]);
            assert.equal(f.editor.getText(), "ab");
            sendKeys(f.editor, ["\x12"]);
            assert.equal(
              f.editor.getText(),
              key === "p" ? `a${safe}b` : `${safe}ab`,
            );
          }));
      }

      it(`${source} CRLF/CR and tabs follow Pi normalization (intentional nvim divergence)`, () =>
        withEditorBindings(variant, () => {
          const text = "\tqx\r\nyz\r";
          const f = fixture(text, source);
          sendKeys(f.editor, ["2", "P"]);
          assert.equal(f.editor.getText(), "    qx\nyz\n    qx\nyz\nab");
          assert.deepEqual(f.editor.getCursor(), { line: 0, col: 4 });
          assert.equal(f.editor.getMode(), "normal");
          assert.equal(
            f.editor.getRegister(),
            source === "register" ? text : "keep",
          );
          assert.deepEqual(f.writes, []);
          assert.equal(f.submits, 0);
        }));
    }

    for (const text of ["X", "e\u0301👩‍💻", "qx\nyz", "qx\nyz\n"]) {
      for (const key of ["p", "P"]) {
        it(`${key} inserts each ${JSON.stringify(text)} copy atomically, preserving undo and repeat`, (t) =>
          withEditorBindings(variant, () => {
            const f = fixture(text, "register");
            const history = f.editor as unknown as {
              undoStack: { stack: unknown[] };
            };
            history.undoStack.stack.length = 0;
            const insert = CustomEditor.prototype.insertTextAtCursor;
            const calls: string[] = [];
            t.mock.method(
              CustomEditor.prototype,
              "insertTextAtCursor",
              function (this: CustomEditor, value: string) {
                calls.push(value);
                insert.call(this, value);
              },
            );
            let changes = 0;
            const onChange = f.editor.onChange;
            f.editor.onChange = (value) => {
              changes++;
              onChange?.(value);
            };
            sendKeys(f.editor, ["3", key]);
            const after = f.editor.getText();
            const cursor = f.editor.getCursor();
            const linewise = text.endsWith("\n");
            assert.deepEqual(
              calls,
              Array(3).fill(linewise ? text.slice(0, -1) : text),
            );
            assert.equal(changes, linewise ? 6 : 3);
            assert.equal(history.undoStack.stack.length, 1);
            assert.equal(f.editor.getRegister(), text);
            assert.equal(f.editor.getMode(), "normal");
            assert.deepEqual(f.writes, []);
            sendKeys(f.editor, ["u", "u"]);
            assert.equal(f.editor.getText(), "ab");
            assert.equal(history.undoStack.stack.length, 0);
            sendKeys(f.editor, ["\x12", "\x12"]);
            assert.equal(f.editor.getText(), after);
            assert.deepEqual(f.editor.getCursor(), cursor);
            assert.equal(history.undoStack.stack.length, 1);
            sendKeys(f.editor, ["."]);
            assert.equal(calls.length, 6);
            assert.equal(history.undoStack.stack.length, 2);
            sendKeys(f.editor, ["u"]);
            assert.equal(f.editor.getText(), after);
            sendKeys(f.editor, ["p", "\x12"]);
            assert.equal(
              calls.length,
              7,
              "a new put consumes the old count and clears redo",
            );
            assert.equal(f.editor.getRegister(), text);
            assert.deepEqual(f.writes, []);
            assert.equal(f.submits, 0);
          }));
      }
    }

    it("control-only put consumes counts without moving or invalidating redo", () =>
      withEditorBindings(variant, () => {
        const controls = Array.from({ length: 160 }, (_, i) => i)
          .filter((i) => (i < 32 && ![9, 10, 13].includes(i)) || i >= 127)
          .map((i) => String.fromCharCode(i))
          .join("");
        const f = fixture(controls, "register");
        sendKeys(f.editor, ["D", "u"]);
        f.editor.setRegister(controls);
        sendKeys(f.editor, ["2", "p"]);
        assert.equal(f.editor.getText(), "ab");
        assert.deepEqual(f.editor.getCursor(), { line: 0, col: 0 });
        assert.equal(f.editor.getMode(), "normal");
        assert.equal(f.editor.getRegister(), controls);
        sendKeys(f.editor, ["l"]);
        assert.deepEqual(f.editor.getCursor(), { line: 0, col: 1 });
        sendKeys(f.editor, ["\x12"]);
        assert.equal(f.editor.getText(), "");
        assert.deepEqual(f.writes, ["ab"]);
        assert.equal(f.submits, 0);
      }));
  });
}
