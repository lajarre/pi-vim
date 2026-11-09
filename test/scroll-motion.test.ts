import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import {
  assertNoPending,
  fixture as ownershipFixture,
} from "./control-key-fixtures.js";
import {
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const D = "\x04",
  U = "\x15",
  F = "\x06",
  B = "\x02";
const long = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN".repeat(4);
function fixture(text = long, height = 7, width: number | null = 20) {
  const tui = {
    ...stubTui,
    terminal: { ...stubTui.terminal, rows: Math.ceil(height / 0.3) },
  };
  const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
  editor.setClipboardFn(() => assert.fail("motion must not mirror clipboard"));
  editor.setText(text);
  editor.setRegister("keep");
  editor.handleInput("\x1b");
  editor.addToHistory("older prompt");
  setInternalCursor(editor, 3);
  if (width !== null) editor.render(width + 1);
  return { editor, tui };
}
function cursor(editor: ModalEditor, col: number, line = 0) {
  assert.deepEqual(editor.getCursor(), { line, col });
  assert.equal(editor.getRegister(), "keep");
}

describe("default display-row scroll motions", () => {
  it("uses ceil(visible/2), page minus two, and sticky screen cells on wrapped rows", () => {
    const { editor } = fixture();
    editor.handleInput(D);
    cursor(editor, 83);
    editor.handleInput(U);
    cursor(editor, 3);
    editor.handleInput(F);
    cursor(editor, 103);
    editor.handleInput(B);
    cursor(editor, 3);
    assert.equal(editor.getText(), long);
    assert.equal(editor.getMode(), "normal");
  });

  it("remembers explicit half-page rows for both directions; full-page counts multiply only that press", () => {
    const { editor } = fixture(long.repeat(4));
    sendKeys(editor, ["2", D, D]);
    cursor(editor, 83);
    editor.handleInput(U);
    cursor(editor, 43);
    sendKeys(editor, ["2", F]);
    cursor(editor, 243);
    editor.handleInput(B);
    cursor(editor, 143);
    editor.handleInput(D);
    cursor(editor, 183);
    editor.handleInput("l");
    cursor(editor, 184);
    editor.handleInput(U);
    cursor(editor, 144);
    editor.render(21); // An unchanged height preserves the preference.
    editor.handleInput(D);
    cursor(editor, 184);
  });

  it("resets remembered half-page rows only when the rendered text height changes", () => {
    const text = Array(80).fill("abcdefghij").join("\n");
    for (const key of [D, U]) {
      const { editor, tui } = fixture(text, 7);
      setInternalCursor(editor, 3, 30);
      sendKeys(editor, ["5", D]);
      cursor(editor, 3, 35);
      tui.terminal.rows = 40; // Twelve text rows after the next render.
      editor.handleInput(D);
      cursor(editor, 3, 40); // Still remembers five before rendering.
      editor.render(21);
      editor.handleInput(key);
      cursor(editor, 3, key === D ? 46 : 34);
      assert.equal(editor.getText(), text);
      assert.equal(editor.getMode(), "normal");
      editor.handleInput("l");
      cursor(editor, 4, key === D ? 46 : 34); // No leaked count.
    }
    const { editor, tui } = fixture(text, 7);
    sendKeys(editor, ["5", D]);
    tui.terminal.rows = 25; // Same seven text rows after rounding.
    editor.render(31); // Width-only change with unwrapped text.
    editor.handleInput(D);
    cursor(editor, 3, 10);

    // A width change can also change the actual editor height without a
    // terminal-height change: ten buffer rows become twelve visible rows.
    const wrapped = fixture(long, 12, 20).editor;
    sendKeys(wrapped, ["5", D]);
    cursor(wrapped, 103);
    wrapped.render(11);
    wrapped.handleInput(U);
    cursor(wrapped, 43); // Six new rows, not the remembered five.
    assert.equal(wrapped.getText(), long);
  });

  it("uses actual rendered height, not the cap, and updates only after a render", () => {
    const { editor, tui } = fixture(long, 7);
    tui.terminal.rows = 100;
    editor.handleInput(D);
    cursor(editor, 83); // Previous seven-row viewport.
    editor.render(21); // Ten buffer rows, despite a 30-row cap.
    editor.handleInput(D);
    cursor(editor, 183);
    editor.handleInput(U);
    cursor(editor, 83);
    editor.render(11); // Twenty rows; width change resets preferred screen cell.
    editor.handleInput(D);
    cursor(editor, 183);
    assert.equal(editor.getText(), long);
  });

  it("excludes autocomplete output from the last-rendered text height", () => {
    const { editor } = fixture("abc\ndef\nghi", 12, null);
    // Simulate the existing host autocomplete surface, without a new runtime seam.
    Object.assign(editor, {
      autocompleteState: "prefix",
      autocompleteList: { render: () => Array(8).fill("completion") },
    });
    setInternalCursor(editor, 1);
    editor.render(21);
    editor.handleInput(D);
    cursor(editor, 1, 2);
    editor.handleInput(U);
    cursor(editor, 1, 0);
  });

  it("measures the text viewport after the host scrolls to the buffer end", () => {
    const text = Array(30).fill("abcdefghij").join("\n");
    const { editor } = fixture(text);
    setInternalCursor(editor, 3, 29);
    editor.render(21);
    editor.handleInput(U);
    cursor(editor, 3, 25);
    editor.render(21);
    editor.handleInput(F);
    cursor(editor, 3, 29);
    editor.render(21);
    editor.handleInput(B);
    cursor(editor, 3, 24);
    assert.equal(editor.getText(), text);
  });

  it("uses one no-wrap row per logical line before first render, the whole buffer is a page", () => {
    const { editor } = fixture(Array(9).fill(long).join("\n"), 7, null);
    editor.handleInput(D);
    cursor(editor, 3, 5);
    editor.handleInput(U);
    cursor(editor, 3, 0);
    editor.handleInput(F);
    cursor(editor, 3, 7);
    editor.handleInput(B);
    cursor(editor, 3, 0);
  });

  it("keeps the wanted cell across short/empty rows, gj/gk and Visual entry", () => {
    const { editor } = fixture(`${long.slice(0, 23)}\n\n${long}`);
    setInternalCursor(editor, 15);
    sendKeys(editor, ["1", D]);
    cursor(editor, 22);
    sendKeys(editor, ["v", D]);
    cursor(editor, 0, 1);
    sendKeys(editor, ["g", "j"]);
    cursor(editor, 15, 2);
    editor.handleInput(U);
    cursor(editor, 0, 1);
    editor.handleInput(U);
    cursor(editor, 23); // Visual allows the EOL cell.
    assert.equal(editor.getMode(), "visual");
  });

  it("preserves screen cells across wide graphemes, and invalidates after edits/resize", () => {
    const { editor } = fixture("中e\u0301😀".repeat(30), 7, 8);
    setInternalCursor(editor, 3);
    sendKeys(editor, ["1", D]);
    cursor(editor, 10);
    editor.handleInput(U);
    cursor(editor, 3);
    editor.setText(long);
    setInternalCursor(editor, 1);
    editor.render(21);
    editor.handleInput(D);
    cursor(editor, 21); // Same seven-row height preserves the remembered one.
    editor.render(11);
    editor.handleInput(D);
    cursor(editor, 31); // Only the wanted column resets.
  });

  it("clamps huge counts without history recall, consumes them at edges and preserves undo/redo/dot", () => {
    for (const key of [D, U, F, B]) {
      const f = ownershipFixture([]);
      f.editor.render(21);
      const before = f.snapshot();
      sendKeys(f.editor, [..."999999", key]);
      const atEdge = f.snapshot();
      assert.deepEqual(atEdge, {
        ...before,
        cursor: { line: key === D || key === F ? 4 : 0, col: 2 },
      });
      f.editor.handleInput(key);
      assert.deepEqual(f.snapshot(), atEdge);
      assertNoPending(f.state);
      f.editor.handleInput("l");
      assert.equal(f.editor.getCursor().col, 3);
      assert.equal(f.state.redoStack.length, 1);
      f.editor.handleInput("\x12");
      assert.equal(f.editor.getText(), "alpha\nbravo\ncider\ndelta\neaglXe");
      sendKeys(f.editor, ["u", "x"]);
      assert.equal(f.state.redoStack.length, 0);
      const edited = f.editor.getText();
      f.editor.handleInput("\x12");
      assert.equal(f.editor.getText(), edited);
    }
  });

  it("does not recall history on single/empty prompts and full page has a minimum of one", () => {
    for (const text of ["", "abc", "abc\ndef"]) {
      const { editor } = fixture(text);
      setInternalCursor(editor, 0);
      sendKeys(editor, [B, U, F, D, F]);
      assert.equal(editor.getText(), text);
      cursor(editor, 0, text.includes("\n") ? 1 : 0);
    }
  });

  it("extends charwise and linewise selections without editing or changing their anchors", () => {
    for (const visual of ["v", "V"]) {
      const f = ownershipFixture([]);
      f.editor.render(21);
      sendKeys(f.editor, [visual, "1", D]);
      assert.deepEqual(f.editor.getCursor(), { line: 3, col: 2 });
      assert.equal(
        f.editor.getMode(),
        visual === "v" ? "visual" : "visual-line",
      );
      f.editor.handleInput("y");
      assert.equal(
        f.editor.getRegister(),
        visual === "v" ? "der\ndel" : "cider\ndelta\n",
      );
      assert.deepEqual(f.snapshot().writes, [f.editor.getRegister()]);
    }
  });

  it("fails closed on changed host layout, cancels counts and preserves text/register/history", () => {
    for (const buildVisualLineMap of [
      undefined,
      () => [],
      () => {
        throw new Error("changed");
      },
    ]) {
      const f = ownershipFixture([]);
      const notices: string[] = [];
      f.editor.setNotifyFn((s) => notices.push(s));
      f.editor.render(21);
      Object.assign(f.editor, { buildVisualLineMap });
      const before = f.snapshot();
      sendKeys(f.editor, ["2", D]);
      assert.deepEqual(f.snapshot(), before);
      assertNoPending(f.state);
      assert.equal(notices.length, 1);
    }
  });
});
