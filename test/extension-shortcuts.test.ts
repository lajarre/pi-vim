import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { assertNoPending, fixture } from "./control-key-fixtures.js";

// Intentional divergence from nvim: Pi extension shortcuts are host actions.
describe("Normal-mode extension shortcuts", () => {
  for (const key of ["\x1bu", "\x1b[117;3u"]) {
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

  it("leaves EX, visual modes, paste, cursor aliases and Vim history in control", () => {
    for (const setup of [[":"], ["v"], ["V"]]) {
      const f = fixture(setup);
      let calls = 0;
      f.editor.onExtensionShortcut = () => {
        calls++;
        return true;
      };
      f.editor.handleInput("\x1bu");
      assert.equal(calls, 0);
    }
    for (const key of [
      "\x12",
      "\x1f",
      "\x02",
      "\x06",
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

    const insert = fixture(["i"]);
    const draft = insert.snapshot();
    let calls = 0;
    insert.editor.onExtensionShortcut = (data) => {
      if (!matchesKey(data, "alt+u")) return false;
      calls++;
      return true;
    };
    insert.editor.handleInput("\x1bu");
    assert.equal(calls, 1);
    assert.deepEqual(insert.snapshot(), draft);
  });
});
