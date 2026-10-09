import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { ModalEditor } from "../index.js";
import { highlightSearchRows } from "../search-highlight.js";
import {
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

function editorWithText(text: string, col = 0, line = 0): ModalEditor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setText(text);
  editor.handleInput("\x1b");
  setInternalCursor(editor, col, line);
  return editor;
}

const all = "\x1b[4m";
const current = "\x1b[4;7m";
const count = (text: string, pattern: string) => text.split(pattern).length - 1;

function draft(editor: ModalEditor, width: number): string {
  return editor.render(width).slice(1, -1).join("\n");
}

describe("search highlights", () => {
  it("previews all matches and distinguishes the backward target without moving", () => {
    const editor = editorWithText("word xx word", 8);
    editor.handleInput("?");
    editor.handleInput("word");
    const preview = draft(editor, 30);
    assert.equal(count(preview, current), 4);
    assert.equal(count(preview, all), 4);
    assert.equal(editor.getCursor().col, 8);
    editor.handleInput("\n");
    const committed = draft(editor, 30);
    assert.equal(editor.getCursor().col, 0);
    assert.equal(count(committed, current), 4);
    assert.equal(count(committed, all), 4);
    assert.equal(editor.getText(), "word xx word");
  });

  it("clears previews on cancel, retains the last committed pattern", () => {
    const editor = editorWithText("word and bird word");
    editor.handleInput("/");
    editor.handleInput("word");
    editor.handleInput("\n");
    editor.handleInput("?");
    editor.handleInput("bird");
    assert.equal(count(draft(editor, 40), current), 4);
    editor.handleInput("\x03");
    assert.equal(count(draft(editor, 40), all), 4);
    assert.equal(count(draft(editor, 40), current), 4);
    assert.equal(editor.getText(), "word and bird word");
  });

  it("moves the distinct match with n/N and leaves the draft unchanged", () => {
    const editor = editorWithText("word one word two word");
    for (const key of ["/", "word", "\n"]) editor.handleInput(key);
    assert.equal(editor.getCursor().col, 9);
    assert.equal(count(draft(editor, 50), current), 4);
    editor.handleInput("n");
    assert.equal(editor.getCursor().col, 18);
    assert.equal(count(draft(editor, 50), current), 4);
    editor.handleInput("N");
    assert.equal(editor.getCursor().col, 9);
    assert.equal(editor.getText(), "word one word two word");
  });

  it("keeps row widths and graphemes intact across wrapping and logical lines", () => {
    const editor = editorWithText("🦊 fox 🦊 fox\nfox 🦊", 0);
    editor.focused = true;
    for (const key of ["/", "🦊", "\n"]) editor.handleInput(key);
    for (const width of [8, 12, 20, 40]) {
      const rows = editor.render(width);
      assert.equal(rows.join("").split(CURSOR_MARKER).length - 1, 1);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.ok(rows.join("").includes(current));
    }
  });

  it("highlights only the visible rows of a scrolled draft", () => {
    const source = ["word", ...Array(13).fill("line"), "word"].join("\n");
    const editor = editorWithText(source, 0, 14);
    for (const key of ["/", "word", "\n"]) editor.handleInput(key);
    const rows = editor.render(30);
    assert.equal(rows.length, 14);
    assert.equal(count(rows.join(""), current), 4);
    assert.ok(rows.every((row) => visibleWidth(row) <= 30));
  });

  it("falls back to unchanged native rows when layout internals are unavailable", () => {
    const rows = ["---", "fox", "---"];
    highlightSearchRows(
      rows,
      { getLines: () => ["fox"], getPaddingX: () => 0, focused: false },
      3,
      [{ start: 0, end: 3 }],
      0,
    );
    assert.deepEqual(rows, ["---", "fox", "---"]);
  });
});
