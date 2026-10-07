import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import { runPiEditorAction } from "../pi-editor-actions.js";
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
import type { NvimParitySnapshot } from "./nvim-oracle.js";

type ActionCase = {
  name: string;
  text: string;
  cursor?: { line: number; col: number };
  register?: string;
  keys: string[];
  expected: NvimParitySnapshot;
  writes?: string[];
};

const CASES: ActionCase[] = [
  ...["D", "d$"].map(
    (command): ActionCase => ({
      name: `${command} deletes the tail`,
      text: "abcdef",
      cursor: { line: 0, col: 2 },
      keys: [...command],
      expected: {
        text: "ab",
        cursor: { line: 0, col: 2 },
        mode: "normal",
        register: "cdef",
      },
      writes: ["cdef"],
    }),
  ),
  ...["C", "c$"].map(
    (command): ActionCase => ({
      name: `${command} changes the tail`,
      text: "abcdef",
      cursor: { line: 0, col: 2 },
      keys: [...command, "Z", "\x1b"],
      expected: {
        text: "abZ",
        cursor: { line: 0, col: 2 },
        mode: "normal",
        register: "cdef",
      },
      writes: ["cdef"],
    }),
  ),
  ...["S", "cc"].map(
    (command): ActionCase => ({
      name: `${command} changes the line content`,
      text: "abcdef",
      cursor: { line: 0, col: 2 },
      keys: [...command, "Z", "\x1b"],
      expected: {
        text: "Z",
        cursor: { line: 0, col: 0 },
        mode: "normal",
        register: "abcdef",
      },
      writes: ["abcdef"],
    }),
  ),
  {
    name: "h and l move by graphemes",
    text: "a😀bc",
    keys: ["l", "l", "h"],
    expected: {
      text: "a😀bc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "counted horizontal motion uses the Unicode fallback",
    text: "a😀bcd",
    keys: ["3", "l", "2", "h"],
    expected: {
      text: "a😀bcd",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "keep",
    },
  },
  {
    name: "0 moves to logical line start",
    text: "first\nabcdef",
    cursor: { line: 1, col: 3 },
    keys: ["0"],
    expected: {
      text: "first\nabcdef",
      cursor: { line: 1, col: 0 },
      mode: "normal",
      register: "keep",
    },
  },
  ...["a", "A"].map(
    (command): ActionCase => ({
      name: `${command} enters insert at its target`,
      text: "abc",
      keys: [command, "Z", "\x1b"],
      expected: {
        text: command === "a" ? "aZbc" : "abcZ",
        cursor: { line: 0, col: command === "a" ? 1 : 3 },
        mode: "normal",
        register: "keep",
      },
    }),
  ),
  ...["o", "O"].map(
    (command): ActionCase => ({
      name: `${command} opens a line`,
      text: "abc",
      cursor: { line: 0, col: 1 },
      keys: [command, "Z", "\x1b"],
      expected: {
        text: command === "o" ? "abc\nZ" : "Z\nabc",
        cursor: { line: command === "o" ? 1 : 0, col: 0 },
        mode: "normal",
        register: "keep",
      },
    }),
  ),
  ...["p", "P"].map(
    (command): ActionCase => ({
      name: `${command} inserts literal text bound to actions`,
      text: "ab",
      register: "qx😀",
      keys: ["2", command],
      expected: {
        text: command === "p" ? "aqx😀qx😀b" : "qx😀qx😀ab",
        cursor: { line: 0, col: command === "p" ? 7 : 6 },
        mode: "normal",
        register: "qx😀",
      },
    }),
  ),
  ...["p", "P"].map(
    (command): ActionCase => ({
      name: `${command} inserts a counted linewise register`,
      text: "ab\ncd",
      register: "qx\nyz\n",
      keys: ["2", command],
      expected: {
        text:
          command === "p" ? "ab\nqx\nyz\nqx\nyz\ncd" : "qx\nyz\nqx\nyz\nab\ncd",
        cursor: { line: command === "p" ? 1 : 0, col: 0 },
        mode: "normal",
        register: "qx\nyz\n",
      },
    }),
  ),
  {
    name: "dd resets the cursor to the remaining line start",
    text: "abc\ndef",
    cursor: { line: 0, col: 1 },
    keys: ["d", "d"],
    expected: {
      text: "def",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "abc\n",
    },
    writes: ["abc\n"],
  },
  {
    name: "undo and redo preserve buffer and cursor",
    text: "abc",
    cursor: { line: 0, col: 1 },
    keys: ["x", "u", "\x12"],
    expected: {
      text: "ac",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "b",
    },
    writes: ["b"],
  },
  {
    name: "counted undo clamps and consumes its count",
    text: "abc",
    keys: ["x", "9", "u", "l"],
    expected: {
      text: "abc",
      cursor: { line: 0, col: 1 },
      mode: "normal",
      register: "a",
    },
    writes: ["a"],
  },
  {
    name: "no-op delete preserves register and emits no clipboard write",
    text: "",
    keys: ["D", "u", "\x12"],
    expected: {
      text: "",
      cursor: { line: 0, col: 0 },
      mode: "normal",
      register: "keep",
    },
  },
];

function createEditor(
  testCase: Pick<ActionCase, "text" | "cursor" | "register">,
) {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const writes: string[] = [];
  let shortcuts = 0;
  let submits = 0;
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setText(testCase.text);
  editor.setRegister(testCase.register ?? "keep");
  editor.handleInput("\x1b");
  setInternalCursor(
    editor,
    testCase.cursor?.col ?? 0,
    testCase.cursor?.line ?? 0,
  );
  const { undoStack } = editor as unknown as {
    undoStack: { stack: unknown[] };
  };
  undoStack.stack.length = 0;
  editor.onSubmit = () => {
    submits++;
  };
  editor.onExtensionShortcut = (data) => {
    if (
      [
        "\x0b",
        "\x01",
        "\x05",
        "\x1f",
        "\x1b[C",
        "\x1b[D",
        "\x1b[A",
        "\n",
        "q",
      ].includes(data)
    ) {
      shortcuts++;
      return true;
    }
    return false;
  };
  return {
    editor,
    writes,
    get shortcuts() {
      return shortcuts;
    },
    get submits() {
      return submits;
    },
  };
}

function snapshot(editor: ModalEditor): NvimParitySnapshot {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

for (const variant of EDITOR_BINDING_VARIANTS) {
  describe(`direct Pi editor actions with ${variant} bindings`, () => {
    for (const testCase of CASES) {
      it(testCase.name, () =>
        withEditorBindings(variant, () => {
          const fixture = createEditor(testCase);
          sendKeys(fixture.editor, testCase.keys);
          assert.deepEqual(snapshot(fixture.editor), testCase.expected);
          assert.deepEqual(fixture.writes, testCase.writes ?? []);
          assert.equal(fixture.shortcuts, 0);
          assert.equal(fixture.submits, 0);
        }),
      );
    }

    for (const [key, text, cursor] of [
      ["\x1bA", "abc", { line: 0, col: 3 }],
      ["\x1bI", "abc", { line: 0, col: 0 }],
      ["\x1bo", "abc\n", { line: 1, col: 0 }],
      ["\x1bO", "\nabc", { line: 0, col: 0 }],
    ] as const) {
      it(`insert-mode shortcut ${JSON.stringify(key)} bypasses Pi bindings`, () =>
        withEditorBindings(variant, () => {
          const fixture = createEditor({
            text: "abc",
            cursor: { line: 0, col: 1 },
          });
          sendKeys(fixture.editor, ["i", key]);
          assert.equal(fixture.editor.getText(), text);
          assert.deepEqual(fixture.editor.getCursor(), cursor);
          assert.equal(fixture.editor.getMode(), "insert");
          assert.equal(fixture.editor.getRegister(), "keep");
          assert.deepEqual(fixture.writes, []);
          assert.equal(fixture.shortcuts, 0);
          assert.equal(fixture.submits, 0);
        }));
    }

    it("keeps Pi's kill ring and onChange notifications", () =>
      withEditorBindings(variant, () => {
        const fixture = createEditor({ text: "abc" });
        const changes: string[] = [];
        fixture.editor.onChange = (text) => changes.push(text);
        sendKeys(fixture.editor, ["D", "i", "\x19"]);
        assert.equal(fixture.editor.getText(), "abc");
        assert.equal(fixture.editor.getMode(), "insert");
        assert.deepEqual(fixture.editor.getCursor(), { line: 0, col: 3 });
        assert.equal(fixture.editor.getRegister(), "abc");
        assert.deepEqual(fixture.writes, ["abc"]);
        assert.deepEqual(changes, ["", "abc"]);
      }));

    it("real insert-mode input still honors the configured bindings", () =>
      withEditorBindings(variant, () => {
        const fixture = createEditor({ text: "abc def" });
        sendKeys(fixture.editor, ["i", "x"]);
        assert.equal(fixture.editor.getText(), " def");
        assert.deepEqual(fixture.editor.getCursor(), { line: 0, col: 0 });
        assert.equal(fixture.editor.getMode(), "insert");
      }));

    it("a real edit clears stale redo after direct undo", () =>
      withEditorBindings(variant, () => {
        const fixture = createEditor({ text: "abc" });
        sendKeys(fixture.editor, ["D", "u", "z", "\x12"]);
        assert.equal(fixture.editor.getText(), "");
        sendKeys(fixture.editor, ["u", "i", "Z", "\x1b", "\x12"]);
        assert.equal(fixture.editor.getText(), "Zabc");
        assert.deepEqual(fixture.editor.getCursor(), { line: 0, col: 0 });
      }));
  });
}

describe("Pi editor compatibility adapter", () => {
  it("preserves the method receiver and arguments", () => {
    const editor = {
      cursor: 0,
      moveCursor(line: number, col: number) {
        this.cursor = line + col;
      },
    };
    runPiEditorAction(editor, "moveCursor", 2, 3);
    assert.equal(editor.cursor, 5);
  });

  it("fails clearly rather than falling back to configurable keys", () => {
    assert.throws(
      () => runPiEditorAction({}, "undo"),
      /Pi editor compatibility error: undo\(\) unavailable/,
    );
    assert.throws(
      () => runPiEditorAction({ undo: false }, "undo"),
      /Pi editor compatibility error/,
    );
  });
});
