import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import { compileVimSearch, findSearchTarget } from "../search.js";
import {
  createEditorWithSpy,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

describe("Vim search pattern subset", () => {
  it("supports magic dot, escaped quantifiers, and very-magic quantifiers", () => {
    assert.equal(compileVimSearch("a.b")?.test("axb"), true);
    assert.equal(compileVimSearch("ab\\+")?.test("abb"), true);
    assert.equal(compileVimSearch("\\vab+")?.test("abb"), true);
    assert.equal(compileVimSearch("ab+")?.test("abb"), false);
  });

  it("rejects unsupported Vim atoms instead of interpreting them as JS regex", () => {
    assert.equal(compileVimSearch("\\<word\\>"), null);
    assert.equal(compileVimSearch("\\Vfoo"), null);
    assert.equal(compileVimSearch("["), null);
    assert.equal(compileVimSearch("foo\\"), null);
  });

  it("skips overlapping matches, wraps, and observes count", () => {
    const regex = compileVimSearch("aa");
    assert.ok(regex);
    assert.equal(findSearchTarget("aaaa", regex, 0, 1), 2);
    assert.equal(findSearchTarget("aaaa", regex, 0, 1, 2), 0);
    assert.equal(findSearchTarget("aaaa", regex, 0, -1), 2);
  });

  it("does not report nonexistent matches", () => {
    const regex = compileVimSearch("z");
    assert.ok(regex);
    assert.equal(findSearchTarget("abc", regex, 0, 1), null);
  });
});

describe("search motion integration", () => {
  function editorWithText(text: string): ModalEditor {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    editor.setClipboardFn(() => undefined);
    editor.setText(text);
    editor.handleInput("\x1b");
    setInternalCursor(editor, 0);
    return editor;
  }

  it("undoes a search delete in one step", () => {
    const editor = editorWithText("foo bar baz");
    for (const key of ["d", "/", "baz", "\n"]) editor.handleInput(key);
    assert.equal(editor.getText(), "baz");
    editor.handleInput("u");
    assert.equal(editor.getText(), "foo bar baz");
  });

  it("does not delete on unsupported patterns or leak operator state", () => {
    const editor = editorWithText("foo bar baz");
    for (const key of ["d", "/", "\\<foo\\>", "\n", "l"])
      editor.handleInput(key);
    assert.equal(editor.getText(), "foo bar baz");
    assert.equal(editor.getCursor().col, 1);
  });

  it("mirrors a search delete to the unnamed register and clipboard", async () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo bar baz");
    for (const key of ["d", "/", "baz", "\n"]) editor.handleInput(key);
    assert.equal(editor.getRegister(), "foo bar ");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(clipboardWrites, ["foo bar "]);
  });

  it("does not auto-commit pasted newlines as search commands", () => {
    const editor = editorWithText("foo bar baz");
    editor.handleInput("/");
    editor.handleInput("\x1b[200~bar\n\x1b[201~");
    assert.equal(editor.getText(), "foo bar baz");
    assert.equal(editor.getCursor().col, 0);
  });
});
