/**
 * ZZ intentionally differs from Vim's write-and-quit: a prompt has no file to
 * write, so ZZ uses :q's empty/whitespace guard; ZQ uses :q!'s forced shutdown.
 * The nvim oracle cannot snapshot a process after quit. Quit/notify/footer are
 * host seams covered here; non-quit Z-prefix behavior has curated mode parity.
 * These aliases are normal-only (unlike Vim's visual ZZ/ZQ).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModalEditor } from "../index.js";
import {
  createEditorWithSpy,
  createMultiLineEditor,
  sendKeys,
  stubTheme,
  stubTui,
} from "./harness.js";

function snapshot(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

function assertLabel(editor: ModalEditor, label: string) {
  assert.ok(editor.render(80).at(-1)?.endsWith(label));
}

const WARNING = "Prompt is not empty; use ZQ or :q! to quit anyway";

describe("normal-mode quit aliases", () => {
  for (const text of ["", "  \t\n ", "draft"]) {
    for (const command of ["ZZ", "ZQ"]) {
      it(`${command} uses its quit policy for ${JSON.stringify(text)}`, () => {
        const session = createMultiLineEditor(text);
        const { editor } = session;
        editor.setRegister("retained");
        const before = snapshot(editor);
        let submitted = 0;
        editor.onSubmit = () => {
          submitted++;
        };
        sendKeys(editor, [...command]);
        const refused = command === "ZZ" && text.trim().length > 0;
        assert.equal(session.quitCalls, refused ? 0 : 1);
        assert.deepEqual(session.notifications, refused ? [WARNING] : []);
        assert.deepEqual(snapshot(editor), before);
        assert.deepEqual(session.clipboardWrites, []);
        assert.equal(submitted, 0);
        assertLabel(editor, " NORMAL ");
      });
    }
  }

  it("refuses ZZ once, clears the prefix, and lets a subsequent ZQ quit", () => {
    const session = createEditorWithSpy("draft");
    sendKeys(session.editor, ["Z", "Z"]);
    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, [WARNING]);
    session.editor.handleInput("Q");
    assert.equal(session.quitCalls, 0);
    sendKeys(session.editor, ["Z", "Q"]);
    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, [WARNING]);
  });

  it("shows NORMAL Z_ without editing or quitting after the first key", () => {
    const session = createEditorWithSpy("abc");
    const before = snapshot(session.editor);
    session.editor.handleInput("Z");
    assertLabel(session.editor, " NORMAL Z_ ");
    assert.deepEqual(snapshot(session.editor), before);
    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, []);
  });

  for (const key of [
    "x",
    "i",
    "a",
    "d",
    "c",
    "y",
    "u",
    "\x12",
    ".",
    "v",
    "V",
    "g",
    "f",
    "r",
    ":",
    "\r",
    "\t",
    "\x1b[C",
    "1",
    "0",
    "ZZ",
  ]) {
    it(`drops ${JSON.stringify(key)} after Z and clears the prefix`, () => {
      const session = createEditorWithSpy("abc");
      const { editor } = session;
      editor.setRegister("retained\n");
      const before = snapshot(editor);
      let submitted = 0;
      editor.onSubmit = () => {
        submitted++;
      };
      sendKeys(editor, ["Z", key]);
      assert.deepEqual(snapshot(editor), before);
      assertLabel(editor, " NORMAL ");
      assert.equal(session.quitCalls, 0);
      assert.deepEqual(session.notifications, []);
      assert.deepEqual(session.clipboardWrites, []);
      assert.equal(submitted, 0);
      editor.handleInput("x");
      assert.equal(editor.getText(), "bc");
      assert.equal(editor.getRegister(), "a");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    });
  }

  for (const escapeKey of ["\x1b", "\x1b[91;5u"]) {
    it(`cancels on ${JSON.stringify(escapeKey)} without forwarding an agent abort`, () => {
      const keybindings = {
        getKeys: () => [],
        matches: (data: string, action: string) =>
          data === "\x1b" && action === "app.interrupt",
      } as unknown as ConstructorParameters<typeof ModalEditor>[2];
      const editor = new ModalEditor(stubTui, stubTheme, keybindings);
      let interrupts = 0;
      editor.onEscape = () => {
        interrupts++;
      };
      editor.handleInput("\x1b");
      sendKeys(editor, ["Z", escapeKey]);
      assertLabel(editor, " NORMAL ");
      assert.equal(editor.getText(), "");
      assert.equal(interrupts, 0);
      editor.handleInput("\x1b");
      assert.equal(interrupts, 1);
    });
  }

  for (const count of ["2", "99999999999999999999"]) {
    it(`discards prefix count ${count} before Z and after cancellation`, () => {
      const session = createEditorWithSpy("abcdef");
      sendKeys(session.editor, [...count, "Z"]);
      assertLabel(session.editor, " NORMAL Z_ ");
      sendKeys(session.editor, ["x", "x"]);
      assert.equal(session.editor.getText(), "bcdef");
      assert.equal(session.editor.getRegister(), "a");
      assert.deepEqual(session.editor.getCursor(), { line: 0, col: 0 });
      assert.equal(session.quitCalls, 0);
    });
  }

  it("discards counts on a refused ZZ and an uncounted successful ZZ", () => {
    const session = createEditorWithSpy("abc");
    sendKeys(session.editor, ["9", "Z", "Z", "x"]);
    assert.equal(session.editor.getText(), "bc");
    assert.deepEqual(session.notifications, [WARNING]);
    const empty = createEditorWithSpy("");
    sendKeys(empty.editor, ["9", "Z", "Z"]);
    assert.equal(empty.quitCalls, 1);
  });

  for (const mode of ["v", "V"]) {
    it(`never arms Z in ${mode} mode, including with a count`, () => {
      const session = createEditorWithSpy("abcd");
      sendKeys(session.editor, [mode]);
      const before = snapshot(session.editor);
      sendKeys(session.editor, ["9", "Z", "Z", "Z", "Q"]);
      assert.deepEqual(snapshot(session.editor), before);
      assert.equal(session.quitCalls, 0);
      assert.deepEqual(session.notifications, []);
      assertLabel(session.editor, mode === "v" ? " VISUAL " : " V-LINE ");
      session.editor.handleInput("l");
      assert.deepEqual(session.editor.getCursor(), { line: 0, col: 1 });
      sendKeys(session.editor, ["\x1b", "Q"]);
      assert.equal(session.quitCalls, 0);
    });
  }

  it("types ordinary ZZ/ZQ in Insert instead of arming the prefix", () => {
    const session = createEditorWithSpy("");
    sendKeys(session.editor, ["i", "Z", "Z", "Z", "Q"]);
    assert.equal(session.editor.getText(), "ZZZQ");
    assert.equal(session.editor.getMode(), "insert");
    assertLabel(session.editor, " INSERT ");
    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, []);
  });

  for (const keys of [
    ["d"],
    ["c"],
    ["y"],
    ["2", "d", "3"],
    ["2", "c", "3"],
    ["2", "y", "3"],
    ["d", "i"],
    ["g"],
    ["g", "2"],
  ]) {
    it(`does not arm Z while ${keys.join("")} is pending`, () => {
      const session = createEditorWithSpy("abcd");
      const before = snapshot(session.editor);
      sendKeys(session.editor, [...keys, "Z", "Q"]);
      assert.deepEqual(snapshot(session.editor), before);
      assertLabel(session.editor, " NORMAL ");
      assert.equal(session.quitCalls, 0);
      assert.deepEqual(session.notifications, []);
      assert.deepEqual(session.clipboardWrites, []);
      session.editor.handleInput("x");
      assert.equal(session.editor.getText(), "bcd");
    });
  }

  it("keeps Z available as a replace or char-find operand, not a quit prefix", () => {
    const replace = createEditorWithSpy("abc");
    sendKeys(replace.editor, ["r", "Z", "Q"]);
    assert.equal(replace.editor.getText(), "Zbc");
    assert.equal(replace.quitCalls, 0);
    const find = createEditorWithSpy("aZc");
    sendKeys(find.editor, ["f", "Z", "Q"]);
    assert.deepEqual(find.editor.getCursor(), { line: 0, col: 1 });
    assert.equal(find.editor.getText(), "aZc");
    assert.equal(find.quitCalls, 0);
  });

  it("keeps Z in the EX command buffer and clears it on EX cancellation", () => {
    const session = createEditorWithSpy("abc");
    sendKeys(session.editor, [":", "Z", "Q"]);
    assertLabel(session.editor, " EX :ZQ_ ");
    assert.equal(session.editor.getText(), "abc");
    assert.equal(session.quitCalls, 0);
    sendKeys(session.editor, ["\x1b", "Q"]);
    assertLabel(session.editor, " NORMAL ");
    assert.equal(session.quitCalls, 0);
  });

  it("clears pending Z before dropping a bracketed paste", () => {
    for (const paste of [
      ["\x1b[200~ZQ\x1b[201~"],
      ["\x1b[200~", "Z", "Q", "\x1b[201~"],
    ]) {
      const session = createEditorWithSpy("中🙂abc");
      const before = snapshot(session.editor);
      sendKeys(session.editor, ["Z", ...paste, "Q"]);
      assert.deepEqual(snapshot(session.editor), before);
      assertLabel(session.editor, " NORMAL ");
      assert.equal(session.quitCalls, 0);
      assert.deepEqual(session.notifications, []);
    }
  });

  it("preserves undo, redo and dot-repeat across Z cancellation and refused ZZ", () => {
    const session = createEditorWithSpy("abcd");
    const { editor } = session;
    sendKeys(editor, ["x", "u"]);
    assert.equal(editor.getText(), "abcd");
    for (const key of ["x", "u", ".", "\x12", "i", "Z", "\x1b"])
      sendKeys(editor, ["Z", key]);
    assert.equal(editor.getText(), "abcd");
    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "bcd");
    sendKeys(editor, ["."]);
    assert.equal(editor.getText(), "cd");
    sendKeys(editor, ["u", "u"]);
    assert.equal(editor.getText(), "abcd");
    sendKeys(editor, ["3", "\x12"]);
    assert.equal(editor.getText(), "cd");
    sendKeys(editor, ["u", "r", "X", "\x12"]);
    assert.equal(editor.getText(), "Xcd");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    assert.deepEqual(session.notifications, [WARNING]);
    assert.equal(session.quitCalls, 0);
  });
});
