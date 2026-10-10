import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vim, { ModalEditor } from "../index.js";
import { setPiVimSettingsReaderForTests } from "../settings.js";
import {
  EDITOR_BINDING_VARIANTS,
  withEditorBindings,
} from "./editor-action-fixtures.js";
import {
  createExtensionApiHarness,
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const ESC = "\x1b";
const REDO = "\x12";
const OLDER = "older prompt";
const NEWER = "newer prompt";

function internals(editor: ModalEditor) {
  return editor as unknown as {
    historyIndex: number;
    undoStack: { stack: unknown[] };
    redoStack: unknown[];
    undoWindow: unknown;
    replayingRepeat: boolean;
    lastRepeatableCommand: unknown;
    navigateHistory(direction: -1 | 1): void;
  };
}

function fixture(text = "", history = [OLDER, NEWER]) {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  const writes: string[] = [];
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setText(text);
  editor.setRegister("keep\n");
  sendKeys(editor, [ESC, "g", "g"]);
  internals(editor).undoStack.stack.length = 0;
  for (const entry of history) editor.addToHistory(entry);
  return { editor, writes, state: internals(editor) };
}

function snapshot(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

function expectRecall(
  editor: ModalEditor,
  text: string,
  index: number,
  register = "keep\n",
) {
  assert.deepEqual(snapshot(editor), {
    text,
    cursor: { line: 0, col: Math.max(0, text.length - 1) },
    mode: "normal",
    register,
  });
  assert.equal(internals(editor).historyIndex, index);
}

describe("normal-mode prompt history (intentional non-Vim host feature)", () => {
  it("recalls older, newer, and the empty draft without changing mode or label", () => {
    const { editor, writes, state } = fixture();
    const label = editor.render(80).at(-1);
    const transitions: string[] = [];
    editor.setModeChangeFn((mode) => transitions.push(mode));
    for (const [key, text, index] of [
      ["k", NEWER, 0],
      ["k", OLDER, 1],
      ["j", NEWER, 0],
      ["j", "", -1],
    ] as const) {
      editor.handleInput(key);
      expectRecall(editor, text, index);
      assert.equal(editor.render(80).at(-1), label);
      assert.equal(state.undoStack.stack.length, 1);
      assert.equal(state.undoWindow, null);
      assert.equal(state.lastRepeatableCommand, null);
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(transitions, []);
  });

  for (const text of ["draft", "   ", "first\nsecond", "\n"]) {
    it(`protects a non-browsing draft ${JSON.stringify(text)}`, () => {
      const { editor, writes, state } = fixture(text);
      const before = snapshot(editor);
      editor.handleInput("k");
      assert.deepEqual(snapshot(editor), before);
      editor.handleInput("G");
      const bottom = snapshot(editor);
      editor.handleInput("j");
      assert.deepEqual(snapshot(editor), bottom);
      assert.equal(state.historyIndex, -1);
      assert.equal(state.undoStack.stack.length, 0);
      assert.deepEqual(writes, []);
    });
  }

  it("clamps exhausted history without extra snapshots or cursor movement", () => {
    const { editor, state } = fixture();
    sendKeys(editor, ["k", "k", "0"]);
    const before = snapshot(editor);
    sendKeys(editor, ["k", "k"]);
    assert.deepEqual(snapshot(editor), before);
    assert.equal(state.historyIndex, 1);
    assert.equal(state.undoStack.stack.length, 1);
    sendKeys(editor, ["j", "j", "j"]);
    expectRecall(editor, "", -1);
    assert.equal(state.undoStack.stack.length, 1);
  });

  it("empty history is a no-op and leaves dot and undo empty", () => {
    const { editor, state, writes } = fixture("", []);
    const before = snapshot(editor);
    sendKeys(editor, ["k", "j", "u", REDO, "."]);
    assert.deepEqual(snapshot(editor), before);
    assert.equal(state.undoStack.stack.length, 0);
    assert.equal(state.redoStack.length, 0);
    assert.equal(state.lastRepeatableCommand, null);
    assert.deepEqual(writes, []);
  });

  for (const lastLine of ["ascii", "a😀", "ab👩‍💻", "abé", "ab界"]) {
    it(`lands on the final grapheme's UTF-16 column: ${lastLine}`, () => {
      const { editor } = fixture("", [`head\n${lastLine}`]);
      editor.handleInput("k");
      assert.deepEqual(snapshot(editor), {
        text: `head\n${lastLine}`,
        cursor: {
          line: 1,
          col: lastLine === "ascii" ? 4 : lastLine === "a😀" ? 1 : 2,
        },
        mode: "normal",
        register: "keep\n",
      });
      editor.handleInput("j");
      expectRecall(editor, "", -1);
    });
  }

  it("normalizes a host that places older recalls at buffer start", (t) => {
    const { editor, state } = fixture("", ["head\nab👩‍💻"]);
    const navigate = state.navigateHistory.bind(editor);
    t.mock.method(state, "navigateHistory", (direction: -1 | 1) => {
      navigate(direction);
      if (direction === -1) setInternalCursor(editor, 0, 0);
    });
    editor.handleInput("k");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
    assert.equal(editor.getText(), "head\nab👩‍💻");
    assert.equal(editor.getMode(), "normal");
  });

  for (const width of [12, 80]) {
    it(`uses logical edges, not wrapped visual rows, at width ${width}`, () => {
      const text = `${"abcdefghij".repeat(10)}\nsecond line also wraps`;
      const { editor, state } = fixture("", [OLDER, text]);
      editor.handleInput("k");
      // Last logical line, but not its last visual row at narrow width.
      setInternalCursor(editor, 0, 1);
      editor.render(width);
      editor.handleInput("j");
      expectRecall(editor, "", -1);
      editor.handleInput("k");
      setInternalCursor(editor, 95, 0);
      editor.render(width);
      editor.handleInput("k");
      expectRecall(editor, OLDER, 1);
      editor.handleInput("j");
      setInternalCursor(editor, 0, 0);
      editor.render(width);
      editor.handleInput("j");
      assert.equal(editor.getText(), text);
      assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
      editor.handleInput("k");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
      assert.equal(state.historyIndex, 0);
    });
  }

  for (const count of ["1", "3", "99999"]) {
    it(`${count}k/j are buffer-local and consume the count`, () => {
      const { editor, state } = fixture();
      sendKeys(editor, [...count, "k"]);
      expectRecall(editor, "", -1);
      assert.equal(state.undoStack.stack.length, 0);
      editor.handleInput("k");
      expectRecall(editor, NEWER, 0);
      sendKeys(editor, [...count, "k", ...count, "j"]);
      expectRecall(editor, NEWER, 0);
      editor.handleInput("j");
      expectRecall(editor, "", -1);
    });
  }

  it("counted overshoot reaches buffer edges without recalling", () => {
    const { editor, state } = fixture("", [OLDER, "one\ntwo\nend"]);
    sendKeys(editor, ["k", "9", "9", "k"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    sendKeys(editor, ["9", "9", "j"]);
    assert.deepEqual(editor.getCursor(), { line: 2, col: 2 });
    assert.equal(editor.getText(), "one\ntwo\nend");
    assert.equal(state.historyIndex, 0);
    editor.handleInput("j");
    expectRecall(editor, "", -1);
  });

  for (const key of ["v", "V"]) {
    it(`${key} keeps j/k buffer-local while browsing`, () => {
      const { editor, state, writes } = fixture();
      sendKeys(editor, ["k", key]);
      const before = snapshot(editor);
      sendKeys(editor, ["k", "j", "3", "k", "3", "j"]);
      assert.deepEqual(snapshot(editor), before);
      assert.equal(state.historyIndex, 0);
      assert.deepEqual(writes, []);
    });
  }

  for (const keys of [
    ["g", "k"],
    ["g", "j"],
    ["Z", "k"],
    ["Z", "j"],
    [":", "k", "j", ESC],
  ]) {
    it(`${keys.join("")} cannot recall and leaves no pending prefix`, () => {
      const { editor, state } = fixture();
      sendKeys(editor, ["k", ...keys]);
      expectRecall(editor, NEWER, 0);
      assert.match(editor.render(80).at(-1) ?? "", / NORMAL /);
      editor.handleInput("j");
      expectRecall(editor, "", -1);
      assert.equal(state.undoStack.stack.length, 1);
    });
  }

  for (const [keys, text, register, writes] of [
    [["d", "k"], "", `${NEWER}\n`, [`${NEWER}\n`]],
    [["y", "j"], NEWER, `${NEWER}\n`, [`${NEWER}\n`]],
    [["c", "k"], NEWER, "keep\n", []],
  ] as const) {
    it(`${keys.join("")} retains its existing buffer-local edge behavior`, (t) => {
      const f = fixture();
      f.editor.handleInput("k");
      const navigate = t.mock.method(f.state, "navigateHistory");
      sendKeys(f.editor, [...keys]);
      assert.equal(navigate.mock.callCount(), 0);
      assert.deepEqual(snapshot(f.editor), {
        text,
        cursor: { line: 0, col: text ? NEWER.length - 1 : 0 },
        mode: "normal",
        register,
      });
      assert.deepEqual(f.writes, writes);
      // dk/yj already clamp their linewise range at an edge; ck is unsupported.
      // This feature must not turn their suffix into a standalone history key.
    });
  }

  it("u restores the pre-browse empty draft; redo restores text, not browsing", () => {
    const { editor, state, writes } = fixture();
    sendKeys(editor, ["k", "k", "u"]);
    expectRecall(editor, "", -1);
    assert.equal(state.undoStack.stack.length, 0);
    assert.equal(state.redoStack.length, 1);
    sendKeys(editor, ["u", "j", "z", REDO]);
    expectRecall(editor, OLDER, -1);
    assert.equal(state.redoStack.length, 0);
    editor.handleInput("k");
    expectRecall(editor, OLDER, -1);
    sendKeys(editor, ["u", "u", "9", REDO, REDO]);
    expectRecall(editor, OLDER, -1);
    assert.deepEqual(writes, []);
  });

  it("recall clears stale redo, but disabled/protected/no-history inputs preserve it", () => {
    for (const kind of ["recall", "disabled", "protected", "no-history"]) {
      const { editor, state } = fixture(
        kind === "protected" ? "base" : "",
        kind === "no-history" ? [] : undefined,
      );
      sendKeys(editor, ["i", "X", ESC, "u"]);
      assert.equal(state.redoStack.length, 1);
      if (kind === "disabled") editor.setHistoryNavigation(false);
      editor.handleInput("k");
      assert.equal(state.redoStack.length, kind === "recall" ? 0 : 1);
      editor.handleInput(REDO);
      assert.equal(
        editor.getText(),
        kind === "recall" ? NEWER : kind === "protected" ? "Xbase" : "X",
      );
      assert.equal(editor.getMode(), "normal");
    }
  });

  it("an edit after recall ends browsing; undo and redo stay separate", () => {
    const { editor, state } = fixture();
    sendKeys(editor, ["k", "x"]);
    expectRecallAfterEdit();
    assert.equal(state.undoStack.stack.length, 2);
    sendKeys(editor, ["u", REDO]);
    expectRecallAfterEdit();
    sendKeys(editor, ["u", "u"]);
    expectRecall(editor, "", -1, "t");
    sendKeys(editor, ["2", REDO]);
    expectRecallAfterEdit();
    sendKeys(editor, ["u", "0", "x", REDO]);
    assert.equal(editor.getText(), NEWER.slice(1));
    assert.equal(state.redoStack.length, 0);

    function expectRecallAfterEdit() {
      assert.deepEqual(snapshot(editor), {
        text: NEWER.slice(0, -1),
        cursor: { line: 0, col: NEWER.length - 2 },
        mode: "normal",
        register: "t",
      });
      assert.equal(state.historyIndex, -1);
    }
  });

  it("recall does not overwrite dot; replaying an operator never recalls", (t) => {
    const { editor, state } = fixture();
    sendKeys(editor, ["i", "X", ESC, "u"]);
    const recorded = structuredClone(state.lastRepeatableCommand);
    editor.handleInput("k");
    assert.deepEqual(state.lastRepeatableCommand, recorded);
    sendKeys(editor, ["0", "."]);
    assert.equal(editor.getText(), `X${NEWER}`);
    sendKeys(editor, ["d", "k"]);
    const navigate = t.mock.method(state, "navigateHistory");
    editor.handleInput(".");
    assert.equal(navigate.mock.callCount(), 0);
    assert.equal(editor.getText(), "");
  });

  it("recall alone cannot seed dot-repeat, including a return to the draft", () => {
    const { editor, state } = fixture();
    sendKeys(editor, ["k", "."]);
    expectRecall(editor, NEWER, 0);
    sendKeys(editor, ["j", "."]);
    expectRecall(editor, "", -1);
    assert.equal(state.lastRepeatableCommand, null);
  });

  it("standalone j/k in a replay stay buffer-local", (t) => {
    const { editor, state } = fixture();
    editor.handleInput("k");
    const before = snapshot(editor);
    const navigate = t.mock.method(state, "navigateHistory");
    // Exercise the replay guard even if a future recorder emits bare j/k.
    state.replayingRepeat = true;
    try {
      sendKeys(editor, ["k", "j"]);
    } finally {
      state.replayingRepeat = false;
    }
    assert.deepEqual(snapshot(editor), before);
    assert.equal(state.historyIndex, 0);
    assert.equal(navigate.mock.callCount(), 0);
  });

  it("disabling navigation mid-browse leaves both edge keys inert", () => {
    const { editor } = fixture();
    editor.handleInput("k");
    editor.setHistoryNavigation(false);
    sendKeys(editor, ["k", "j"]);
    expectRecall(editor, NEWER, 0);
    editor.setHistoryNavigation(true);
    editor.handleInput("j");
    expectRecall(editor, "", -1);
  });

  it("keeps earlier Vim undo units below Pi's browse anchor", () => {
    const { editor, state } = fixture("draft");
    sendKeys(editor, ["D", "k", "k"]);
    assert.equal(state.undoStack.stack.length, 2);
    sendKeys(editor, ["u"]);
    expectRecall(editor, "", -1, "draft");
    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "draft");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    assert.equal(state.historyIndex, -1);
  });

  it("word boundaries follow each recall and subsequent edits", () => {
    const { editor } = fixture("", ["a bb cccc", "aaaa bb c"]);
    sendKeys(editor, ["k", "0", "w"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
    sendKeys(editor, ["k", "0", "w"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    sendKeys(editor, ["i", "Z", ESC, "0", "w", "e"]);
    assert.equal(editor.getText(), "a Zbb cccc");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  for (const variant of EDITOR_BINDING_VARIANTS) {
    it(`history bypasses ${variant} Pi keybindings`, () =>
      withEditorBindings(variant, () => {
        const { editor, writes } = fixture();
        sendKeys(editor, ["k", "k", "j"]);
        expectRecall(editor, NEWER, 0);
        sendKeys(editor, ["j", "u"]);
        expectRecall(editor, "", -1);
        assert.deepEqual(writes, []);
      }));
  }

  it("insert-mode j/k remain literal input", () => {
    const { editor, state, writes } = fixture();
    sendKeys(editor, ["i", "k", "j"]);
    assert.deepEqual(snapshot(editor), {
      text: "kj",
      cursor: { line: 0, col: 2 },
      mode: "insert",
      register: "keep\n",
    });
    assert.equal(state.historyIndex, -1);
    assert.deepEqual(writes, []);
  });

  for (const enabled of [false, true, undefined]) {
    it(`session start wires historyNavigation=${String(enabled)}`, async () => {
      const restore = setPiVimSettingsReaderForTests(() => ({
        historyNavigation: enabled,
      }));
      const pi = createExtensionApiHarness();
      vim(pi);
      let factory:
        | ((...args: ConstructorParameters<typeof ModalEditor>) => ModalEditor)
        | undefined;
      try {
        await pi.emit(
          "session_start",
          {},
          {
            cwd: ".",
            hasUI: true,
            ui: {
              theme: stubTheme,
              notify() {},
              setEditorComponent: (fn: NonNullable<typeof factory>) => {
                factory = fn;
              },
            },
          },
        );
        assert.ok(factory);
        const editor = factory(stubTui, stubTheme, stubKeybindings);
        editor.addToHistory(NEWER);
        editor.setRegister("keep\n");
        sendKeys(editor, [ESC, "k"]);
        expectRecall(
          editor,
          enabled === false ? "" : NEWER,
          enabled === false ? -1 : 0,
        );
        sendKeys(editor, ["j"]);
        expectRecall(editor, "", -1);
      } finally {
        await pi.emit("session_shutdown", { reason: "quit" });
        restore();
      }
    });
  }
});
