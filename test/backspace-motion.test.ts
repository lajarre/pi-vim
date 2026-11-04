import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoPending, fixture } from "./control-key-fixtures.js";
import { sendKeys, setInternalCursor } from "./harness.js";

const aliases = ["h", "\x08", "\x7f", "\x1b[104;5u", "\x1b[127u"];
describe("backspace left motion", () => {
  for (const alias of aliases) {
    it(`${JSON.stringify(alias)} consumes counted operators and preserves graphemes`, () => {
      for (const op of ["d", "c", "y"]) {
        const f = fixture([]);
        f.editor.setText("a👩🏽‍💻éz");
        setInternalCursor(f.editor, "a👩🏽‍💻é".length, 0);
        sendKeys(f.editor, ["2", op, alias]);
        assert.equal(f.editor.getText(), op === "y" ? "a👩🏽‍💻éz" : "az");
        assert.equal(f.editor.getRegister(), "👩🏽‍💻é");
        assert.deepEqual(f.snapshot().writes, ["👩🏽‍💻é"]);
        assert.deepEqual(f.editor.getCursor(), { line: 0, col: 1 });
        assert.equal(f.editor.getMode(), op === "c" ? "insert" : "normal");
        assertNoPending(f.state);
      }
    });
    it(`${JSON.stringify(alias)} multiplies counts, clamps, and preserves history on no-op`, () => {
      const f = fixture([]);
      setInternalCursor(f.editor, 4, 2);
      sendKeys(f.editor, ["2", "d", "2", alias]);
      assert.equal(f.editor.getText(), "alpha\nbravo\nr\ndelta\neagle");
      assert.equal(f.editor.getRegister(), "cide");
      assert.deepEqual(f.editor.getCursor(), { line: 2, col: 0 });
      sendKeys(f.editor, ["u"]);
      const before = f.snapshot();
      for (const op of ["d", "c", "y"]) {
        setInternalCursor(f.editor, 0, 2);
        const edge = f.snapshot();
        sendKeys(f.editor, [..."999999", op, alias]);
        assert.deepEqual(
          f.snapshot(),
          op === "y"
            ? {
                ...edge,
                register: "",
                // Empty yanks clear the register without mirroring a payload.
                writes: edge.writes,
              }
            : edge,
        );
        assertNoPending(f.state);
      }
      assert.deepEqual(f.snapshot().redo, before.redo);
      f.editor.handleInput("l");
      assert.deepEqual(f.editor.getCursor(), { line: 2, col: 1 });
      f.editor.handleInput("x");
      assert.equal(f.state.redoStack.length, 0);
    });
    it(`${JSON.stringify(alias)} records canonical h for dot, undo and redo`, () => {
      const f = fixture([]);
      f.state.undoStack.stack.length = 0;
      setInternalCursor(f.editor, 4, 2);
      sendKeys(f.editor, ["d", alias, "."]);
      assert.equal(f.editor.getText(), "alpha\nbravo\ncir\ndelta\neagle");
      sendKeys(f.editor, ["u", "\x12"]);
      assert.equal(f.editor.getText(), "alpha\nbravo\ncir\ndelta\neagle");
      sendKeys(f.editor, [..."999u"]);
      assert.equal(f.editor.getText(), "alpha\nbravo\ncider\ndelta\neagle");
    });
  }

  it("always aliases backspace despite disabled/remapped cursor bindings", () => {
    for (const alias of aliases.slice(1)) {
      const f = fixture([], {
        "tui.editor.cursorLeft": [],
        "tui.editor.cursorUp": "ctrl+h",
      });
      f.editor.handleInput(alias);
      assert.deepEqual(f.editor.getCursor(), { line: 2, col: 1 });
    }
  });

  it("keeps EX backspace editing and rejects literal/paste control arguments", () => {
    for (const alias of aliases.slice(1)) {
      const ex = fixture([":", "q"]);
      ex.editor.handleInput(alias);
      assert.equal(ex.state.pendingExCommand, ":");
      for (const setup of [["f"], ["r"], ["d", "i"], ["Z"]]) {
        const f = fixture(setup);
        const before = f.snapshot();
        f.editor.handleInput(alias);
        assert.deepEqual(f.snapshot(), before);
        assertNoPending(f.state);
      }
      const paste = fixture([]);
      const before = paste.snapshot();
      sendKeys(paste.editor, ["\x1b[200~", alias, "\x1b[201~"]);
      assert.deepEqual(paste.snapshot(), before);
    }
  });

  it("retains the unnamed register when clipboard mirroring fails", async () => {
    const f = fixture([]);
    f.editor.setClipboardFn(() => {
      throw new Error("unavailable");
    });
    sendKeys(f.editor, ["y", "\x08"]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(f.editor.getRegister(), "i");
    assert.deepEqual(f.editor.getCursor(), { line: 2, col: 1 });
  });
});
