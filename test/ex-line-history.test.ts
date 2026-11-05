import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeybindingsManager as PiKeybindingsManager } from "@earendil-works/pi-coding-agent";
import { ModalEditor } from "../index.js";
import {
  createEditorWithSpy,
  sendKeys,
  stubTheme,
  stubTui,
} from "./harness.js";

const { KeybindingsManager } = (await import(
  new URL(
    "./core/keybindings.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
)) as {
  KeybindingsManager: new (
    bindings?: Record<string, string>,
  ) => PiKeybindingsManager;
};

const ESC = "\x1b";
const PREV = "\x10";
const NEXT = "\x0e";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function assertLine(editor: ModalEditor, line: string): void {
  assert.equal(editor.getMode(), "normal");
  assert.ok(editor.render(120).at(-1)?.endsWith(` EX :${line}_ `));
}

function submit(editor: ModalEditor, line: string): void {
  sendKeys(editor, [":", line, "\r"]);
}

function appFixture(bindings = {}) {
  const editor = new ModalEditor(
    stubTui,
    stubTheme,
    new KeybindingsManager(bindings),
  );
  const fired: string[] = [];
  const forwarded: string[] = [];
  editor.setClipboardFn(() => {});
  editor.setClipboardReadFn(() => null);
  editor.setText("prompt");
  editor.handleInput(ESC);
  for (const action of [
    "app.clear",
    "app.interrupt",
    "app.editor.external",
  ] as const) {
    editor.onAction(action, () => fired.push(action));
  }
  editor.onExtensionShortcut = (key) => {
    forwarded.push(key);
    return false;
  };
  submit(editor, "a");
  submit(editor, "b");
  sendKeys(editor, [":", "q"]);
  return { editor, fired, forwarded };
}

describe("EX line history", () => {
  for (const [encoding, prev, next] of [
    ["raw", PREV, NEXT],
    ["Kitty", "\x1b[112;5u", "\x1b[110;5u"],
    ["modifyOtherKeys", "\x1b[27;5;112~", "\x1b[27;5;110~"],
  ]) {
    it(`${encoding}: older/newer clamp and restore empty or typed drafts`, () => {
      const { editor } = createEditorWithSpy("prompt");
      submit(editor, "a");
      submit(editor, "b");
      for (const draft of ["", "x"]) {
        sendKeys(editor, [":", draft, next]);
        assertLine(editor, draft);
        editor.handleInput(prev);
        assertLine(editor, "b");
        editor.handleInput(prev);
        assertLine(editor, "a");
        editor.handleInput(prev);
        assertLine(editor, "a");
        editor.handleInput(next);
        assertLine(editor, "b");
        editor.handleInput(next);
        assertLine(editor, draft);
        editor.handleInput(next);
        assertLine(editor, draft);
        editor.handleInput(ESC);
      }
    });
  }

  it("history beats remapped clear/interrupt and extension interception", () => {
    for (const [prev, next] of [
      [PREV, NEXT],
      ["\x1b[112;5u", "\x1b[110;5u"],
    ]) {
      const { editor, fired, forwarded } = appFixture({
        "app.clear": "ctrl+p",
        "app.interrupt": "ctrl+n",
      });
      const cursor = editor.getCursor();
      editor.onExtensionShortcut = (key) => {
        forwarded.push(key);
        return true;
      };
      editor.handleInput(prev);
      assertLine(editor, "b");
      editor.handleInput(next);
      assertLine(editor, "q");
      assert.equal(editor.getText(), "prompt");
      assert.deepEqual(editor.getCursor(), cursor);
      assert.deepEqual(fired, []);
      assert.deepEqual(forwarded, []);
    }
  });

  it("harmless app actions preserve a browse draft; cancellation resets it", () => {
    const { editor, fired } = appFixture();
    const cursor = editor.getCursor();
    sendKeys(editor, [PREV, "\x07", NEXT]);
    assertLine(editor, "q");
    assert.deepEqual(fired, ["app.editor.external"]);
    sendKeys(editor, [PREV, "\x03", ":", NEXT]);
    assertLine(editor, "");
    editor.handleInput(PREV);
    assertLine(editor, "b");
    assert.equal(editor.getText(), "prompt");
    assert.deepEqual(editor.getCursor(), cursor);
  });

  it("keeps empty history harmless and isolates editor sessions", () => {
    const { editor } = createEditorWithSpy("");
    sendKeys(editor, [":", "draft", PREV, NEXT]);
    assertLine(editor, "draft");
    editor.handleInput("\r");
    const other = createEditorWithSpy("").editor;
    sendKeys(other, [":", PREV]);
    assertLine(other, "");
    sendKeys(editor, [":", PREV]);
    assertLine(editor, "draft");
  });

  it("stores all submitted outcomes verbatim before trimming/dispatch", () => {
    const session = createEditorWithSpy("prompt");
    const { editor } = session;
    const dispatched: string[] = [];
    editor.setRunCommandFn((line) => {
      dispatched.push(line);
    });
    for (const line of [
      "q",
      "q!",
      " name session ",
      "!echo ok",
      "w",
      "absent",
      "  ",
    ]) {
      submit(editor, line);
      sendKeys(editor, [":", PREV]);
      assertLine(editor, line);
      editor.handleInput(ESC);
    }
    assert.equal(session.quitCalls, 1);
    assert.deepEqual(dispatched, ["/name session", "!echo ok"]);
    assert.deepEqual(session.notifications, [
      "Prompt is not empty; use :q! to quit anyway",
      "Reserved ex command: :w",
      "Unsupported ex command: :absent",
    ]);
    // Bare Enter is not an entry; whitespace-only input is non-empty history.
    sendKeys(editor, [":", "\r", ":", PREV]);
    assertLine(editor, "  ");
  });

  it("keeps bridge-disabled and failed dispatches in history", () => {
    const { editor } = createEditorWithSpy("prompt");
    editor.setExCommandSettings({
      piDispatch: false,
      copyInputToClipboard: false,
    });
    submit(editor, "name disabled");
    editor.setExCommandSettings({
      piDispatch: true,
      copyInputToClipboard: false,
    });
    editor.setRunCommandFn(() => {
      throw new Error("dispatch failed");
    });
    assert.throws(() => submit(editor, "name failed"), /dispatch failed/);
    sendKeys(editor, [":", PREV]);
    assertLine(editor, "name failed");
    editor.handleInput(PREV);
    assertLine(editor, "name disabled");
  });

  for (const recall of [PREV, UP]) {
    it(`Enter submits the ${JSON.stringify(recall)} recall and promotes duplicates`, () => {
      const { editor } = createEditorWithSpy("prompt");
      const dispatched: string[] = [];
      editor.setRunCommandFn((line) => {
        dispatched.push(line);
      });
      submit(editor, "name first");
      submit(editor, "name second");
      sendKeys(editor, [":", "name", recall, recall, "\r"]);
      assert.deepEqual(dispatched, [
        "/name first",
        "/name second",
        "/name first",
      ]);
      sendKeys(editor, [":", recall]);
      assertLine(editor, "name first");
      sendKeys(editor, [recall, recall]);
      assertLine(editor, "name second");
    });
  }

  it("Esc does not record canceled text (intentional nvim divergence)", () => {
    const { editor } = createEditorWithSpy("prompt");
    submit(editor, "a");
    submit(editor, "b");
    sendKeys(editor, [":", "draft", PREV, PREV, "z", ESC, ":", NEXT]);
    assertLine(editor, "");
    editor.handleInput(PREV);
    assertLine(editor, "b");
    editor.handleInput(PREV);
    assertLine(editor, "a");
    // Backspace on the bare colon cancels too.
    sendKeys(editor, [ESC, ":", "\x7f", ":", PREV]);
    assertLine(editor, "b");
  });

  for (const [edit, edited] of [
    [["z"], "az"],
    [["\x7f"], ""],
    [["\x08"], ""],
    [["\x1b[200~", "👩‍💻é\nignored", "\x1b[201~"], "a👩‍💻é"],
    [["z\x7fq"], "aq"],
  ] as const) {
    it(`editing after recall becomes a new draft: ${JSON.stringify(edit)}`, () => {
      const { editor } = createEditorWithSpy("prompt");
      submit(editor, "a");
      submit(editor, "b");
      sendKeys(editor, [":", "draft", PREV, PREV, ...edit, NEXT]);
      assertLine(editor, edited);
      editor.handleInput(PREV);
      assertLine(editor, "b");
      editor.handleInput(NEXT);
      assertLine(editor, edited);
    });
  }

  it("deletes recalled Unicode by grapheme and appends at the end", () => {
    const { editor } = createEditorWithSpy("");
    submit(editor, "name 👩‍💻é");
    sendKeys(editor, [":", PREV, "\x7f"]);
    assertLine(editor, "name 👩‍💻");
    sendKeys(editor, ["\x08", "中", PREV, NEXT]);
    assertLine(editor, "name 中");
  });

  for (const [encoding, up, down] of [
    ["CSI", UP, DOWN],
    ["SS3", "\x1bOA", "\x1bOB"],
    ["Kitty", "\x1b[1;1A", "\x1b[1;1B"],
  ]) {
    it(`${encoding}: Up/Down filter the saved draft, not the recalled line`, () => {
      const { editor } = createEditorWithSpy("prompt");
      for (const line of ["ab", "xy", "ac", "yz"]) submit(editor, line);
      for (const [draft, older, oldest] of [
        ["a", "ac", "ab"],
        ["", "yz", "ac"],
        ["none", "none", "none"],
      ]) {
        sendKeys(editor, [":", draft, down]);
        assertLine(editor, draft);
        editor.handleInput(up);
        assertLine(editor, older);
        editor.handleInput(up);
        assertLine(editor, oldest);
        if (draft) {
          editor.handleInput(up);
          assertLine(editor, oldest);
        }
        editor.handleInput(down);
        assertLine(editor, older);
        editor.handleInput(down);
        assertLine(editor, draft);
        editor.handleInput(down);
        assertLine(editor, draft);
        editor.handleInput(ESC);
      }
    });
  }

  it("mixes Up/Down with C-p/C-n using one position and the original prefix", () => {
    const { editor } = createEditorWithSpy("prompt");
    for (const line of ["ab", "xy", "ac", "yz"]) submit(editor, line);
    sendKeys(editor, [":", "a", UP, NEXT]);
    assertLine(editor, "yz");
    editor.handleInput(UP);
    assertLine(editor, "ac");
    editor.handleInput(PREV);
    assertLine(editor, "xy");
    editor.handleInput(UP);
    assertLine(editor, "ab");
    editor.handleInput(DOWN);
    assertLine(editor, "ac");
    editor.handleInput(DOWN);
    assertLine(editor, "a");
  });

  for (const [edit, edited] of [
    [["z"], "abz"],
    [["\x7f"], "a"],
    [["\x08"], "a"],
    [["\x1b[200~", "z\nignored", "\x1b[201~"], "abz"],
  ] as const) {
    it(`editing a prefix recall resets the filter: ${JSON.stringify(edit)}`, () => {
      const { editor } = createEditorWithSpy("prompt");
      for (const line of ["ab", "xy", "abz newest"]) submit(editor, line);
      sendKeys(editor, [":", "a", UP, UP, ...edit, DOWN]);
      assertLine(editor, edited);
      editor.handleInput(UP);
      assertLine(editor, "abz newest");
      editor.handleInput(DOWN);
      assertLine(editor, edited);
      sendKeys(editor, [ESC, ":", DOWN]);
      assertLine(editor, "");
      editor.handleInput(UP);
      assertLine(editor, "abz newest");
    });
  }

  it("unsupported controls and out-of-scope variants preserve the browse draft", () => {
    const { editor } = createEditorWithSpy("prompt");
    for (const line of ["ab", "xy", "ac"]) submit(editor, line);
    sendKeys(editor, [
      ":",
      "a",
      UP,
      "\x1b[1;2A",
      "\x1b[1;2B",
      "\x1b[5~",
      "\x1b[6~",
      "\x0b",
    ]);
    assertLine(editor, "ac");
    editor.handleInput(UP);
    assertLine(editor, "ab");
    sendKeys(editor, [DOWN, DOWN]);
    assertLine(editor, "a");
  });

  it("never interprets bracketed paste controls as history or submission", () => {
    for (const chunks of [
      ["\x1b[200~\x10\x0e\x1b[201~"],
      ["\x1b[200~", PREV, NEXT, "\x1b[201~"],
      [`\x1b[200~${UP}${DOWN}\x1b[201~`],
      ["\x1b[200~", UP, DOWN, "\x1b[201~"],
    ]) {
      const { editor } = createEditorWithSpy("");
      submit(editor, "a");
      sendKeys(editor, [":", "draft", ...chunks]);
      assertLine(editor, "draft");
      sendKeys(editor, [ESC, ":", PREV]);
      assertLine(editor, "a");
    }
    const { editor } = createEditorWithSpy("");
    submit(editor, "a");
    sendKeys(editor, [":", "\x1b[200~b\nc\x1b[201~"]);
    assertLine(editor, "b");
    sendKeys(editor, [PREV, NEXT]);
    assertLine(editor, "b");
    sendKeys(editor, ["\r", ":", PREV]);
    assertLine(editor, "b");
    editor.handleInput(PREV);
    assertLine(editor, "a");
  });

  it("preserves prompt cursor/register/clipboard/undo/redo/dot and consumes counts", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("alpha beta");
    editor.setHistoryNavigation(false);
    sendKeys(editor, ["x", "u"]);
    editor.setRegister("keep\n");
    const state = editor as unknown as {
      undoStack: { stack: unknown[] };
      redoStack: unknown[];
      lastRepeatableCommand: unknown;
    };
    const snapshot = () =>
      structuredClone({
        text: editor.getText(),
        cursor: editor.getCursor(),
        mode: editor.getMode(),
        register: editor.getRegister(),
        writes: clipboardWrites,
        undo: state.undoStack.stack,
        redo: state.redoStack,
        repeat: state.lastRepeatableCommand,
      });
    const before = snapshot();
    assert.equal(state.redoStack.length, 1);
    submit(editor, "a");
    sendKeys(editor, [
      "9",
      ":",
      PREV,
      PREV,
      NEXT,
      NEXT,
      "a",
      UP,
      UP,
      DOWN,
      DOWN,
      "draft",
      UP,
      DOWN,
      PREV,
      "!",
      NEXT,
      ESC,
    ]);
    assert.deepEqual(snapshot(), before);
    editor.handleInput("\x12");
    assert.equal(editor.getText(), "lpha beta");
    editor.handleInput(".");
    assert.equal(editor.getText(), "pha beta");
    editor.handleInput("u");
    assert.equal(editor.getText(), "lpha beta");
    sendKeys(editor, [":", PREV, "z", ESC, "x", "\x12"]);
    assert.equal(editor.getText(), "pha beta");
    assert.equal(state.redoStack.length, 0);
  });
});
