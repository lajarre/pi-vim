import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import {
  CustomEditor,
  type KeybindingsManager as PiKeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { ModalEditor } from "../index.js";
import { sendKeys, setInternalCursor, stubTheme, stubTui } from "./harness.js";

// Resolve the actual host defaults and its TUI singleton, not user config or a
// fake matches implementation. These internal module paths are test-only seams.
const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { KeybindingsManager } = (await import(
  new URL("./core/keybindings.js", hostEntry).href
)) as {
  KeybindingsManager: new (
    bindings?: Record<string, string | string[]>,
  ) => PiKeybindingsManager;
};
const hostTui = (await import(
  createRequire(hostEntry).resolve("@earendil-works/pi-tui")
)) as typeof import("@earendil-works/pi-tui");
const originalKeybindings = hostTui.getKeybindings();
after(() => hostTui.setKeybindings(originalKeybindings));

const ESC = "\x1b";
const APP_KEYS = [
  {
    name: "Ctrl-P",
    raw: "\x10",
    kitty: "\x1b[112;5u",
    action: "app.model.cycleForward",
  },
  {
    name: "Ctrl-G",
    raw: "\x07",
    kitty: "\x1b[103;5u",
    action: "app.editor.external",
  },
  {
    name: "Ctrl-T",
    raw: "\x14",
    kitty: "\x1b[116;5u",
    action: "app.thinking.toggle",
  },
  { name: "Ctrl-C", raw: "\x03", kitty: "\x1b[99;5u", action: "app.clear" },
  {
    name: "Ctrl-L",
    raw: "\x0c",
    kitty: "\x1b[108;5u",
    action: "app.model.select",
  },
  {
    name: "Shift-Tab",
    raw: "\x1b[Z",
    kitty: "\x1b[9;2u",
    action: "app.thinking.cycle",
  },
] as const;
const EDITOR_KEYS = [
  { name: "Ctrl-K", raw: "\x0b", kitty: "\x1b[107;5u" },
  { name: "Ctrl-U", raw: "\x15", kitty: "\x1b[117;5u" },
  { name: "Ctrl-A", raw: "\x01", kitty: "\x1b[97;5u" },
  { name: "Ctrl-E", raw: "\x05", kitty: "\x1b[101;5u" },
  { name: "Ctrl-W", raw: "\x17", kitty: "\x1b[119;5u" },
  { name: "Enter", raw: "\r", kitty: "\x1b[13u" },
  { name: "Up", raw: "\x1b[A", kitty: "\x1b[1;1A" },
  { name: "Down", raw: "\x1b[B", kitty: "\x1b[1;1B" },
  { name: "Ctrl-N", raw: "\x0e", kitty: "\x1b[110;5u" },
] as const;
const STATES = [
  { name: "normal", setup: [] },
  { name: "visual", setup: ["v"] },
  { name: "v-line", setup: ["V"] },
  { name: "ex", setup: [":", "q"] },
  { name: "operator pending", setup: ["d"] },
  { name: "count pending", setup: ["3"] },
  { name: "g", setup: ["g"] },
  { name: "Z", setup: ["Z"] },
  { name: "r", setup: ["r"] },
  { name: "f", setup: ["f"] },
  { name: "t", setup: ["t"] },
  { name: "text-object pending", setup: ["d", "i"] },
  { name: "F", setup: ["F"] },
  { name: "T", setup: ["T"] },
  { name: "outer text-object", setup: ["d", "a"] },
  { name: "change pending", setup: ["c"] },
  { name: "yank pending", setup: ["y"] },
  { name: "operator find", setup: ["d", "f"] },
  { name: "operator till", setup: ["d", "t"] },
  { name: "operator counts", setup: ["3", "d", "2"] },
  { name: "g count", setup: ["g", "3"] },
  ...["v", "V"].flatMap((visual) =>
    ["f", "F", "t", "T"].map((find) => ({
      name: `${visual} counted ${find}`,
      setup: [visual, "3", find],
    })),
  ),
];

function internals(editor: ModalEditor) {
  return editor as unknown as {
    historyIndex: number;
    undoStack: { stack: unknown[] };
    redoStack: unknown[];
    lastRepeatableCommand: unknown;
    visualAnchor: unknown;
    pendingExCommand: string | null;
    pendingMotion: unknown;
    pendingTextObject: unknown;
    pendingOperator: unknown;
    pendingReplace: boolean;
    pendingG: boolean;
    pendingZ: boolean;
    prefixCount: string;
    operatorCount: string;
    pendingGCount: string;
  };
}

function fixture(setup: readonly string[], bindings = {}) {
  const kb = new KeybindingsManager(bindings);
  hostTui.setKeybindings(kb);
  const editor = new ModalEditor(stubTui, stubTheme, kb);
  const writes: string[] = [];
  const fired: string[] = [];
  const forwarded: string[] = [];
  const submitted: string[] = [];
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setText("alpha\nbravo\ncider\ndelta\neagle");
  // Seed redo and dot: harmless chords must not invalidate either history.
  sendKeys(editor, [ESC, "i", "X", ESC, "u"]);
  setInternalCursor(editor, 2, 2);
  editor.setRegister("keep\n");
  editor.addToHistory("older prompt");
  editor.addToHistory("newer prompt");
  for (const { action } of APP_KEYS)
    editor.onAction(action, () => fired.push(action));
  editor.onAction("app.interrupt", () => fired.push("app.interrupt"));
  editor.onAction("app.exit", () => fired.push("app.exit"));
  editor.onAction("app.suspend", () => fired.push("app.suspend"));
  editor.onSubmit = (text) => submitted.push(text);
  editor.onExtensionShortcut = (key) => {
    forwarded.push(key);
    return false;
  };
  if (setup[0] === ":") {
    sendKeys(editor, [":", "ex-a", "\r", ":", "ex-b", "\r"]);
  }
  sendKeys(editor, [...setup]);
  const state = internals(editor);
  const snapshot = () =>
    structuredClone({
      text: editor.getText(),
      cursor: editor.getCursor(),
      mode: editor.getMode(),
      register: editor.getRegister(),
      writes,
      historyIndex: state.historyIndex,
      undo: state.undoStack.stack,
      redo: state.redoStack,
      repeat: state.lastRepeatableCommand,
      anchor: state.visualAnchor,
      ex: state.pendingExCommand,
    });
  return { editor, kb, state, snapshot, fired, forwarded, submitted };
}

function assertNoPending(state: ReturnType<typeof internals>) {
  assert.equal(state.pendingMotion, null);
  assert.equal(state.pendingTextObject, null);
  assert.equal(state.pendingOperator, null);
  assert.equal(state.pendingReplace, false);
  assert.equal(state.pendingG, false);
  assert.equal(state.pendingZ, false);
  assert.equal(state.prefixCount, "");
  assert.equal(state.operatorCount, "");
  assert.equal(state.pendingGCount, "");
}

// Intentional divergence from nvim: application shortcuts are Pi-owned; unknown
// editor controls cannot edit in modal states. Explicit submit/EX Enter and Vim
// Escape/undo/redo remain exceptions, as do EX's C-p/C-n history keys. Spies
// isolate routing from app side effects; EX history wins even over app bindings.
describe("control-key ownership with real Pi defaults (host-only policy)", () => {
  for (const encoding of ["raw", "kitty"] as const) {
    for (const mode of STATES) {
      for (const key of APP_KEYS) {
        it(`${encoding} / ${mode.name} / ${key.name} obeys app/EX ownership`, () => {
          const f = fixture(mode.setup);
          const before = f.snapshot();
          assert.equal(f.state.redoStack.length, 1);
          assert.equal(f.kb.matches(key[encoding], key.action), true);
          f.editor.handleInput(key[encoding]);
          if (mode.name === "ex" && key.name === "Ctrl-P") {
            assert.deepEqual(f.fired, []);
            assert.deepEqual(f.forwarded, []);
            assert.deepEqual(f.snapshot(), { ...before, ex: ":ex-b" });
            assertNoPending(f.state);
            return;
          }
          assert.deepEqual(f.fired, [key.action]);
          assert.deepEqual(f.forwarded, [key[encoding]]);
          assert.deepEqual(f.snapshot(), {
            ...before,
            ex: key.action === "app.clear" ? null : before.ex,
          });
          assertNoPending(f.state);
          // Neither prefix nor operator count may leak to the next motion.
          if (mode.name !== "ex") {
            f.editor.handleInput("l");
            assert.deepEqual(f.editor.getCursor(), { line: 2, col: 3 });
          }
        });
      }
      for (const key of EDITOR_KEYS) {
        it(`${encoding} / ${mode.name} / ${key.name} stays out of editor bindings`, () => {
          const f = fixture(mode.setup);
          if (mode.name === "ex" && key.name === "Ctrl-N") {
            f.editor.handleInput(APP_KEYS[0][encoding]);
            assert.equal(f.state.pendingExCommand, ":ex-b");
          }
          const before = f.snapshot();
          f.editor.handleInput(key[encoding]);
          assert.deepEqual(f.fired, []);
          // Established gestures, not an unsupported editing fallback.
          if (key.name === "Enter" && mode.name === "normal") {
            assert.deepEqual(f.submitted, [before.text]);
            assert.deepEqual(f.forwarded, [key[encoding]]);
            return;
          }
          assert.deepEqual(f.forwarded, []);
          assert.deepEqual(f.submitted, []);
          const expected = { ...before };
          if (mode.name === "ex") {
            if (key.name === "Enter") expected.ex = null;
            if (key.name === "Ctrl-N") expected.ex = ":q";
          }
          assert.deepEqual(f.snapshot(), expected);
          assertNoPending(f.state);
        });
      }
    }
    for (const key of [...APP_KEYS, ...EDITOR_KEYS]) {
      it(`${encoding} / Insert / ${key.name} retains stock dispatch`, () => {
        const f = fixture(["i"]);
        const stock = fixture(["i"]);
        f.editor.handleInput(key[encoding]);
        CustomEditor.prototype.handleInput.call(stock.editor, key[encoding]);
        // Pi-vim's existing submit wrapper also clears its own dot recording.
        const expected = stock.snapshot();
        if (key.name === "Enter") expected.repeat = null;
        assert.deepEqual(f.snapshot(), expected);
        assert.deepEqual(f.fired, stock.fired);
        assert.deepEqual(f.forwarded, stock.forwarded);
        assert.deepEqual(f.submitted, stock.submitted);
      });
    }
  }

  it("regresses 0.14.2 Ctrl-K deletion from Normal and pending find", () => {
    for (const setup of [[], ["f"]]) {
      const f = fixture(setup);
      const stock = fixture(setup);
      const before = f.snapshot();
      CustomEditor.prototype.handleInput.call(stock.editor, "\x0b");
      assert.equal(stock.editor.getText(), "alpha\nbravo\nci\ndelta\neagle");
      f.editor.handleInput("\x0b");
      assert.deepEqual(f.snapshot(), before);
      assertNoPending(f.state);
    }
  });

  it("Ctrl-N is not a motion; EX history beats even a registered app binding", () => {
    for (const mode of STATES) {
      const f = fixture(mode.setup);
      f.editor.onAction("app.session.toggleNamedFilter", () =>
        f.fired.push("filter"),
      );
      const before = f.snapshot();
      f.editor.handleInput("\x0e");
      assert.deepEqual(f.fired, mode.name === "ex" ? [] : ["filter"]);
      assert.deepEqual(f.snapshot(), before);
      assertNoPending(f.state);
    }
  });

  it("uses live remaps and registered actions, including printable remaps", () => {
    for (const key of ["\x0b", "q", "\x1b[1;3A"]) {
      const binding = key === "\x0b" ? "ctrl+k" : key === "q" ? "q" : "alt+up";
      for (const mode of STATES) {
        const f = fixture(mode.setup);
        f.kb.setUserBindings({ "app.model.cycleForward": binding });
        const before = f.snapshot();
        f.editor.handleInput(key);
        assert.deepEqual(f.fired, ["app.model.cycleForward"]);
        assert.deepEqual(f.snapshot(), before);
        assertNoPending(f.state);
      }
    }
    const f = fixture(["f"], { "app.model.cycleForward": [] });
    const before = f.snapshot();
    f.editor.handleInput("\x10");
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.fired, []);
    assert.deepEqual(f.forwarded, []);
    assertNoPending(f.state);
    f.editor.actionHandlers.delete("app.model.select");
    f.editor.handleInput("\x0c");
    assert.deepEqual(f.forwarded, []);
  });

  it("registered app actions beat editor history remaps except within EX", () => {
    for (const mode of STATES) {
      const f = fixture(mode.setup, { "tui.editor.historyPrevious": "ctrl+p" });
      const before = f.snapshot();
      f.editor.handleInput("\x10");
      assert.deepEqual(
        f.fired,
        mode.name === "ex" ? [] : ["app.model.cycleForward"],
      );
      assert.deepEqual(f.snapshot(), {
        ...before,
        ex: mode.name === "ex" ? ":ex-b" : before.ex,
      });
    }
  });

  it("honors remapped interrupt, exit and suspend dynamic callbacks", () => {
    for (const action of [
      "app.interrupt",
      "app.exit",
      "app.suspend",
    ] as const) {
      for (const mode of STATES) {
        const f = fixture(mode.setup, { [action]: "ctrl+k" });
        if (action === "app.exit") f.editor.setText("");
        f.editor.onEscape = () => f.fired.push("dynamic interrupt");
        f.editor.onCtrlD = () => f.fired.push("dynamic exit");
        const before = f.snapshot();
        f.editor.handleInput("\x0b");
        assert.deepEqual(f.fired, [
          action === "app.interrupt"
            ? "dynamic interrupt"
            : action === "app.exit"
              ? "dynamic exit"
              : action,
        ]);
        assert.deepEqual(f.snapshot(), {
          ...before,
          ex: action === "app.interrupt" ? null : before.ex,
        });
        assertNoPending(f.state);
      }
    }
  });

  it("nonempty exit and handlerless specials cannot fall into editor deletion", () => {
    for (const setup of [[], ["f"], [":", "q"], ["v"]]) {
      const f = fixture(setup);
      const before = f.snapshot();
      f.editor.handleInput("\x04");
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.fired, []);
      f.kb.setUserBindings({ "app.suspend": "ctrl+k" });
      f.editor.actionHandlers.delete("app.suspend");
      f.editor.handleInput("\x0b");
      assert.deepEqual(f.snapshot(), before);
    }
  });

  for (const [exit, suspend] of [
    ["\x04", "\x1a"],
    ["\x1b[100;5u", "\x1b[122;5u"],
  ] as const) {
    it(`default exit/suspend specials ${JSON.stringify(exit)} retain host guards`, () => {
      for (const mode of STATES) {
        const f = fixture(mode.setup);
        const before = f.snapshot();
        f.editor.handleInput(exit);
        assert.deepEqual(f.fired, []);
        assert.deepEqual(f.snapshot(), before);
        assertNoPending(f.state);
        f.editor.handleInput(suspend);
        assert.deepEqual(
          f.fired,
          f.kb.matches(suspend, "app.suspend") ? ["app.suspend"] : [],
        );
        assert.deepEqual(f.snapshot(), before);
        f.fired.length = 0;
        f.editor.setText("");
        f.editor.handleInput(exit);
        assert.deepEqual(f.fired, ["app.exit"]);
        assert.equal(f.editor.getText(), "");
      }
    });
  }

  it("app callbacks may change the prompt; routing never restores over them", () => {
    const f = fixture([":", "q"]);
    f.editor.onAction("app.clear", () => {
      assertNoPending(f.state);
      assert.equal(f.state.pendingExCommand, null);
      f.editor.setText("");
    });
    f.editor.handleInput("\x03");
    assert.equal(f.editor.getText(), "");
    assert.equal(f.editor.getMode(), "normal");
  });

  it("remapped interrupt respects the host autocomplete guard without editing", () => {
    const f = fixture(["f"], { "app.interrupt": "ctrl+k" });
    f.editor.isShowingAutocomplete = () => true;
    const before = f.snapshot();
    f.editor.handleInput("\x0b");
    assert.deepEqual(f.fired, []);
    assert.deepEqual(f.snapshot(), before);
    assertNoPending(f.state);
  });

  it("retains extension precedence only for admitted app chords", () => {
    const f = fixture(["3", "d", "2"]);
    f.editor.onExtensionShortcut = (data) => {
      f.forwarded.push(data);
      assertNoPending(f.state);
      return true;
    };
    const before = f.snapshot();
    f.editor.handleInput("\x10");
    f.editor.handleInput("\x0b");
    assert.deepEqual(f.forwarded, ["\x10"]);
    assert.deepEqual(f.fired, []);
    assert.deepEqual(f.snapshot(), before);
  });

  it("keeps modal Escape, but idle Normal and EX abort reach the app", () => {
    for (const setup of [[], [":", "q"]]) {
      const f = fixture(setup);
      const before = f.snapshot();
      f.editor.handleInput(ESC);
      assert.deepEqual(f.fired, ["app.interrupt"]);
      assert.deepEqual(f.snapshot(), { ...before, ex: null });
    }
    for (const setup of [["v"], ["V"], ["f"], ["3", "d"]]) {
      const f = fixture(setup);
      f.editor.handleInput(ESC);
      assert.deepEqual(f.fired, []);
      assert.equal(f.editor.getMode(), "normal");
      assertNoPending(f.state);
    }
  });

  it("keeps Vim undo/redo even when a contextual app action shares the key", () => {
    const f = fixture([]);
    f.editor.onAction("app.session.rename", () => f.fired.push("rename"));
    f.editor.handleInput("\x12");
    assert.equal(f.editor.getText(), "alpha\nbravo\ncider\ndelta\neaglXe");
    assert.deepEqual(f.fired, []);
    f.editor.handleInput("\x1f");
    assert.equal(f.editor.getText(), "alpha\nbravo\ncider\ndelta\neagle");
  });

  it("forwards the host's paste-image callback without treating paste data as keys", () => {
    const f = fixture([":", "q"]);
    f.editor.onPasteImage = () => f.fired.push("paste");
    const before = f.snapshot();
    f.editor.handleInput("\x16");
    assert.deepEqual(f.fired, ["paste"]);
    assert.deepEqual(f.snapshot(), before);
    for (const setup of [[], ["v"], [":", "q"]]) {
      for (const chunks of [
        ["\x1b[200~\x10\x03\x1b[201~"],
        ["\x1b[200~", "\x10", "\x03", "\x1b[201~"],
      ]) {
        const paste = fixture(setup);
        const snapshot = paste.snapshot();
        sendKeys(paste.editor, chunks);
        assert.deepEqual(paste.fired, []);
        assert.deepEqual(paste.snapshot(), snapshot);
      }
    }
  });

  it("consumes mouse reports without editor cursor movement", () => {
    for (const mode of STATES) {
      const f = fixture(mode.setup);
      f.editor.render(80);
      const before = f.snapshot();
      f.editor.handleInput("\x1b[<0;4;3M");
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.forwarded, []);
      assertNoPending(f.state);
    }
  });
});
