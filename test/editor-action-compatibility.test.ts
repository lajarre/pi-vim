import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import installPiVim, { ModalEditor } from "../index.js";
import {
  type PiEditorAction,
  probePiEditorCursor,
} from "../pi-editor-actions.js";
import { setPiVimSettingsReaderForTests } from "../settings.js";
import {
  createCursorShapeTui,
  createExtensionApiHarness,
  sendKeys,
  setInternalCursor,
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
] as const satisfies readonly PiEditorAction[0][];

// Host presentation capability, intentionally outside nvim's text oracle.
describe("cursor marker preflight", () => {
  for (const cell of [
    " ",
    "\x1b[7m \x1b[0m",
    "\x1b[7m \x1b[27m",
    "\x1b_pi:fc\x07 \x1b_pi:/fc\x07",
  ]) {
    it(`locates the EOL cell using ${JSON.stringify(cell)}`, (t) => {
      const render = t.mock.method(
        CustomEditor.prototype,
        "render",
        function (this: CustomEditor, width: number) {
          assert.equal(width, 16);
          assert.equal(this.focused, true);
          assert.equal(this.getText(), "a");
          assert.deepEqual(this.getCursor(), { line: 0, col: 1 });
          return [
            "─".repeat(width),
            `a${CURSOR_MARKER}${cell}${" ".repeat(14)}`,
            "─".repeat(width),
          ];
        },
      );
      assert.equal(
        probePiEditorCursor(stubTui, stubTheme, stubKeybindings),
        true,
      );
      assert.equal(render.mock.callCount(), 1);
    });
  }

  for (const row of [
    "a ",
    `${CURSOR_MARKER}a `,
    `ab${CURSOR_MARKER} `,
    `a${CURSOR_MARKER}\x1b_unknown\x07 `,
    `a${CURSOR_MARKER}\x1b_pi:fc\x07 `,
    `a${CURSOR_MARKER}\x1b[7m `,
    `a${CURSOR_MARKER}\x1b_pi:fc\x07 \x1b_pi:/fc\x07\x1b_unterminated`,
    `a${CURSOR_MARKER}x`,
  ]) {
    it(`rejects unknown or misplaced metadata: ${JSON.stringify(row)}`, (t) => {
      t.mock.method(CustomEditor.prototype, "render", () => [
        "border",
        row,
        "border",
      ]);
      assert.equal(
        probePiEditorCursor(stubTui, stubTheme, stubKeybindings),
        false,
      );
    });
  }

  it("accepts the installed host without terminal writes or render requests", () => {
    const tui = createCursorShapeTui();
    tui.requestRender = () => assert.fail("probe scheduled a live render");
    assert.equal(probePiEditorCursor(tui, stubTheme, stubKeybindings), true);
    assert.deepEqual(tui.terminalWrites, []);
    assert.deepEqual(tui.hardwareCursorValues, []);
  });

  for (const throws of [false, true]) {
    it(`warns once and disables only paint when the probe ${throws ? "throws" : "fails"}`, (t) => {
      const tui = createCursorShapeTui();
      const editor = new ModalEditor(tui, stubTheme, stubKeybindings, {
        selectionColorizer: (text) => `\x1b[44m${text}\x1b[49m`,
      });
      const warnings: string[] = [];
      const writes: string[] = [];
      const changes: string[] = [];
      editor.setNotifyFn((text) => warnings.push(text));
      editor.setClipboardFn((text) => writes.push(text));
      editor.setClipboardReadFn(() => null);
      editor.setText("abcd");
      setInternalCursor(editor, 0);
      editor.setRegister("keep");
      editor.onChange = (text) => changes.push(text);
      editor.focused = true;
      const internals = editor as unknown as {
        undoStack: { stack: unknown[] };
        redoStack: unknown[];
        historyIndex: number;
      };
      const state = () => ({
        text: editor.getText(),
        cursor: editor.getCursor(),
        mode: editor.getMode(),
        register: editor.getRegister(),
        undo: internals.undoStack.stack,
        redo: internals.redoStack,
        historyIndex: internals.historyIndex,
      });
      const before = structuredClone(state());
      const hostRender = CustomEditor.prototype.render;
      let probes = 0;
      t.mock.method(
        CustomEditor.prototype,
        "render",
        function (this: CustomEditor, width: number) {
          if (this === editor) return hostRender.call(this, width);
          probes++;
          if (throws) throw new Error("new host render contract");
          return ["border", "unknown cursor grammar", "border"];
        },
      );
      assert.equal(editor.preflightHost(), true);
      assert.equal(editor.preflightHost(), true);
      assert.equal(probes, 1);
      assert.deepEqual(state(), before);
      assert.deepEqual(writes, []);
      assert.deepEqual(changes, []);
      assert.deepEqual(tui.terminalWrites, []);
      assert.deepEqual(tui.hardwareCursorValues, []);
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0],
        /Visual highlighting disabled.*Vim editing remains enabled/,
      );
      sendKeys(editor, ["\x1b", "0", "v", "l"]);
      const rows = editor.render(20);
      assert.ok(rows.at(-1)?.includes(" VISUAL "));
      assert.ok(!rows.join("").includes("\x1b[44m"));
      assert.ok(tui.terminalWrites.join("").includes("\x1b[1 q"));
      editor.handleInput("y");
      assert.equal(editor.getRegister(), "ab");
      assert.deepEqual(writes, ["ab"]);
      assert.equal(editor.getMode(), "normal");
      sendKeys(editor, ["p", "u"]);
      assert.equal(editor.getText(), "abcd");
      editor.handleInput("\x12");
      assert.equal(editor.getText(), "aabbcd");
      sendKeys(editor, [":", "x", "\r"]);
      assert.match(warnings[1], /Reserved ex command/);
      editor.render(20);
      assert.equal(probes, 1);
      assert.equal(warnings.length, 2);
    });
  }

  it("runs once in the startup factory before the first input or live render", async (t) => {
    const restore = setPiVimSettingsReaderForTests(() => ({}));
    const pi = createExtensionApiHarness();
    const warnings: string[] = [];
    let editor: ModalEditor | undefined;
    const render = t.mock.method(CustomEditor.prototype, "render", () => [
      "border",
      "changed grammar",
      "border",
    ]);
    try {
      installPiVim(pi);
      await pi.emit("session_start", undefined, {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          theme: stubTheme,
          notify: (text: string) => warnings.push(text),
          setEditorComponent(
            factory: (
              ...args: ConstructorParameters<typeof CustomEditor>
            ) => ModalEditor,
          ) {
            editor = factory(stubTui, stubTheme, stubKeybindings);
          },
        },
      });
      assert.ok(editor);
      assert.equal(render.mock.callCount(), 1);
      assert.equal(warnings.length, 1);
      assert.equal(editor.preflightHost(), true);
      assert.equal(render.mock.callCount(), 1);
      sendKeys(editor, ["abc", "\x1b", "0", "x"]);
      assert.equal(editor.getText(), "bc");
    } finally {
      await pi.emit("session_shutdown");
      restore();
    }
  });
});

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
        // host itself still needs that name (for example moveCursor), so expose
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

        const moreInput = ["\x1b", "jk", "\r", "/reload", "\r", "/quit", "\r"];
        for (const data of moreInput) editor.handleInput(data);
        assert.deepEqual(forwarded, ["a", "b", "c", "\r", ...moreInput]);
        assert.deepEqual(submits, ["abc", "jk", "/reload", "/quit"]);
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
