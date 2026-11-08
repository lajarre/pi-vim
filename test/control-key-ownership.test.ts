import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { APP_KEYS, assertNoPending, fixture } from "./control-key-fixtures.js";
import { sendKeys, setInternalCursor } from "./harness.js";

const ESC = "\x1b";
const EDITOR_KEYS = [
  { name: "Ctrl-K", raw: "\x0b", kitty: "\x1b[107;5u" },
  { name: "Ctrl-U", raw: "\x15", kitty: "\x1b[117;5u" },
  { name: "Ctrl-A", raw: "\x01", kitty: "\x1b[97;5u" },
  { name: "Ctrl-E", raw: "\x05", kitty: "\x1b[101;5u" },
  { name: "Ctrl-W", raw: "\x17", kitty: "\x1b[119;5u" },
  { name: "Enter", raw: "\r", kitty: "\x1b[13u" },
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

const CURSOR_KEYS = [
  { name: "Up", raw: "\x1b[A", kitty: "\x1b[1;1A", motion: "k" },
  { name: "Down", raw: "\x1b[B", kitty: "\x1b[1;1B", motion: "j" },
  { name: "Left", raw: "\x1b[D", kitty: "\x1b[1;1D", motion: "h" },
  { name: "Right", raw: "\x1b[C", kitty: "\x1b[1;1C", motion: "l" },
  { name: "Ctrl-B", raw: "\x02", kitty: "\x1b[98;5u", motion: "h" },
  { name: "Ctrl-F", raw: "\x06", kitty: "\x1b[102;5u", motion: "l" },
  { name: "Ctrl-H", raw: "\x08", kitty: "\x1b[104;5u", motion: "h" },
  { name: "Backspace", raw: "\x7f", kitty: "\x1b[127u", motion: "h" },
] as const;
const CUSTOM_CURSOR_KEYS = [
  { name: "Ctrl-P", raw: "\x10", kitty: "\x1b[112;5u", motion: "k" },
  { name: "Ctrl-N", raw: "\x0e", kitty: "\x1b[110;5u", motion: "j" },
] as const;
const CUSTOM_CURSOR_BINDINGS = {
  "tui.editor.cursorUp": "ctrl+p",
  "tui.editor.cursorDown": "ctrl+n",
  // Pi does not remove another action's default when a key is reassigned.
  "app.model.cycleForward": [],
};

for (const custom of [false, true]) {
  describe(`host cursor aliases (${custom ? "custom" : "default"} bindings)`, () => {
    const bindings = custom ? CUSTOM_CURSOR_BINDINGS : {};
    for (const key of custom ? CUSTOM_CURSOR_KEYS : CURSOR_KEYS) {
      for (const encoding of ["raw", "kitty"] as const) {
        for (const setup of [
          [],
          ["2"],
          ["d"],
          ["y"],
          ["c"],
          ["v"],
          ["V"],
          ["2", "d", "2"],
          ["g"],
        ]) {
          it(`${key.name} ${encoding} after ${setup.join("") || "Normal"} equals ${key.motion}`, () => {
            const actual = fixture(setup, bindings);
            const expected = fixture(setup, bindings);
            actual.editor.render(8);
            expected.editor.render(8);
            actual.editor.handleInput(key[encoding]);
            expected.editor.handleInput(key.motion);
            assert.deepEqual(actual.snapshot(), expected.snapshot());
            assert.deepEqual(actual.fired, []);
            assert.deepEqual(actual.forwarded, []);
            assertNoPending(actual.state);
            sendKeys(actual.editor, [ESC, "l"]);
            sendKeys(expected.editor, [ESC, "l"]);
            assert.deepEqual(actual.snapshot(), expected.snapshot());
          });
        }
        it(`${key.name} ${encoding} in Insert keeps the stock binding`, () => {
          const actual = fixture(["i"], bindings);
          const expected = fixture(["i"], bindings);
          actual.editor.handleInput(key[encoding]);
          CustomEditor.prototype.handleInput.call(
            expected.editor,
            key[encoding],
          );
          assert.deepEqual(actual.snapshot(), expected.snapshot());
          assert.deepEqual(actual.fired, expected.fired);
          assert.deepEqual(actual.forwarded, expected.forwarded);
          if (key.name !== "Ctrl-H" || encoding !== "kitty")
            assert.notDeepEqual(actual.editor.getCursor(), { line: 2, col: 2 });
        });
      }
    }
    for (const encoding of ["raw", "kitty"] as const) {
      it(`${encoding} edge history recall, exhaustion, draft, undo and redo equal k/j`, () => {
        const actual = fixture([], bindings);
        const expected = fixture([], bindings);
        setInternalCursor(actual.editor, 2, 0);
        setInternalCursor(expected.editor, 2, 0);
        const up = (custom ? CUSTOM_CURSOR_KEYS : CURSOR_KEYS)[0][encoding];
        const down = (custom ? CUSTOM_CURSOR_KEYS : CURSOR_KEYS)[1][encoding];
        for (const [input, vim] of [
          [up, "k"],
          [up, "k"],
          [up, "k"],
          [down, "j"],
          [down, "j"],
          ["u", "u"],
          ["\x12", "\x12"],
        ]) {
          actual.editor.handleInput(input);
          expected.editor.handleInput(vim);
          assert.deepEqual(actual.snapshot(), expected.snapshot());
        }
      });
    }
  });
}

// Intentional divergence from nvim: application shortcuts are Pi-owned; unknown
// editor controls cannot edit in modal states. Explicit submit/EX Enter and Vim
// Escape/undo/redo remain exceptions, as do EX's C-p/C-n and Up/Down keys. Spies
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

  it("EX Up/Down own prefix history, not host cursor aliases or app shortcuts", () => {
    for (const bindings of [
      {},
      { "tui.editor.cursorUp": "k", "tui.editor.cursorDown": "j" },
      { "tui.editor.cursorUp": [], "tui.editor.cursorDown": [] },
      { "app.clear": "up", "app.interrupt": "down" },
    ]) {
      for (const encoding of ["raw", "kitty"] as const) {
        const f = fixture([":", "ex-"], bindings);
        f.editor.onExtensionShortcut = (key) => {
          f.forwarded.push(key);
          return true;
        };
        const before = f.snapshot();
        const up = CURSOR_KEYS[0][encoding];
        const down = CURSOR_KEYS[1][encoding];
        for (const [key, ex] of [
          [up, ":ex-b"],
          [up, ":ex-a"],
          [up, ":ex-a"],
          [down, ":ex-b"],
          [down, ":ex-"],
          [down, ":ex-"],
          ["k", ":ex-k"],
          [up, ":ex-k"],
        ]) {
          f.editor.handleInput(key);
          assert.deepEqual(f.snapshot(), { ...before, ex });
          assert.deepEqual(f.fired, []);
          assert.deepEqual(f.forwarded, []);
          assert.deepEqual(f.submitted, []);
          assertNoPending(f.state);
        }
      }
    }
  });

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

  it("clears pending state before extension precedence on app chords", () => {
    const f = fixture(["3", "d", "2"]);
    f.editor.onExtensionShortcut = (data) => {
      if (data !== "\x10") return false;
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
