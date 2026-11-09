import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { assertNoPending, fixture } from "./control-key-fixtures.js";
import { sendKeys, setInternalCursor } from "./harness.js";

const ALT_U = ["\x1bu", "\x1b[117;3u"] as const;
const OWNED_CONTROLS = [
  { binding: "ctrl+h", keys: ["\x08", "\x1b[104;5u"], motion: "h" },
  { binding: "backspace", keys: ["\x7f", "\x1b[127u"], motion: "h" },
  { binding: "ctrl+d", keys: ["\x04", "\x1b[100;5u"] },
  { binding: "ctrl+u", keys: ["\x15", "\x1b[117;5u"] },
  { binding: "ctrl+f", keys: ["\x06", "\x1b[102;5u"], motion: "l" },
  { binding: "ctrl+b", keys: ["\x02", "\x1b[98;5u"], motion: "h" },
  { binding: "left", keys: ["\x1b[D", "\x1b[1;1D"], motion: "h" },
] as const;

// Intentional divergence from nvim: Pi extension shortcuts are host actions.
describe("Normal-mode extension shortcuts", () => {
  for (const key of ALT_U) {
    it(`dispatches Alt-U ${JSON.stringify(key)} without editing or leaking counts`, () => {
      const f = fixture(["3", "d", "2"]);
      const before = f.snapshot();
      let calls = 0;
      f.editor.onExtensionShortcut = (data) => {
        if (!matchesKey(data, "alt+u")) return false;
        calls++;
        return true;
      };
      f.editor.handleInput(key);
      assert.equal(calls, 1);
      assertNoPending(f.state);
      assert.deepEqual(f.snapshot(), before);
      f.editor.handleInput("l");
      assert.deepEqual(f.editor.getCursor(), { line: 2, col: 3 });
    });
  }

  it("does not overwrite buffer changes made by the shortcut", () => {
    const f = fixture([]);
    f.editor.onExtensionShortcut = () => {
      f.editor.setText("restored prompt");
      return true;
    };
    f.editor.handleInput("\x1bu");
    assert.equal(f.editor.getText(), "restored prompt");
    assert.equal(f.editor.getMode(), "normal");
  });

  it("leaves EX, visual modes, paste and Vim history in control", () => {
    for (const setup of [[":", "q"], ["v"], ["V"]]) {
      for (const key of ALT_U) {
        const f = fixture(setup);
        const before = f.snapshot();
        let calls = 0;
        f.editor.onExtensionShortcut = () => {
          calls++;
          return true;
        };
        f.editor.handleInput(key);
        assert.equal(calls, 0);
        assert.deepEqual(f.snapshot(), before);
        assert.deepEqual(f.fired, []);
        assertNoPending(f.state);
      }
    }
    for (const key of [
      "\x12",
      "\x1f",
      "\x1b[114;5u",
      "\x1b[95;5u",
      "\x1b[200~\x1bu\x1b[201~",
    ]) {
      const actual = fixture([]);
      const expected = fixture([]);
      let calls = 0;
      actual.editor.onExtensionShortcut = () => {
        calls++;
        return true;
      };
      actual.editor.handleInput(key);
      expected.editor.handleInput(key);
      assert.equal(calls, 0);
      assert.deepEqual(actual.snapshot(), expected.snapshot());
    }
  });

  for (const scrollKeys of [false, true]) {
    for (const control of OWNED_CONTROLS) {
      const { binding, keys } = control;
      for (const key of keys) {
        for (const setup of [
          [],
          ["3"],
          ["3", "d", "2"],
          ["f"],
          ["r"],
          ["d", "i"],
          ["g"],
          ["Z"],
        ]) {
          it(`claims ${binding} ${JSON.stringify(key)} before aliases/scroll (scrollKeys=${scrollKeys}, ${setup.join("") || "Normal"})`, () => {
            const f = fixture(setup);
            f.editor.setScrollKeys(scrollKeys);
            const before = f.snapshot();
            const calls: string[] = [];
            f.editor.onExtensionShortcut = (data) => {
              if (!matchesKey(data, binding)) return false;
              calls.push(data);
              // A host handler may return true before its async work starts.
              // No buffer edit is needed to consume the pending Vim command.
              return true;
            };
            f.editor.handleInput(key);
            assert.deepEqual(calls, [key]);
            assert.deepEqual(f.fired, []);
            assert.deepEqual(f.submitted, []);
            assert.deepEqual(f.snapshot(), before);
            assertNoPending(f.state);
            f.editor.handleInput("l");
            assert.deepEqual(f.editor.getCursor(), { line: 2, col: 3 });
          });
        }

        for (const handler of ["absent", "declines"] as const) {
          it(`${handler} ${binding} preserves Vim ownership (scrollKeys=${scrollKeys}, ${JSON.stringify(key)})`, () => {
            const f = fixture(["2"]);
            const expected = fixture(["2"]);
            f.editor.setScrollKeys(scrollKeys);
            expected.editor.setScrollKeys(scrollKeys);
            f.editor.render(8);
            expected.editor.render(8);
            f.editor.onExtensionShortcut =
              handler === "absent" ? undefined : () => false;
            f.editor.handleInput(key);
            // Canonical motions provide an independent no-extension oracle.
            const motion = "motion" in control ? control.motion : undefined;
            const scrolling =
              scrollKeys &&
              ["ctrl+d", "ctrl+u", "ctrl+f", "ctrl+b"].includes(binding);
            expected.editor.handleInput(motion && !scrolling ? motion : key);
            assert.deepEqual(f.snapshot(), expected.snapshot());
            assert.deepEqual(f.fired, expected.fired);
            assert.deepEqual(f.submitted, []);
            assertNoPending(f.state);
          });
        }
      }
    }
  }

  it("lets extension claims beat app chords exactly once, including empty-prompt exit", () => {
    for (const text of ["", "draft"]) {
      for (const key of ["\x04", "\x1b[100;5u", ...ALT_U]) {
        const f = fixture([], { "app.model.cycleForward": "alt+u" });
        f.editor.setText(text);
        f.editor.setScrollKeys(true);
        sendKeys(f.editor, ["3", "d"]);
        const before = f.snapshot();
        const calls: string[] = [];
        f.editor.onExtensionShortcut = (data) => {
          calls.push(data);
          return true;
        };
        f.editor.handleInput(key);
        assert.deepEqual(calls, [key]);
        assert.deepEqual(f.fired, []);
        assert.deepEqual(f.snapshot(), before);
        assertNoPending(f.state);
      }
    }
  });

  it("declined app chords run once without a second extension probe", () => {
    const f = fixture(["3", "d"], { "app.model.cycleForward": "alt+u" });
    const before = f.snapshot();
    const calls: string[] = [];
    f.editor.onExtensionShortcut = (key) => {
      calls.push(key);
      return false;
    };
    f.editor.handleInput(ALT_U[0]);
    assert.deepEqual(calls, [ALT_U[0]]);
    assert.deepEqual(f.fired, ["app.model.cycleForward"]);
    assert.deepEqual(f.snapshot(), before);
    assertNoPending(f.state);
  });

  it("probes raw custom cursor bindings without changing app/alias precedence on a miss", () => {
    for (const claimed of [true, false]) {
      const f = fixture(["2"], { "tui.editor.cursorUp": "alt+u" });
      const calls: string[] = [];
      f.editor.onExtensionShortcut = (data) => {
        calls.push(data);
        return claimed;
      };
      f.editor.handleInput(ALT_U[1]);
      assert.deepEqual(calls, [ALT_U[1]]);
      assert.deepEqual(f.editor.getCursor(), { line: claimed ? 2 : 0, col: 2 });
      assert.deepEqual(f.fired, []);
      assertNoPending(f.state);
    }
  });

  it("keeps claimed shortcuts out of dot replay and preserves undo/redo until a real edit", () => {
    for (const key of [ALT_U[0], "\x08", "\x15"]) {
      const f = fixture([]);
      const expected = fixture([]);
      f.editor.setScrollKeys(true);
      expected.editor.setScrollKeys(true);
      let claims = 0;
      f.editor.onExtensionShortcut = (data) => {
        if (data !== key) return false;
        claims++;
        return true;
      };
      sendKeys(f.editor, ["3", "d", "2", key]);
      assertNoPending(f.state);
      assert.equal(f.state.redoStack.length, 1);
      for (const input of [
        ".",
        "u",
        "\x12",
        "u",
        "x",
        "\x12",
        "u",
        "u",
        "u",
        "u",
      ]) {
        f.editor.handleInput(input);
        expected.editor.handleInput(input);
        assert.deepEqual(f.snapshot(), expected.snapshot());
        if (input === "x") assert.equal(f.state.redoStack.length, 0);
      }
      assert.equal(claims, 1);
    }
  });

  it("resets sticky display-column intent when a scroll shortcut is claimed", () => {
    const f = fixture([]);
    f.editor.setText("abcdefghij\nx\nabcdefghij");
    f.editor.setScrollKeys(true);
    setInternalCursor(f.editor, 8, 0);
    f.editor.render(80);
    sendKeys(f.editor, ["g", "j"]);
    assert.deepEqual(f.editor.getCursor(), { line: 1, col: 0 });
    f.editor.onExtensionShortcut = (data) => matchesKey(data, "ctrl+u");
    sendKeys(f.editor, ["\x15", "g", "j"]);
    assert.deepEqual(f.editor.getCursor(), { line: 2, col: 0 });
  });

  it("never dispatches pasted Alt-U, including split paste frames and EX", () => {
    for (const key of ALT_U) {
      for (const setup of [[], ["3", "d"], [":", "q"], ["v"], ["V"]]) {
        for (const chunks of [
          [`\x1b[200~${key}\x1b[201~`],
          ["\x1b[200~", key, "\x1b[201~"],
          ["\x1b[200~", key, "\x1b", "[201~"],
        ]) {
          const f = fixture(setup);
          const expected = fixture(setup);
          let calls = 0;
          f.editor.onExtensionShortcut = () => {
            calls++;
            return true;
          };
          sendKeys(f.editor, chunks);
          sendKeys(expected.editor, chunks);
          assert.equal(calls, 0);
          assert.deepEqual(f.snapshot(), expected.snapshot());
          assert.deepEqual(f.fired, []);
          assert.deepEqual(f.submitted, []);
          assertNoPending(f.state);
        }
      }
    }
  });

  it("keeps modal Escape and pending submit out of the extension-only probe", () => {
    for (const key of ["\x1b", "\x1b[27u", "\r", "\x1b[13u"]) {
      const f = fixture(["3", "d", "2"]);
      const before = f.snapshot();
      const calls: string[] = [];
      f.editor.onExtensionShortcut = (data) => {
        calls.push(data);
        return true;
      };
      f.editor.handleInput(key);
      assert.deepEqual(calls, []);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.submitted, []);
      assertNoPending(f.state);
    }
    const f = fixture(["3"], { "tui.input.submit": "alt+u" });
    let calls = 0;
    f.editor.onExtensionShortcut = () => {
      calls++;
      return true;
    };
    f.editor.handleInput(ALT_U[0]);
    assert.equal(calls, 0);
    assertNoPending(f.state);
    assert.deepEqual(f.submitted, []);
  });

  it("preserves printable Vim commands even when a shortcut would handle them", () => {
    const f = fixture([]);
    let calls = 0;
    f.editor.onExtensionShortcut = () => {
      calls++;
      return true;
    };
    f.editor.handleInput("l");
    assert.equal(calls, 0);
    assert.deepEqual(f.editor.getCursor(), { line: 2, col: 3 });
    assert.deepEqual(f.fired, []);
  });

  it("allows an extension to claim Ctrl-U without the editor deletion fallback", () => {
    const f = fixture([]);
    const before = f.snapshot();
    let calls = 0;
    f.editor.onExtensionShortcut = (data) => {
      if (!matchesKey(data, "ctrl+u")) return false;
      calls++;
      return true;
    };
    f.editor.handleInput("\x15");
    assert.equal(calls, 1);
    assert.deepEqual(f.snapshot(), before);
  });

  it("keeps unhandled controls harmless and Insert extension dispatch unchanged", () => {
    const f = fixture([]);
    const before = f.snapshot();
    f.editor.onExtensionShortcut = () => false;
    f.editor.handleInput("\x15");
    assert.deepEqual(f.snapshot(), before);

    for (const key of ALT_U) {
      const insert = fixture(["i"]);
      const draft = insert.snapshot();
      let calls = 0;
      insert.editor.onExtensionShortcut = (data) => {
        if (!matchesKey(data, "alt+u")) return false;
        calls++;
        return true;
      };
      insert.editor.handleInput(key);
      assert.equal(calls, 1);
      assert.deepEqual(insert.snapshot(), draft);
    }
  });
});
