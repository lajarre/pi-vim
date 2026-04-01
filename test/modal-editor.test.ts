/**
 * Integration tests for ModalEditor key sequences.
 *
 * Smoke matrix: ~30+ scenarios covering the full command surface.
 * Table-driven style used wherever the pattern is uniform; explicit `it`
 * blocks where state inspection requires nuance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModalEditor } from "../index.js";
import {
  createEditorWithSpy,
  createMultiLineEditor,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run keys on a fresh single-line editor and check text + optional register. */
function chk(
  initial: string,
  keys: string[],
  expectedText: string,
  expectedRegister?: string,
): void {
  const { editor } = createEditorWithSpy(initial);
  sendKeys(editor, keys);
  assert.equal(editor.getText(), expectedText, `text after [${keys.join("")}]`);
  if (expectedRegister !== undefined) {
    assert.equal(
      editor.getRegister(),
      expectedRegister,
      `register after [${keys.join("")}]`,
    );
  }
}

/** Run keys on a fresh editor and check mode. */
function chkMode(
  initial: string,
  keys: string[],
  expectedMode: "normal" | "insert",
): void {
  const { editor } = createEditorWithSpy(initial);
  sendKeys(editor, keys);
  assert.equal(editor.getMode(), expectedMode, `mode after [${keys.join("")}]`);
}

function assertRedoRoundTrip(options: {
  initial: string;
  keys: string[];
  expectedText: string;
  expectedCursor: { line: number; col: number };
  expectedRegister: string;
  multiLine?: boolean;
  before?: (editor: ReturnType<typeof createEditorWithSpy>["editor"]) => void;
}): void {
  const {
    initial,
    keys,
    expectedText,
    expectedCursor,
    expectedRegister,
    multiLine = false,
    before,
  } = options;
  const { editor } = multiLine
    ? createMultiLineEditor(initial)
    : createEditorWithSpy(initial);

  before?.(editor);
  sendKeys(editor, keys);

  assert.equal(editor.getText(), expectedText, `text after [${keys.join("")}]`);
  assert.deepEqual(editor.getCursor(), expectedCursor, `cursor after [${keys.join("")}]`);
  assert.equal(editor.getRegister(), expectedRegister, `register after [${keys.join("")}]`);

  sendKeys(editor, ["u", "\x12"]);

  assert.equal(editor.getText(), expectedText, `redo text after [${keys.join("")}]`);
  assert.deepEqual(editor.getCursor(), expectedCursor, `redo cursor after [${keys.join("")}]`);
  assert.equal(editor.getRegister(), expectedRegister, `redo register after [${keys.join("")}]`);
}

function makeGeneratedLineFixtures(count: number): string[] {
  let seed = 0x51f15eed;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };

  const words = ["alpha", "beta_2", "GAMMA", "z9", "m_n"];
  const punct = ["-", "--", "::", ".", ",", "!?", "#"];
  const spaces = [" ", "  ", "   ", "\t"];
  const fixtures = ["", "   ", "---", "a", "a   b", "foo--bar"];

  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const partCount = 1 + (next() % 6);

    for (let part = 0; part < partCount; part++) {
      const bucket = next() % 5;
      if (bucket <= 1) {
        parts.push(words[next() % words.length]!);
      } else if (bucket === 2) {
        parts.push(punct[next() % punct.length]!);
      } else {
        parts.push(spaces[next() % spaces.length]!);
      }
    }

    fixtures.push(parts.join(""));
  }

  return fixtures;
}

function runScenario(
  initial: string,
  keys: string[],
  mode: "fast" | "canonical",
): {
  text: string;
  register: string;
  editorMode: "normal" | "insert";
  cursorLine: number;
  cursorCol: number;
} {
  const { editor } = initial.includes("\n")
    ? createMultiLineEditor(initial)
    : createEditorWithSpy(initial);

  if (mode === "canonical") {
    (editor as any).tryFindWordTargetLineLocal = () => null;
  }

  sendKeys(editor, keys);

  const cursor = editor.getCursor();

  return {
    text: editor.getText(),
    register: editor.getRegister(),
    editorMode: editor.getMode(),
    cursorLine: cursor.line,
    cursorCol: cursor.col,
  };
}

function createEditorAtBufferEnd(text: string): ModalEditor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);

  for (const char of text) {
    editor.handleInput(char);
  }

  editor.handleInput("\x1b");

  return editor;
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------

describe("mode transitions", () => {
  it("escape enters normal mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["i"]);
    assert.equal(editor.getMode(), "insert");
    sendKeys(editor, ["\x1b"]);
    assert.equal(editor.getMode(), "normal");
  });

  it("kitty ctrl+[ enters normal mode like escape", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["i"]);
    assert.equal(editor.getMode(), "insert");
    sendKeys(editor, ["\x1b[91;5u"]);
    assert.equal(editor.getMode(), "normal");
  });

  it("i enters insert mode from normal", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["i"]);
    assert.equal(editor.getMode(), "insert");
  });

  it("escape in normal mode stays in normal (passes raw esc upward)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["\x1b"]);
    assert.equal(editor.getMode(), "normal");
  });

  it("kitty ctrl+[ in normal mode forwards escape upward", () => {
    const { editor } = createEditorWithSpy("hello");

    const customEditorProto = Object.getPrototypeOf(Object.getPrototypeOf(editor));
    const originalHandleInput = customEditorProto.handleInput;
    let forwardedEscapeCount = 0;

    customEditorProto.handleInput = function (this: unknown, data: string): unknown {
      if (data === "\x1b") forwardedEscapeCount++;
      return originalHandleInput.call(this, data);
    };

    try {
      sendKeys(editor, ["\x1b[91;5u"]);
      assert.equal(editor.getMode(), "normal");
      assert.equal(forwardedEscapeCount, 1);
    } finally {
      customEditorProto.handleInput = originalHandleInput;
    }
  });

  it("a at EOL on non-last line appends on same line", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$", "a", "X"]);
    assert.equal(editor.getText(), "fooX\nbar");
    assert.equal(editor.getMode(), "insert");
  });

  it("normal mode ignores printable unicode input", () => {
    const { editor } = createEditorWithSpy("abc");
    sendKeys(editor, ["😀"]);
    assert.equal(editor.getText(), "abc");
    assert.equal(editor.getMode(), "normal");
  });

  it("normal mode ignores pasted printable chunks", () => {
    const { editor } = createEditorWithSpy("abc");
    sendKeys(editor, ["xyz"]);
    assert.equal(editor.getText(), "abc");
    assert.equal(editor.getMode(), "normal");
  });

  it("normal mode does not treat prototype keys as mappings", () => {
    const { editor } = createEditorWithSpy("abc");

    assert.doesNotThrow(() => sendKeys(editor, ["toString"]));
    assert.equal(editor.getText(), "abc");
    assert.equal(editor.getMode(), "normal");
  });

  it("normal mode ignores bracketed paste payload", () => {
    const { editor } = createEditorWithSpy("abc");
    sendKeys(editor, ["\x1b[200~PASTE\x1b[201~"]);
    assert.equal(editor.getText(), "abc");
    assert.equal(editor.getMode(), "normal");
  });

  it("insert mode keeps bracketed paste payload text", () => {
    const { editor } = createEditorWithSpy("abc");
    sendKeys(editor, ["i", "\x1b[200~PASTE\x1b[201~"]);
    assert.equal(editor.getText(), "PASTEabc");
    assert.equal(editor.getMode(), "insert");
  });

  it("escape from insert clears unterminated bracketed paste state", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["i", "\x1b[200~", "\x1b", "l", "x"]);

    assert.equal(editor.getMode(), "normal");
    assert.equal(editor.getText(), "ac");
    assert.equal(editor.getRegister(), "b");
  });

  it("I enters insert at first non-whitespace char", () => {
    const { editor } = createMultiLineEditor("   hello");
    // move to end of line
    sendKeys(editor, ["$"]);
    // I should go to first non-ws (col 3)
    sendKeys(editor, ["I"]);
    assert.strictEqual(editor.getMode(), "insert");
    assert.strictEqual(editor.getCursor().col, 3);
  });

  it("I on line with no leading whitespace goes to col 0", () => {
    const { editor } = createMultiLineEditor("hello");
    sendKeys(editor, ["$"]);
    sendKeys(editor, ["I"]);
    assert.strictEqual(editor.getMode(), "insert");
    assert.strictEqual(editor.getCursor().col, 0);
  });
});

// ---------------------------------------------------------------------------
// Delete (d) operator — 6 motions
// ---------------------------------------------------------------------------

describe("delete operator — dw / de / db / d$ / d0 / dd", () => {
  it("dw deletes forward word (exclusive), updates register", () => {
    chk("hello world", ["d", "w"], "world", "hello ");
  });

  it("dw clipboard receives deleted text", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo bar");
    sendKeys(editor, ["d", "w"]);
    assert.deepEqual(clipboardWrites, ["foo "]);
  });

  it("dw swallows async clipboard failures", async () => {
    const { editor } = createEditorWithSpy("foo bar");
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      rejections.push(reason);
    };

    editor.setClipboardFn(async () => {
      throw new Error("clipboard boom");
    });

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      sendKeys(editor, ["d", "w"]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    assert.equal(editor.getText(), "bar");
    assert.equal(editor.getRegister(), "foo ");
    assert.deepEqual(rejections, []);
  });

  it("de deletes to end of word (inclusive), updates register", () => {
    // "hello world" col 0: e→col 4 inclusive → delete "hello", leave " world"
    chk("hello world", ["d", "e"], " world", "hello");
  });

  it("de inclusive equal-column: single-char word", () => {
    // "a" col 0: e→col 0 inclusive → delete "a", leave ""
    chk("a", ["d", "e"], "", "a");
  });

  it("de inclusive equal-column: last char of multi-char word", () => {
    // "abc" col 2 (press l l): e→col 2 inclusive → delete "c", leave "ab"
    chk("abc", ["l", "l", "d", "e"], "ab", "c");
  });

  it("db deletes backward word (exclusive)", () => {
    // navigate w to col 4 ('b' of "bar"), then db → delete "foo "
    chk("foo bar", ["w", "d", "b"], "bar", "foo ");
  });

  it("d$ deletes to end of line (exclusive of EOL)", () => {
    chk("hello world", ["d", "$"], "", "hello world");
  });

  it("d0 deletes back to start of line (exclusive of col 0)", () => {
    // navigate w to col 4, then d0 → delete "foo " (cols 0–3)
    chk("foo bar", ["w", "d", "0"], "bar", "foo ");
  });

  it("dd deletes linewise and writes newline-terminated register", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["d", "d"]);
    assert.equal(editor.getRegister(), "hello\n");
    assert.equal(editor.getText(), "");
  });
});

describe("delete operator — WORD motions (dW / dE / dB)", () => {
  it("dW deletes to next WORD start", () => {
    chk("foo-bar   baz", ["d", "W"], "baz", "foo-bar   ");
  });

  it("dE deletes to end of current WORD (inclusive)", () => {
    chk("foo-bar   baz", ["d", "E"], "   baz", "foo-bar");
  });

  it("dB deletes backward by WORD", () => {
    chk("foo-bar baz", ["W", "d", "B"], "baz", "foo-bar ");
  });
});

// ---------------------------------------------------------------------------
// Linewise operators, counts, and whole-buffer flows
// ---------------------------------------------------------------------------

describe("linewise operators and counts", () => {
  it("d2j deletes current line plus two below", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");

    sendKeys(editor, ["d", "2", "j"]);

    assert.equal(editor.getText(), "d");
    assert.equal(editor.getRegister(), "a\nb\nc\n");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("y2j yanks current line plus two below without mutation", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");
    const before = editor.getText();

    sendKeys(editor, ["y", "2", "j"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "a\nb\nc\n");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("3dd deletes three lines", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");

    sendKeys(editor, ["3", "d", "d"]);

    assert.equal(editor.getText(), "d");
    assert.equal(editor.getRegister(), "a\nb\nc\n");
  });

  it("2yy yanks two lines", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");
    const before = editor.getText();

    sendKeys(editor, ["j", "2", "y", "y"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "b\nc\n");
  });

  it("d999j clamps deletion at EOF", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");

    sendKeys(editor, ["d", "9", "9", "9", "j"]);

    assert.equal(editor.getText(), "");
    assert.equal(editor.getRegister(), "a\nb\nc\n");
  });

  it("y999k clamps yank at BOF", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");
    const before = editor.getText();

    sendKeys(editor, ["G", "y", "9", "9", "9", "k"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "a\nb\nc\n");
  });

  it("ggdG deletes the whole buffer", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");

    sendKeys(editor, ["g", "g", "d", "G"]);

    assert.equal(editor.getText(), "");
    assert.equal(editor.getRegister(), "a\nb\nc\n");
  });

  it("ggyG yanks the whole buffer without mutation", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");
    const before = editor.getText();

    sendKeys(editor, ["g", "g", "y", "G"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "a\nb\nc\n");
  });

  it("dG from middle line deletes to EOF linewise", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");

    sendKeys(editor, ["j", "d", "G"]);

    assert.equal(editor.getText(), "a");
    assert.equal(editor.getRegister(), "b\nc\nd\n");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("invalid continuation after counted delete cancels cleanly", () => {
    const { editor } = createMultiLineEditor("foo bar\nbaz");

    sendKeys(editor, ["d", "2", "z", "w", "x"]);

    assert.equal(editor.getText(), "foo ar\nbaz");
    assert.equal(editor.getRegister(), "b");
  });

  it("counted delete motion d2w deletes two words", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["d", "2", "w"]);

    assert.equal(editor.getText(), "baz");
    assert.equal(editor.getRegister(), "foo bar ");
  });

  it("counted delete motion d2W deletes two WORDs", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz qux");

    sendKeys(editor, ["d", "2", "W"]);

    assert.equal(editor.getText(), "qux");
    assert.equal(editor.getRegister(), "foo-bar   baz ");
  });

  it("counted prefix 2dW deletes two WORDs", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz qux");

    sendKeys(editor, ["2", "d", "W"]);

    assert.equal(editor.getText(), "qux");
    assert.equal(editor.getRegister(), "foo-bar   baz ");
  });

  it("counted change motion c2E works for WORD semantics", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz qux");

    sendKeys(editor, ["c", "2", "E"]);

    assert.equal(editor.getText(), " qux");
    assert.equal(editor.getRegister(), "foo-bar   baz");
    assert.equal(editor.getMode(), "insert");
  });

  it("counted change motion c2B works for WORD semantics", () => {
    const { editor } = createEditorWithSpy("one two three");

    sendKeys(editor, ["W", "W", "c", "2", "B"]);

    assert.equal(editor.getText(), "three");
    assert.equal(editor.getRegister(), "one two ");
    assert.equal(editor.getMode(), "insert");
  });

  it("counted prefix 2cB changes backward across two WORDs", () => {
    const { editor } = createEditorWithSpy("one two three");

    sendKeys(editor, ["W", "W", "2", "c", "B"]);

    assert.equal(editor.getText(), "three");
    assert.equal(editor.getRegister(), "one two ");
    assert.equal(editor.getMode(), "insert");
  });

  it("counted unsupported yank motion y2w cancels instead of yanking", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["y", "2", "w"]);

    assert.equal(editor.getText(), "foo bar");
    assert.equal(editor.getRegister(), "");
  });

  it("counted unsupported yank motion y2W cancels instead of yanking", () => {
    const { editor } = createEditorWithSpy("foo-bar baz");

    sendKeys(editor, ["y", "2", "W"]);

    assert.equal(editor.getText(), "foo-bar baz");
    assert.equal(editor.getRegister(), "");
  });

  it("counted unsupported yank motion y2E cancels and does not stay sticky", () => {
    const { editor } = createEditorWithSpy("foo-bar baz");

    sendKeys(editor, ["y", "2", "E", "x"]);

    assert.equal(editor.getText(), "oo-bar baz");
    assert.equal(editor.getRegister(), "f");
  });

  it("2d0 does not swallow 0 as a second count", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["2", "d", "0", "x"]);

    assert.equal(editor.getText(), "oo bar");
    assert.equal(editor.getRegister(), "f");
  });
});

describe("Universal Counts State & Bounds", () => {
  it("2d3j multiplies prefix and operator counts", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd\ne\nf\ng\nh");

    sendKeys(editor, ["2", "d", "3", "j"]);

    assert.equal(editor.getText(), "g\nh");
  });

  it("99999x is bounded and deletes only available text", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["9", "9", "9", "9", "9", "x"]);

    assert.equal(editor.getText(), "");
  });

  it("2d3<Esc>x clears pending count/operator state", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["2", "d", "3", "\x1b", "x"]);

    assert.equal(editor.getText(), "bc");
  });

  it("bracketed paste in normal mode clears state and keeps x working", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["2", "d", "\x1b[200~paste\x1b[201~", "x"]);

    assert.equal(editor.getText(), "bc");
  });
});

describe("buffer motions — gg / G", () => {
  it("gg from the last line reaches line 0", () => {
    const editor = createEditorAtBufferEnd("alpha\nbeta\ngamma");

    sendKeys(editor, ["g", "g"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("G from the first line reaches the last line", () => {
    const { editor } = createMultiLineEditor("alpha\nbeta\ngamma");

    sendKeys(editor, ["G"]);

    assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
  });

  it("G moves to last line at column 0", () => {
    const { editor } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["G", "x"]);

    assert.equal(editor.getText(), "foo\nar");
    assert.equal(editor.getRegister(), "b");
  });

  it("gg moves to first line at column 0", () => {
    const { editor } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["G", "g", "g", "x"]);

    assert.equal(editor.getText(), "oo\nbar");
    assert.equal(editor.getRegister(), "f");
  });

  it("gg reaches line 0 across wrapped logical lines", () => {
    const wrappedLine = "x".repeat(200);
    const editor = createEditorAtBufferEnd(
      `top\n${wrappedLine}\nbottom`,
    );

    sendKeys(editor, ["g", "g"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("{count}gg moves to target line (1-indexed)", () => {
    const { editor } = createMultiLineEditor("aa\nbb\ncc\ndd");

    sendKeys(editor, ["G", "2", "g", "g", "x"]);

    assert.equal(editor.getText(), "aa\nb\ncc\ndd");
    assert.equal(editor.getRegister(), "b");
  });

  it("3gg moves to line 2 (0-indexed)", () => {
    const editor = createEditorAtBufferEnd("aa\nbb\ncc\ndd");

    sendKeys(editor, ["3", "g", "g"]);

    assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
  });

  it("{count}G moves to target line (1-indexed)", () => {
    const { editor } = createMultiLineEditor("aa\nbb\ncc\ndd");

    sendKeys(editor, ["3", "G", "x"]);

    assert.equal(editor.getText(), "aa\nbb\nc\ndd");
    assert.equal(editor.getRegister(), "c");
  });
});

describe("first non-whitespace motion — ^", () => {
  it("^ moves to the first non-whitespace character", () => {
    const { editor } = createEditorWithSpy("    foo");

    sendKeys(editor, ["$", "^", "x"]);

    assert.equal(editor.getText(), "    oo");
    assert.equal(editor.getRegister(), "f");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("prefixed ^ clears count state before later commands", () => {
    const { editor } = createEditorWithSpy("    foo bar");

    sendKeys(editor, ["3", "^", "x"]);

    assert.equal(editor.getText(), "    oo bar");
    assert.equal(editor.getRegister(), "f");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("d^ deletes back to the first non-whitespace character", () => {
    chk("    foo bar", ["w", "w", "d", "^"], "    bar", "foo ");
  });

  it("c^ changes back to the first non-whitespace character", () => {
    const { editor } = createEditorWithSpy("    foo bar");

    sendKeys(editor, ["w", "w", "c", "^"]);

    assert.equal(editor.getText(), "    bar");
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getMode(), "insert");
  });

  it("y^ yanks back to the first non-whitespace character", () => {
    const { editor } = createEditorWithSpy("    foo bar");
    const before = editor.getText();

    sendKeys(editor, ["w", "w", "y", "^"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "foo ");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 8 });
  });
});

describe("paragraph motions — { / }", () => {
  const paragraphFixture = "alpha one\nalpha two\n\n   \nbeta one\nbeta two\n\ngamma one\n\n   ";

  it("} moves to next paragraph start at column 0", () => {
    const { editor } = createMultiLineEditor(paragraphFixture);

    sendKeys(editor, ["}"]);

    assert.deepEqual(editor.getCursor(), { line: 4, col: 0 });
  });

  it("{ moves to previous paragraph start at column 0", () => {
    const { editor } = createMultiLineEditor(paragraphFixture);

    sendKeys(editor, ["}", "{"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("paragraph motions from blank-line runs jump to surrounding paragraph starts", () => {
    const { editor } = createMultiLineEditor(paragraphFixture);

    sendKeys(editor, ["j", "j", "}"]);
    assert.deepEqual(editor.getCursor(), { line: 4, col: 0 });

    sendKeys(editor, ["j", "j", "{"]);
    assert.deepEqual(editor.getCursor(), { line: 4, col: 0 });
  });

  it("supports counted paragraph motions 2} and 2{", () => {
    const { editor } = createMultiLineEditor(paragraphFixture);

    sendKeys(editor, ["2", "}"]);
    assert.deepEqual(editor.getCursor(), { line: 7, col: 0 });

    sendKeys(editor, ["2", "{"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("paragraph motions clamp at BOF/EOF", () => {
    const { editor } = createMultiLineEditor(paragraphFixture);

    sendKeys(editor, ["{"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

    sendKeys(editor, ["G", "}"]);
    assert.deepEqual(editor.getCursor(), { line: 9, col: 0 });
  });

  it("paragraph motions keep register/clipboard unchanged", () => {
    const { editor, clipboardWrites } = createMultiLineEditor(paragraphFixture);
    const before = editor.getText();
    editor.setRegister("untouched");

    sendKeys(editor, ["}", "{", "2", "}", "2", "{"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "untouched");
    assert.deepEqual(clipboardWrites, []);
  });

  it("paragraph integration keeps representative w/b/e behavior", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["w"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });

    sendKeys(editor, ["e"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });

    sendKeys(editor, ["b"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });
});

describe("J — join lines", () => {
  it("J joins current line with next, inserts separator space", () => {
    const { editor } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["J"]);

    assert.equal(editor.getText(), "foo bar");
  });

  it("J on last line is a no-op", () => {
    const { editor } = createEditorWithSpy("only line");

    sendKeys(editor, ["J"]);

    assert.equal(editor.getText(), "only line");
  });

  it("J preserves left trailing whitespace, no double space", () => {
    const { editor } = createMultiLineEditor("foo  \nbar");

    sendKeys(editor, ["J"]);

    assert.equal(editor.getText(), "foo  bar");
  });

  it("J trims right leading whitespace", () => {
    const { editor } = createMultiLineEditor("foo\n  bar");

    sendKeys(editor, ["J"]);

    assert.equal(editor.getText(), "foo bar");
  });

  it("J with empty right line: no trailing space", () => {
    const { editor } = createMultiLineEditor("foo\n");

    sendKeys(editor, ["J"]);

    assert.equal(editor.getText(), "foo");
  });

  it("J cursor lands at join point (space position)", () => {
    const { editor } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["J"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("J cursor at join point when left has trailing space (no separator inserted)", () => {
    const { editor } = createMultiLineEditor("foo \nbar");

    sendKeys(editor, ["J"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("J does not write unnamed register", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    editor.setRegister("untouched");

    sendKeys(editor, ["J"]);

    assert.equal(editor.getRegister(), "untouched");
  });

  it("J does not write clipboard", () => {
    const { editor, clipboardWrites } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["J"]);

    assert.deepEqual(clipboardWrites, []);
  });

  it("J keeps the cursor at the join point after a non-ascii grapheme", () => {
    const { editor } = createMultiLineEditor("中\nx");

    sendKeys(editor, ["J"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });
});

describe("gJ — raw join lines", () => {
  it("gJ joins without whitespace normalization", () => {
    const { editor } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["g", "J"]);

    assert.equal(editor.getText(), "foobar");
  });

  it("gJ preserves right leading whitespace", () => {
    const { editor } = createMultiLineEditor("foo\n  bar");

    sendKeys(editor, ["g", "J"]);

    assert.equal(editor.getText(), "foo  bar");
  });

  it("gJ on last line is a no-op", () => {
    const { editor } = createEditorWithSpy("only line");

    sendKeys(editor, ["g", "J"]);

    assert.equal(editor.getText(), "only line");
  });

  it("gJ cursor lands at former newline boundary", () => {
    const { editor } = createMultiLineEditor("foo\nbar");

    sendKeys(editor, ["g", "J"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("gJ does not write unnamed register", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    editor.setRegister("untouched");

    sendKeys(editor, ["g", "J"]);

    assert.equal(editor.getRegister(), "untouched");
  });
});

describe("counted J/gJ", () => {
  it("3J joins three lines (2 steps)", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");

    sendKeys(editor, ["3", "J"]);

    assert.equal(editor.getText(), "a b c\nd");
  });

  it("3gJ joins three lines without normalization", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");

    sendKeys(editor, ["3", "g", "J"]);

    assert.equal(editor.getText(), "abc\nd");
  });

  it("count exceeding EOF clamps to available lines", () => {
    const { editor } = createMultiLineEditor("a\nb");

    sendKeys(editor, ["9", "J"]);

    assert.equal(editor.getText(), "a b");
  });

  it("1J is a no-op (0 steps per spec formula)", () => {
    const { editor } = createMultiLineEditor("a\nb");

    sendKeys(editor, ["1", "J"]);

    assert.equal(editor.getText(), "a\nb");
  });

  it("3J cursor at LAST join point", () => {
    const { editor } = createMultiLineEditor("aa\nbb\ncc");

    sendKeys(editor, ["3", "J"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("{count}gJ works: 2gJ joins two lines", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");

    sendKeys(editor, ["2", "g", "J"]);

    assert.equal(editor.getText(), "ab\nc");
  });
});

describe("gJ parse safety", () => {
  it("g{count}J is a no-op (fail-closed)", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");

    sendKeys(editor, ["g", "3", "J"]);

    assert.equal(editor.getText(), "a\nb\nc");
  });

  it("g{count}J does not write register", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");
    editor.setRegister("untouched");

    sendKeys(editor, ["g", "3", "J"]);

    assert.equal(editor.getRegister(), "untouched");
  });
});

// ---------------------------------------------------------------------------
// Change (c) operator — 6 motions, always enters insert mode
// ---------------------------------------------------------------------------

describe("change operator — cw / ce / cb / c$ / c0 / cc", () => {
  it("cw: text mutated, register written, insert mode", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["c", "w"]);
    assert.equal(editor.getRegister(), "hello ");
    assert.equal(editor.getText(), "world");
    assert.equal(editor.getMode(), "insert");
  });

  it("ce: inclusive delete, insert mode", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["c", "e"]);
    assert.equal(editor.getRegister(), "hello");
    assert.equal(editor.getText(), " world");
    assert.equal(editor.getMode(), "insert");
  });

  it("cb from mid-word: backward delete, insert mode", () => {
    const { editor } = createEditorWithSpy("foo bar");
    sendKeys(editor, ["w", "c", "b"]); // navigate to "bar", cb
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getText(), "bar");
    assert.equal(editor.getMode(), "insert");
  });

  it("c$: deletes to EOL, insert mode", () => {
    chkMode("hello world", ["c", "$"], "insert");
    chk("hello world", ["c", "$"], "", "hello world");
  });

  it("c0 from mid-line: deletes back to start, insert mode", () => {
    const { editor } = createEditorWithSpy("foo bar");
    sendKeys(editor, ["w", "c", "0"]);
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getText(), "bar");
    assert.equal(editor.getMode(), "insert");
  });

  it("cc: clears line, insert mode", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["c", "c"]);
    assert.equal(editor.getRegister(), "hello world");
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "insert");
  });
});

describe("change operator — WORD motions (cW / cE / cB)", () => {
  it("cW on non-whitespace matches cE (Vim parity)", () => {
    const { editor } = createEditorWithSpy("foo   bar");

    sendKeys(editor, ["c", "W"]);

    assert.equal(editor.getText(), "   bar");
    assert.equal(editor.getRegister(), "foo");
    assert.equal(editor.getMode(), "insert");
  });

  it("cW from whitespace deletes only whitespace run", () => {
    const { editor } = createEditorWithSpy("foo   bar");

    sendKeys(editor, ["l", "l", "l", "c", "W"]);

    assert.equal(editor.getText(), "foobar");
    assert.equal(editor.getRegister(), "   ");
    assert.equal(editor.getMode(), "insert");
  });

  it("cE deletes to end of WORD inclusively", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz");

    sendKeys(editor, ["c", "E"]);

    assert.equal(editor.getText(), "   baz");
    assert.equal(editor.getRegister(), "foo-bar");
    assert.equal(editor.getMode(), "insert");
  });

  it("cB deletes backward by WORD", () => {
    const { editor } = createEditorWithSpy("foo-bar baz");

    sendKeys(editor, ["W", "c", "B"]);

    assert.equal(editor.getText(), "baz");
    assert.equal(editor.getRegister(), "foo-bar ");
    assert.equal(editor.getMode(), "insert");
  });
});

// ---------------------------------------------------------------------------
// Word text objects — iw / aw with d/c/y
// ---------------------------------------------------------------------------

describe("word text objects — iw / aw", () => {
  it("ciw deletes inner word and enters insert mode", () => {
    const { editor } = createEditorWithSpy("foo bar");
    sendKeys(editor, ["c", "i", "w"]);
    assert.equal(editor.getRegister(), "foo");
    assert.equal(editor.getText(), " bar");
    assert.equal(editor.getMode(), "insert");
  });

  it("caw deletes word plus trailing space and enters insert mode", () => {
    const { editor } = createEditorWithSpy("foo bar");
    sendKeys(editor, ["c", "a", "w"]);
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getText(), "bar");
    assert.equal(editor.getMode(), "insert");
  });

  it("diw deletes inner word", () => {
    chk("foo bar", ["d", "i", "w"], " bar", "foo");
  });

  it("daw deletes word + trailing spaces", () => {
    chk("foo bar", ["d", "a", "w"], "bar", "foo ");
  });

  it("yiw yanks inner word without mutation", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();
    sendKeys(editor, ["y", "i", "w"]);
    assert.equal(editor.getRegister(), "foo");
    assert.equal(editor.getText(), before);
  });

  it("yaw yanks word + trailing spaces without mutation", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();
    sendKeys(editor, ["y", "a", "w"]);
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getText(), before);
  });
});

// ---------------------------------------------------------------------------
// Single-key edit commands — x / s / S / D / C
// ---------------------------------------------------------------------------

describe("single-key edits — x / s / S / D / C", () => {
  it("x: deletes char under cursor, normal mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x"]);
    assert.equal(editor.getRegister(), "h");
    assert.equal(editor.getText(), "ello");
    assert.equal(editor.getMode(), "normal");
  });

  it("x: register written correctly", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("hello");
    sendKeys(editor, ["x"]);
    assert.deepEqual(clipboardWrites, ["h"]);
  });

  it("s: deletes char under cursor, enters insert mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["s"]);
    assert.equal(editor.getRegister(), "h");
    assert.equal(editor.getText(), "ello");
    assert.equal(editor.getMode(), "insert");
  });

  it("S: clears line content, enters insert mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["S"]);
    assert.equal(editor.getRegister(), "hello");
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "insert");
  });

  it("D: deletes from cursor to end of line", () => {
    chk("hello world", ["D"], "", "hello world");
  });

  it("D from mid-line: deletes only tail", () => {
    // navigate to col 5 (' '), D should delete " world"
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["w", "D"]); // w moves to "world" (col 6), D deletes from there
    assert.equal(editor.getRegister(), "world");
    assert.equal(editor.getText(), "hello ");
  });

  it("C: deletes to EOL, enters insert mode", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["C"]);
    assert.equal(editor.getRegister(), "hello world");
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "insert");
  });
});

describe("Universal Counts: Edits and Put", () => {
  it("3x deletes three chars under cursor", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["3", "x"]);

    assert.equal(editor.getText(), "def");
    assert.equal(editor.getRegister(), "abc");
  });

  it("2x near EOL deletes only available chars", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["l", "l", "l", "l", "2", "x"]);

    assert.equal(editor.getText(), "abcd");
    assert.equal(editor.getRegister(), "ef");
  });

  it("3p pastes register text three times after cursor", () => {
    const { editor } = createEditorWithSpy("X");
    editor.setRegister("ab");

    sendKeys(editor, ["3", "p"]);

    assert.equal(editor.getText(), "Xababab");
  });

  it("3P pastes register text three times before cursor", () => {
    const { editor } = createEditorWithSpy("X");
    editor.setRegister("ab");

    sendKeys(editor, ["3", "P"]);

    assert.equal(editor.getText(), "abababX");
  });

  it("2s deletes two chars and enters insert mode", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["2", "s"]);

    assert.equal(editor.getText(), "cdef");
    assert.equal(editor.getRegister(), "ab");
    assert.equal(editor.getMode(), "insert");
  });

  it("2S clears line once and enters insert mode", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["2", "S"]);

    assert.equal(editor.getText(), "");
    assert.equal(editor.getRegister(), "abcdef");
    assert.equal(editor.getMode(), "insert");
  });

  it("2D deletes to EOL once", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["2", "D"]);

    assert.equal(editor.getText(), "");
    assert.equal(editor.getRegister(), "abcdef");
  });

  it("2C deletes to EOL and enters insert mode", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["2", "C"]);

    assert.equal(editor.getText(), "");
    assert.equal(editor.getRegister(), "abcdef");
    assert.equal(editor.getMode(), "insert");
  });
});

describe("Universal Counts: Char Motions", () => {
  it("3fx moves to the third forward match", () => {
    const { editor } = createEditorWithSpy("axbxcxd");

    sendKeys(editor, ["3", "f", "x"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("3Fx moves to the third backward match", () => {
    const { editor } = createEditorWithSpy("dxcxbxa");

    sendKeys(editor, ["$", "3", "F", "x"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("3tx moves to one before the third forward match", () => {
    const { editor } = createEditorWithSpy("axbxcxd");

    sendKeys(editor, ["3", "t", "x"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("d2tx deletes through the char before the second forward match", () => {
    const { editor } = createEditorWithSpy("axbxcxd");

    sendKeys(editor, ["d", "2", "t", "x"]);

    assert.equal(editor.getText(), "xcxd");
    assert.equal(editor.getRegister(), "axb");
  });

  it("3TX moves backward one before the third backward match", () => {
    const { editor } = createEditorWithSpy("dxcxbxa");

    sendKeys(editor, ["$", "3", "T", "x"]);

    // 3rd x from right is at col 1, T stops one after = col 2
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("2; repeats the last char-find motion twice", () => {
    const { editor } = createEditorWithSpy("axbxcxd");

    sendKeys(editor, ["f", "x", "2", ";"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });
});

describe("Universal Counts: Word Motions", () => {
  it("3w moves to the start of qux (3 word-forward steps)", () => {
    const { editor } = createEditorWithSpy("foo bar baz qux");

    sendKeys(editor, ["3", "w"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 12 });
  });

  it("2b from baz moves to the start of foo", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["w", "w", "2", "b"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("2e from start lands at end of bar", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["2", "e"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
  });

  it("WORD standalone motions W/B/E use whitespace-delimited semantics", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz");

    sendKeys(editor, ["W"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });

    sendKeys(editor, ["B"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

    sendKeys(editor, ["E"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
  });

  it("2W moves by WORD tokens (counted standalone)", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz qux");

    sendKeys(editor, ["2", "W"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 14 });
  });

  it("3B from EOL walks backward across WORD tokens", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz qux");

    sendKeys(editor, ["$", "3", "B"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("2E lands on end of second WORD token", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz qux");

    sendKeys(editor, ["2", "E"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 12 });
  });

  it("lowercase w keeps word-class behavior next to punctuation", () => {
    const { editor: lowercase } = createEditorWithSpy("foo-bar baz");
    const { editor: uppercase } = createEditorWithSpy("foo-bar baz");

    sendKeys(lowercase, ["w"]);
    sendKeys(uppercase, ["W"]);

    assert.deepEqual(lowercase.getCursor(), { line: 0, col: 3 });
    assert.deepEqual(uppercase.getCursor(), { line: 0, col: 8 });
  });

  it("d2w deletes foo bar and leaves baz", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["d", "2", "w"]);

    assert.equal(editor.getText(), "baz");
  });

  it("d2aw deletes two words from bar and leaves foo", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["w", "d", "2", "a", "w"]);

    assert.equal(editor.getText(), "foo");
  });

  it("maintains differential parity with count > 1 (3w matches three sequential w)", () => {
    const { editor: e1 } = createEditorWithSpy("foo bar baz qux");
    const { editor: e2 } = createEditorWithSpy("foo bar baz qux");

    sendKeys(e1, ["3", "w"]);
    sendKeys(e2, ["w", "w", "w"]);

    assert.deepEqual(e1.getCursor(), e2.getCursor());
  });

  it("w skips correctly after a non-ascii grapheme", () => {
    const { editor } = createEditorWithSpy("中 x");

    sendKeys(editor, ["l", "w"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("w skips correctly after an emoji grapheme", () => {
    const { editor } = createEditorWithSpy("😀 x");

    sendKeys(editor, ["l", "w"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });
});

describe("Universal Counts: Change and Nav", () => {
  it("c2w deletes two words and enters insert mode", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["c", "2", "w"]);

    assert.equal(editor.getText(), "baz");
    assert.equal(editor.getMode(), "insert");
  });

  it("3j moves cursor down three lines", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd\ne");

    sendKeys(editor, ["3", "j"]);

    assert.deepEqual(editor.getCursor(), { line: 3, col: 0 });
  });

  it("3l moves cursor right by three columns", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["3", "l"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("3h moves cursor left by three columns", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["$", "h", "3", "h"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("3k moves cursor up three lines", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd\ne");

    sendKeys(editor, ["G", "3", "k"]);

    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  });

  it("j moves by logical lines across wrapped content", () => {
    const wrappedLine = "x".repeat(200);
    const { editor } = createMultiLineEditor(`top\n${wrappedLine}\nbottom`);

    sendKeys(editor, ["j", "j"]);

    assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
  });
});

// ---------------------------------------------------------------------------
// EOL / newline edge cases  (Task 7)
// ---------------------------------------------------------------------------

describe("EOL and newline semantics", () => {
  it("D at EOL captures '\\n' in register when next line exists", () => {
    const { editor, clipboardWrites } = createMultiLineEditor("line1\nline2");
    // cursor at col 0 of line 0; go to EOL
    sendKeys(editor, ["$"]); // CTRL_E → col past last char (col 5 for "line1")
    sendKeys(editor, ["D"]);
    assert.equal(editor.getRegister(), "\n");
    assert.deepEqual(clipboardWrites, ["\n"]);
    // CTRL_K at EOL joins the two lines
    assert.equal(editor.getText(), "line1line2");
  });

  it("d$ at EOL matches D behavior (captures newline and joins lines)", () => {
    const { editor, clipboardWrites } = createMultiLineEditor("line1\nline2");
    sendKeys(editor, ["$", "d", "$"]);

    assert.equal(editor.getRegister(), "\n");
    assert.deepEqual(clipboardWrites, ["\n"]);
    assert.equal(editor.getText(), "line1line2");
  });

  it("D at EOL on last line is a no-op (register stays empty)", () => {
    const { editor } = createEditorWithSpy("hello");
    // cursor col 0, go to EOL
    sendKeys(editor, ["$"]);
    sendKeys(editor, ["D"]);
    // col >= line.length AND no next line → deleted = "" → no-op (register empty)
    assert.equal(editor.getRegister(), "");
    assert.equal(editor.getText(), "hello");
  });

  it("x at past-EOL position is a no-op (does not join next line)", () => {
    const { editor } = createMultiLineEditor("line1\nline2");
    sendKeys(editor, ["$"]); // move to col 5 (past end of "line1")
    const before = editor.getText();
    sendKeys(editor, ["x"]);
    assert.equal(editor.getText(), before); // text unchanged
    assert.equal(editor.getRegister(), ""); // nothing captured
  });

  it("x on last char of line deletes only that char, does not join lines", () => {
    const { editor } = createMultiLineEditor("line1\nline2");
    // "e" motion: end of word in "line1" → col 4 ('1')
    sendKeys(editor, ["e", "x"]);
    assert.equal(editor.getRegister(), "1");
    assert.equal(editor.getText(), "line\nline2"); // only '1' gone, newline intact
  });
});

// ---------------------------------------------------------------------------
// Word motion path selection (line-local fast path vs canonical fallback)
// ---------------------------------------------------------------------------

describe("word motion path selection", () => {
  it("line-local w avoids canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["w"]);
    assert.equal(calls, 0);
  });

  it("line-local e avoids canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["e"]);
    assert.equal(calls, 0);
  });

  it("line-local b avoids canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");
    sendKeys(editor, ["w"]);

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["b"]);
    assert.equal(calls, 0);
  });

  it("line-local W/E/B thread WORD semantic class through cache lookup", () => {
    const scenarios: Array<{ motion: string; setup?: string[] }> = [
      { motion: "W" },
      { motion: "E" },
      { motion: "B", setup: ["W"] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy("foo-bar baz");
      const raw = editor as any;
      const original = raw.wordBoundaryCache.tryFindTarget.bind(raw.wordBoundaryCache);
      let seenSemanticClass: string | null = null;

      raw.wordBoundaryCache.tryFindTarget = (...args: unknown[]) => {
        seenSemanticClass = String(args[4] ?? "");
        return original(...args);
      };

      if (scenario.setup) {
        sendKeys(editor, scenario.setup);
      }
      sendKeys(editor, [scenario.motion]);
      assert.equal(seenSemanticClass, "WORD", `${scenario.motion} should use WORD class`);
    }
  });

  it("cache uncertainty falls back to canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    raw.wordBoundaryCache.tryFindTarget = () => null;

    sendKeys(editor, ["w"]);
    assert.ok(calls > 0);
  });

  it("w at EOL falls back to canonical absolute scanner", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$"]);

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["w"]);
    assert.ok(calls > 0);
  });

  it("e at EOL falls back to canonical absolute scanner", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$"]);

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["e"]);
    assert.ok(calls > 0);
  });

  it("b from BOL falls back to canonical absolute scanner", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["j", "0"]);

    const raw = editor as any;
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["b"]);
    assert.ok(calls > 0);
  });

  it("W/E at EOL and B at BOL fall back to canonical absolute scanner", () => {
    const scenarios: Array<{ name: string; initial: string; setup: string[]; motion: string }> = [
      { name: "W@EOL", initial: "foo\nbar", setup: ["$"], motion: "W" },
      { name: "E@EOL", initial: "foo\nbar", setup: ["$"], motion: "E" },
      { name: "B@BOL", initial: "foo\nbar", setup: ["j", "0"], motion: "B" },
    ];

    for (const scenario of scenarios) {
      const { editor } = createMultiLineEditor(scenario.initial);
      const raw = editor as any;
      const original = raw.findWordTargetInText.bind(raw);
      let calls = 0;

      raw.findWordTargetInText = (...args: unknown[]) => {
        calls++;
        return original(...args);
      };

      sendKeys(editor, [...scenario.setup, scenario.motion]);
      assert.ok(calls > 0, `${scenario.name} should fall back`);
    }
  });
});

// ---------------------------------------------------------------------------
// Operator word-motion path selection
// ---------------------------------------------------------------------------

describe("operator word-motion path selection", () => {
  it("line-local d/c/y + w/e/b avoid canonical absolute scanner", () => {
    const scenarios: Array<{ name: string; initial: string; keys: string[] }> = [
      { name: "dw", initial: "alpha beta", keys: ["d", "w"] },
      { name: "de", initial: "alpha beta", keys: ["d", "e"] },
      { name: "db", initial: "alpha beta", keys: ["w", "d", "b"] },
      { name: "cw", initial: "alpha beta", keys: ["c", "w"] },
      { name: "ce", initial: "alpha beta", keys: ["c", "e"] },
      { name: "cb", initial: "alpha beta", keys: ["w", "c", "b"] },
      { name: "yw", initial: "alpha beta", keys: ["y", "w"] },
      { name: "ye", initial: "alpha beta", keys: ["y", "e"] },
      { name: "yb", initial: "alpha beta", keys: ["w", "y", "b"] },
      { name: "dW", initial: "alpha-beta gamma", keys: ["d", "W"] },
      { name: "dE", initial: "alpha-beta gamma", keys: ["d", "E"] },
      { name: "dB", initial: "alpha-beta gamma", keys: ["W", "d", "B"] },
      { name: "cW", initial: "alpha-beta gamma", keys: ["c", "W"] },
      { name: "cE", initial: "alpha-beta gamma", keys: ["c", "E"] },
      { name: "cB", initial: "alpha-beta gamma", keys: ["W", "c", "B"] },
      { name: "yW", initial: "alpha-beta gamma", keys: ["y", "W"] },
      { name: "yE", initial: "alpha-beta gamma", keys: ["y", "E"] },
      { name: "yB", initial: "alpha-beta gamma", keys: ["W", "y", "B"] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);
      const raw = editor as any;
      const original = raw.findWordTargetInText.bind(raw);
      let calls = 0;

      raw.findWordTargetInText = (...args: unknown[]) => {
        calls++;
        return original(...args);
      };

      sendKeys(editor, scenario.keys);
      assert.equal(calls, 0, `${scenario.name} should stay line-local`);
    }
  });

  it("cross-line operator word motions fall back to canonical scanner", () => {
    const scenarios: Array<{ name: string; initial: string; keys: string[] }> = [
      { name: "dw@EOL", initial: "foo\nbar", keys: ["$", "d", "w"] },
      { name: "cw@EOL", initial: "foo\nbar", keys: ["$", "c", "w"] },
      { name: "yw@EOL", initial: "foo\nbar", keys: ["$", "y", "w"] },
      { name: "db@BOL", initial: "foo\nbar", keys: ["j", "0", "d", "b"] },
      { name: "cb@BOL", initial: "foo\nbar", keys: ["j", "0", "c", "b"] },
      { name: "yb@BOL", initial: "foo\nbar", keys: ["j", "0", "y", "b"] },
      { name: "dW@EOL", initial: "foo\nbar", keys: ["$", "d", "W"] },
      { name: "cW@EOL", initial: "foo\nbar", keys: ["$", "c", "W"] },
      { name: "yW@EOL", initial: "foo\nbar", keys: ["$", "y", "W"] },
      { name: "dE@EOL", initial: "foo\nbar", keys: ["$", "d", "E"] },
      { name: "cE@EOL", initial: "foo\nbar", keys: ["$", "c", "E"] },
      { name: "yE@EOL", initial: "foo\nbar", keys: ["$", "y", "E"] },
      { name: "dB@BOL", initial: "foo\nbar", keys: ["j", "0", "d", "B"] },
      { name: "cB@BOL", initial: "foo\nbar", keys: ["j", "0", "c", "B"] },
      { name: "yB@BOL", initial: "foo\nbar", keys: ["j", "0", "y", "B"] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createMultiLineEditor(scenario.initial);
      const raw = editor as any;
      const original = raw.findWordTargetInText.bind(raw);
      let calls = 0;

      raw.findWordTargetInText = (...args: unknown[]) => {
        calls++;
        return original(...args);
      };

      sendKeys(editor, scenario.keys);
      assert.ok(calls > 0, `${scenario.name} should fall back`);
    }
  });
});

describe("word-motion fast path differential", () => {
  const assertFastEqualsCanonical = (initial: string, keys: string[], label: string): void => {
    const fast = runScenario(initial, keys, "fast");
    const canonical = runScenario(initial, keys, "canonical");
    assert.deepEqual(fast, canonical, label);
  };

  it("matches canonical behavior on generated line fixtures", () => {
    const fixtures = makeGeneratedLineFixtures(80);
    const scenarios: Array<{ name: string; keys: string[] }> = [
      { name: "w+x", keys: ["w", "x"] },
      { name: "e+x", keys: ["e", "x"] },
      { name: "w,b,x", keys: ["w", "b", "x"] },
      { name: "dw", keys: ["d", "w"] },
      { name: "de", keys: ["d", "e"] },
      { name: "w,db", keys: ["w", "d", "b"] },
      { name: "cw", keys: ["c", "w"] },
      { name: "ce", keys: ["c", "e"] },
      { name: "w,cb", keys: ["w", "c", "b"] },
      { name: "yw", keys: ["y", "w"] },
      { name: "ye", keys: ["y", "e"] },
      { name: "w,yb", keys: ["w", "y", "b"] },
      { name: "W+x", keys: ["W", "x"] },
      { name: "E+x", keys: ["E", "x"] },
      { name: "W,B,x", keys: ["W", "B", "x"] },
      { name: "2W+x", keys: ["2", "W", "x"] },
      { name: "2E+x", keys: ["2", "E", "x"] },
      { name: "dW", keys: ["d", "W"] },
      { name: "dE", keys: ["d", "E"] },
      { name: "W,dB", keys: ["W", "d", "B"] },
      { name: "d2W", keys: ["d", "2", "W"] },
      { name: "2dW", keys: ["2", "d", "W"] },
      { name: "cW", keys: ["c", "W"] },
      { name: "cE", keys: ["c", "E"] },
      { name: "W,cB", keys: ["W", "c", "B"] },
      { name: "c2E", keys: ["c", "2", "E"] },
      { name: "yW", keys: ["y", "W"] },
      { name: "yE", keys: ["y", "E"] },
      { name: "W,yB", keys: ["W", "y", "B"] },
      { name: "y2W(cancel)", keys: ["y", "2", "W", "x"] },
    ];

    for (const line of fixtures) {
      for (const scenario of scenarios) {
        assertFastEqualsCanonical(
          line,
          scenario.keys,
          `line=${JSON.stringify(line)} scenario=${scenario.name}`,
        );
      }
    }
  });

  it("matches canonical behavior on cross-line uppercase WORD scenarios", () => {
    const scenarios: Array<{ name: string; initial: string; keys: string[] }> = [
      { name: "W@EOL", initial: "foo\nbar", keys: ["$", "W", "x"] },
      { name: "2W@EOL", initial: "foo\nbar baz", keys: ["$", "2", "W", "x"] },
      { name: "E@EOL", initial: "foo\nbar", keys: ["$", "E", "x"] },
      { name: "2E@EOL", initial: "foo\nbar baz", keys: ["$", "2", "E", "x"] },
      { name: "B@BOL", initial: "foo\nbar", keys: ["j", "0", "B", "x"] },
      { name: "2B@BOL", initial: "foo bar\nbaz", keys: ["j", "0", "2", "B", "x"] },
      { name: "dW@EOL", initial: "foo\nbar", keys: ["$", "d", "W"] },
      { name: "cW@EOL", initial: "foo\nbar", keys: ["$", "c", "W", "X", "\x1b"] },
      { name: "yW@EOL", initial: "foo\nbar", keys: ["$", "y", "W", "p"] },
      { name: "dE@EOL", initial: "foo\nbar", keys: ["$", "d", "E"] },
      { name: "cE@EOL", initial: "foo\nbar", keys: ["$", "c", "E", "X", "\x1b"] },
      { name: "yE@EOL", initial: "foo\nbar", keys: ["$", "y", "E", "p"] },
      { name: "dB@BOL", initial: "foo\nbar", keys: ["j", "0", "d", "B"] },
      { name: "cB@BOL", initial: "foo\nbar", keys: ["j", "0", "c", "B", "X", "\x1b"] },
      { name: "yB@BOL", initial: "foo\nbar", keys: ["j", "0", "y", "B", "p"] },
    ];

    for (const scenario of scenarios) {
      assertFastEqualsCanonical(scenario.initial, scenario.keys, scenario.name);
    }
  });
});

describe("word-motion guard boundary regressions", () => {
  const assertFastEqualsCanonical = (initial: string, keys: string[], label: string): void => {
    const fast = runScenario(initial, keys, "fast");
    const canonical = runScenario(initial, keys, "canonical");
    assert.deepEqual(fast, canonical, label);
  };

  it("matches canonical behavior at EOL/BOL + punctuation/whitespace/empty boundaries", () => {
    const cases: Array<{ label: string; initial: string; keys: string[] }> = [
      { label: "EOL cross-line dw", initial: "foo\nbar", keys: ["$", "d", "w"] },
      { label: "BOL cross-line yb", initial: "foo\nbar", keys: ["j", "0", "y", "b"] },
      { label: "EOL cross-line dW", initial: "foo\nbar", keys: ["$", "d", "W"] },
      { label: "EOL cross-line yE", initial: "foo\nbar", keys: ["$", "y", "E", "p"] },
      { label: "BOL cross-line cB", initial: "foo\nbar", keys: ["j", "0", "c", "B", "X", "\x1b"] },
      { label: "punctuation run (word)", initial: "foo---bar", keys: ["w", "x"] },
      { label: "punctuation run (WORD)", initial: "foo---bar", keys: ["W", "x"] },
      { label: "whitespace run (word)", initial: "foo     bar", keys: ["w", "x"] },
      { label: "whitespace run (WORD)", initial: "foo     bar", keys: ["W", "x"] },
      { label: "empty line (word)", initial: "", keys: ["w", "d", "w"] },
      { label: "empty line (WORD)", initial: "", keys: ["W", "d", "W"] },
      { label: "blank-middle-line W", initial: "foo\n\nbar", keys: ["$", "W", "x"] },
      { label: "blank-middle-line B", initial: "foo\n\nbar", keys: ["j", "j", "0", "B", "x"] },
      { label: "WORD punctuation + whitespace boundary", initial: "foo--bar   baz", keys: ["W", "E", "x"] },
    ];

    for (const testCase of cases) {
      assertFastEqualsCanonical(testCase.initial, testCase.keys, testCase.label);
    }
  });

  it("keeps insert-mode behavior unaffected", () => {
    assertFastEqualsCanonical("hello", ["i", "X", "Y", "\x1b", "x"], "insert mode");
  });

  it("keeps non-word command behavior unaffected", () => {
    assertFastEqualsCanonical("foo", ["x", "P", "f", "o", "x"], "non-word commands");
  });
});

// ---------------------------------------------------------------------------
// Cross-line word motions (w / e / b and operator forms)
// ---------------------------------------------------------------------------

describe("cross-line word motions", () => {
  it("w crosses EOL to next line word start", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$", "w", "x"]);
    // After w from EOL of line 1, cursor lands on 'b' of next line.
    assert.equal(editor.getText(), "foo\nar");
    assert.equal(editor.getRegister(), "b");
  });

  it("b at BOL jumps to previous line word start", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["j", "0", "b", "x"]);
    assert.equal(editor.getText(), "oo\nbar");
    assert.equal(editor.getRegister(), "f");
  });

  it("e crosses EOL to end of next line word", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$", "e", "x"]);
    assert.equal(editor.getText(), "foo\nba");
    assert.equal(editor.getRegister(), "r");
  });

  it("dw can delete across newline", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["d", "w"]);
    assert.equal(editor.getText(), "bar");
    assert.equal(editor.getRegister(), "foo\n");
  });

  it("yw can yank across newline without mutation", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    const before = editor.getText();
    sendKeys(editor, ["y", "w"]);
    assert.equal(editor.getRegister(), "foo\n");
    assert.equal(editor.getText(), before);
  });

  it("W crosses EOL to next line WORD start", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$", "W", "x"]);
    assert.equal(editor.getText(), "foo\nar");
    assert.equal(editor.getRegister(), "b");
  });

  it("B at BOL jumps to previous line WORD start", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["j", "0", "B", "x"]);
    assert.equal(editor.getText(), "oo\nbar");
    assert.equal(editor.getRegister(), "f");
  });

  it("E crosses EOL to end of next line WORD", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$", "E", "x"]);
    assert.equal(editor.getText(), "foo\nba");
    assert.equal(editor.getRegister(), "r");
  });

  it("dW crosses newline while cW keeps cE parity", () => {
    const { editor: deleteEditor } = createMultiLineEditor("foo\nbar");
    sendKeys(deleteEditor, ["d", "W"]);
    assert.equal(deleteEditor.getText(), "bar");
    assert.equal(deleteEditor.getRegister(), "foo\n");

    const { editor: changeEditor } = createMultiLineEditor("foo\nbar");
    sendKeys(changeEditor, ["c", "W"]);
    assert.equal(changeEditor.getText(), "\nbar");
    assert.equal(changeEditor.getRegister(), "foo");
    assert.equal(changeEditor.getMode(), "insert");
  });

  it("yW can yank across newline without mutation", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    const before = editor.getText();
    sendKeys(editor, ["y", "W"]);
    assert.equal(editor.getRegister(), "foo\n");
    assert.equal(editor.getText(), before);
  });
});

// ---------------------------------------------------------------------------
// Yank (y) — no mutation, writes register
// ---------------------------------------------------------------------------

describe("yank operator — yy / yw / ye / yb / y$ / y0", () => {
  it("yy: yanks line + newline, does not mutate text", () => {
    const { editor } = createEditorWithSpy("hello world");
    const before = editor.getText();
    sendKeys(editor, ["y", "y"]);
    assert.equal(editor.getRegister(), "hello world\n");
    assert.equal(editor.getText(), before);
  });

  it("yw: yanks forward word, no mutation", () => {
    const { editor } = createEditorWithSpy("hello world");
    const before = editor.getText();
    sendKeys(editor, ["y", "w"]);
    assert.equal(editor.getRegister(), "hello ");
    assert.equal(editor.getText(), before);
  });

  it("ye: yanks to end of word (inclusive), no mutation", () => {
    const { editor } = createEditorWithSpy("hello world");
    const before = editor.getText();
    sendKeys(editor, ["y", "e"]);
    assert.equal(editor.getRegister(), "hello");
    assert.equal(editor.getText(), before);
  });

  it("yb from mid-word: yanks backward, no mutation", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();
    sendKeys(editor, ["w", "y", "b"]); // navigate to 'b', yank back to 'f'
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getText(), before);
  });

  it("y$: yanks to EOL, no mutation", () => {
    const { editor } = createEditorWithSpy("hello world");
    const before = editor.getText();
    sendKeys(editor, ["y", "$"]);
    assert.equal(editor.getRegister(), "hello world");
    assert.equal(editor.getText(), before);
  });

  it("y0 from mid-word: yanks to start, no mutation", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();
    sendKeys(editor, ["w", "y", "0"]); // navigate to col 4, yank to start
    assert.equal(editor.getRegister(), "foo ");
    assert.equal(editor.getText(), before);
  });

  it("yW yanks to next WORD start without mutation", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz");
    const before = editor.getText();

    sendKeys(editor, ["y", "W"]);

    assert.equal(editor.getRegister(), "foo-bar   ");
    assert.equal(editor.getText(), before);
  });

  it("yE yanks to end of WORD inclusively", () => {
    const { editor } = createEditorWithSpy("foo-bar   baz");
    const before = editor.getText();

    sendKeys(editor, ["y", "E"]);

    assert.equal(editor.getRegister(), "foo-bar");
    assert.equal(editor.getText(), before);
  });

  it("yB yanks backward by WORD", () => {
    const { editor } = createEditorWithSpy("foo-bar baz");
    const before = editor.getText();

    sendKeys(editor, ["W", "y", "B"]);

    assert.equal(editor.getRegister(), "foo-bar ");
    assert.equal(editor.getText(), before);
  });

  it("yank invariant: text unchanged across all yank motions", () => {
    const { editor } = createEditorWithSpy("hello world");
    const before = editor.getText();
    for (const motion of ["y", "w", "y", "e", "y", "$", "y", "b", "y", "0"]) {
      sendKeys(editor, [motion]);
    }
    assert.equal(editor.getText(), before);
  });
});

// ---------------------------------------------------------------------------
// Put (p / P) — character-wise
// ---------------------------------------------------------------------------

describe("put — character-wise", () => {
  it("p inserts register content after cursor", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("X");
    sendKeys(editor, ["p"]);
    assert.equal(editor.getText(), "aXb");
  });

  it("P inserts register content before cursor", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("X");
    sendKeys(editor, ["P"]);
    assert.equal(editor.getText(), "Xab");
  });

  it("p/P are no-ops when register is empty", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("");
    const before = editor.getText();
    sendKeys(editor, ["p"]);
    assert.equal(editor.getText(), before);
    sendKeys(editor, ["P"]);
    assert.equal(editor.getText(), before);
  });

  it("yw then p: yanked text inserted after cursor", () => {
    // "hello" col 0: yw grabs "hello" (whole word to EOL)
    // p: ESC_RIGHT (col→1) then insert "hello" → "hhelloello"
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["y", "w"]);
    assert.equal(editor.getRegister(), "hello");
    sendKeys(editor, ["p"]);
    assert.equal(editor.getText(), "hhelloello");
  });

  it("p at EOL on non-last line inserts before newline", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    editor.setRegister("X");
    sendKeys(editor, ["$", "p"]);
    assert.equal(editor.getText(), "fooX\nbar");
  });
});

// ---------------------------------------------------------------------------
// Put (p / P) — line-wise
// ---------------------------------------------------------------------------

describe("put — line-wise", () => {
  it("p with line-wise register inserts new line below", () => {
    const { editor } = createEditorWithSpy("bar");
    editor.setRegister("foo\n");
    sendKeys(editor, ["p"]);
    const lines = editor.getText().split("\n");
    assert.equal(lines[0], "bar");
    assert.equal(lines[1], "foo");
  });

  it("P with line-wise register inserts new line above", () => {
    const { editor } = createEditorWithSpy("bar");
    editor.setRegister("foo\n");
    sendKeys(editor, ["P"]);
    const lines = editor.getText().split("\n");
    assert.equal(lines[0], "foo");
    assert.equal(lines[1], "bar");
  });

  it("Y yanks current line (like yy)", () => {
    const { editor } = createMultiLineEditor("aaa\nbbb\nccc");
    sendKeys(editor, ["j", "Y", "p"]);
    const lines = editor.getText().split("\n");
    assert.deepStrictEqual(lines, ["aaa", "bbb", "bbb", "ccc"]);
  });

  it("3Y yanks 3 lines", () => {
    const { editor } = createMultiLineEditor("aaa\nbbb\nccc\nddd");
    sendKeys(editor, ["3", "Y", "G", "p"]);
    const lines = editor.getText().split("\n");
    assert.deepStrictEqual(lines, ["aaa", "bbb", "ccc", "ddd", "aaa", "bbb", "ccc"]);
  });

  it("yy then p: duplicates line below", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["y", "y"]);
    assert.equal(editor.getRegister(), "hello\n");
    sendKeys(editor, ["p"]);
    const lines = editor.getText().split("\n");
    assert.equal(lines[0], "hello");
    assert.equal(lines[1], "hello");
  });
});

// ---------------------------------------------------------------------------
// Undo / redo — u / ctrl+r  (Task 6)
// ---------------------------------------------------------------------------

describe("undo / redo — u / ctrl+r", () => {
  it("u in normal mode does not insert the letter 'u'", () => {
    // u must not be treated as a printable char — it must forward ctrl+_ to super
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["u"]);
    assert.ok(
      !editor.getText().includes("uhello") && editor.getText().length <= before.length,
      "u must not be inserted as a literal character and text must not grow",
    );
  });

  it("u after dw: text does not grow (undo forwarded to underlying editor)", () => {
    // Keep this as a narrow safety regression. Round-trip restore coverage
    // lives in the redo-focused tests below.
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["d", "w"]);
    const afterDelete = editor.getText();
    assert.equal(afterDelete, "world");
    sendKeys(editor, ["u"]); // sends \x1f to underlying editor
    // text length must not grow beyond the pre-delete length
    assert.ok(
      editor.getText().length <= "hello world".length,
      "undo must not corrupt state",
    );
  });

  it("ctrl+r in normal mode with no redo history is a safe no-op", () => {
    const { editor } = createEditorWithSpy("hello world");
    const beforeText = editor.getText();
    const beforeCursor = editor.getCursor();

    assert.doesNotThrow(() => sendKeys(editor, ["\x12"]));
    assert.equal(editor.getText(), beforeText);
    assert.deepEqual(editor.getCursor(), beforeCursor);
  });

  it("ctrl+r after x then u restores deleted text", () => {
    const { editor } = createEditorWithSpy("hello");

    sendKeys(editor, ["x"]);
    assert.equal(editor.getText(), "ello");

    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "hello");

    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "ello");
  });

  it("ctrl+r restores the captured post-change cursor", () => {
    const { editor } = createEditorWithSpy("X");
    editor.setRegister("ab");

    sendKeys(editor, ["p"]);
    const afterPutCursor = editor.getCursor();
    assert.equal(editor.getText(), "Xab");
    assert.deepEqual(afterPutCursor, { line: 0, col: 3 });

    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "X");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });

    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "Xab");
    assert.deepEqual(editor.getCursor(), afterPutCursor);
  });

  it("ctrl+r in normal mode is not inserted as a literal control character", () => {
    const { editor } = createEditorWithSpy("hello");

    sendKeys(editor, ["x", "u", "\x12"]);

    assert.equal(editor.getText(), "ello");
    assert.ok(
      !editor.getText().includes("\x12"),
      "ctrl+r must not become a literal control character in the buffer",
    );
  });

  it("repeated ctrl+r walks forward through stacked redo history", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "x", "x"]);
    assert.equal(editor.getText(), "d");

    sendKeys(editor, ["u", "u", "u"]);
    assert.equal(editor.getText(), "abcd");

    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "bcd");

    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "cd");

    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "d");
  });

  it("2ctrl+r redoes two stacked undo steps", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "x", "x"]);
    sendKeys(editor, ["u", "u", "u"]);
    assert.equal(editor.getText(), "abcd");

    sendKeys(editor, ["2", "\x12"]);

    assert.equal(editor.getText(), "cd");
  });

  it("3ctrl+r redoes three stacked undo steps", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "x", "x"]);
    sendKeys(editor, ["u", "u", "u"]);
    assert.equal(editor.getText(), "abcd");

    sendKeys(editor, ["3", "\x12"]);

    assert.equal(editor.getText(), "d");
  });

  it("3ctrl+r clamps when fewer redo steps exist", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "x"]);
    sendKeys(editor, ["u", "u"]);
    assert.equal(editor.getText(), "abcd");

    sendKeys(editor, ["3", "\x12"]);

    assert.equal(editor.getText(), "cd");
  });

  it("counted ctrl+r does not leak count into the next command", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "x", "x"]);
    sendKeys(editor, ["u", "u", "u"]);
    assert.equal(editor.getText(), "abcd");

    sendKeys(editor, ["2", "\x12", "x"]);

    assert.equal(editor.getText(), "d");
    assert.equal(editor.getRegister(), "c");
  });

  it("redo parity: x restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "hello",
      keys: ["x"],
      expectedText: "ello",
      expectedCursor: { line: 0, col: 0 },
      expectedRegister: "h",
    });
  });

  it("redo parity: dw restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "hello world",
      keys: ["d", "w"],
      expectedText: "world",
      expectedCursor: { line: 0, col: 0 },
      expectedRegister: "hello ",
    });
  });

  it("redo parity: dd restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "foo\nbar",
      keys: ["d", "d"],
      expectedText: "bar",
      expectedCursor: { line: 0, col: 0 },
      expectedRegister: "foo\n",
      multiLine: true,
    });
  });

  it("redo parity: p restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "ab",
      keys: ["p"],
      expectedText: "aXb",
      expectedCursor: { line: 0, col: 2 },
      expectedRegister: "X",
      before: (editor) => editor.setRegister("X"),
    });
  });

  it("redo parity: P restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "ab",
      keys: ["P"],
      expectedText: "Xab",
      expectedCursor: { line: 0, col: 1 },
      expectedRegister: "X",
      before: (editor) => editor.setRegister("X"),
    });
  });

  it("redo parity: cw restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "hello world",
      keys: ["c", "w", "Z", "\x1b"],
      expectedText: "Zworld",
      expectedCursor: { line: 0, col: 1 },
      expectedRegister: "hello ",
    });
  });

  it("redo parity: J restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "foo\nbar",
      keys: ["J"],
      expectedText: "foo bar",
      expectedCursor: { line: 0, col: 3 },
      expectedRegister: "",
      multiLine: true,
    });
  });

  it("redo parity: gJ restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "foo\nbar",
      keys: ["g", "J"],
      expectedText: "foobar",
      expectedCursor: { line: 0, col: 3 },
      expectedRegister: "",
      multiLine: true,
    });
  });

  it("redo parity: 3J restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "aa\nbb\ncc",
      keys: ["3", "J"],
      expectedText: "aa bb cc",
      expectedCursor: { line: 0, col: 5 },
      expectedRegister: "",
      multiLine: true,
    });
  });

  it("redo parity: 3gJ restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "aa\nbb\ncc",
      keys: ["3", "g", "J"],
      expectedText: "aabbcc",
      expectedCursor: { line: 0, col: 4 },
      expectedRegister: "",
      multiLine: true,
    });
  });

  it("redo parity: J preserves preexisting unnamed register", () => {
    assertRedoRoundTrip({
      initial: "foo\nbar",
      keys: ["J"],
      expectedText: "foo bar",
      expectedCursor: { line: 0, col: 3 },
      expectedRegister: "keep",
      multiLine: true,
      before: (editor) => editor.setRegister("keep"),
    });
  });

  describe("central invalidation hook", () => {
    function seedStaleRedo(options: {
      initial: string;
      multiLine?: boolean;
    }): {
      editor: ReturnType<typeof createEditorWithSpy>["editor"];
      staleRedoText: string;
    } {
      const { initial, multiLine = false } = options;
      const { editor } = multiLine
        ? createMultiLineEditor(initial)
        : createEditorWithSpy(initial);

      sendKeys(editor, ["x"]);
      const staleRedoText = editor.getText();
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), initial, "redo setup should restore initial text");

      return { editor, staleRedoText };
    }

    it("mutation classes clear redo history", () => {
      const scenarios: Array<{
        name: string;
        initial: string;
        keys: string[];
        expectedText: string;
        multiLine?: boolean;
      }> = [
        {
          name: "insert-mode text entry",
          initial: "abcd",
          keys: ["i", "Z", "\x1b"],
          expectedText: "Zabcd",
        },
        {
          name: "delegated normal-mode mutation (D)",
          initial: "abcd",
          keys: ["D"],
          expectedText: "",
        },
        {
          name: "delegated normal-mode mutation (dw)",
          initial: "alpha beta",
          keys: ["d", "w"],
          expectedText: "beta",
        },
        {
          name: "synthetic edit (J)",
          initial: "a\nb",
          keys: ["J"],
          expectedText: "a b",
          multiLine: true,
        },
        {
          name: "synthetic edit (gJ)",
          initial: "a\nb",
          keys: ["g", "J"],
          expectedText: "ab",
          multiLine: true,
        },
      ];

      for (const scenario of scenarios) {
        const { editor } = seedStaleRedo({
          initial: scenario.initial,
          multiLine: scenario.multiLine,
        });

        sendKeys(editor, scenario.keys);
        assert.equal(editor.getText(), scenario.expectedText, `${scenario.name} mutates text`);

        sendKeys(editor, ["\x12"]);
        assert.equal(editor.getText(), scenario.expectedText, `${scenario.name} clears redo`);
      }
    });

    it("guarded undo/redo classes preserve redo history", () => {
      const scenarios: Array<{
        name: string;
        run: (editor: ReturnType<typeof createEditorWithSpy>["editor"]) => void;
      }> = [
        {
          name: "undo transition",
          run: (editor) => {
            sendKeys(editor, ["x", "x"]);
            sendKeys(editor, ["u"]);
            assert.equal(editor.getText(), "bcd", "undo transition checkpoint");

            sendKeys(editor, ["u"]);
            assert.equal(editor.getText(), "abcd", "undo transition keeps redo stack");

            sendKeys(editor, ["\x12", "\x12"]);
            assert.equal(editor.getText(), "cd", "undo transition keeps both redo entries");
          },
        },
        {
          name: "redo transition",
          run: (editor) => {
            sendKeys(editor, ["x", "x", "x"]);
            sendKeys(editor, ["u", "u", "u"]);
            assert.equal(editor.getText(), "abcd", "redo transition setup");

            sendKeys(editor, ["2", "\x12"]);
            assert.equal(editor.getText(), "cd", "redo transition keeps stepwise redo");

            sendKeys(editor, ["u"]);
            assert.equal(editor.getText(), "bcd", "redo transition keeps undo boundaries");
          },
        },
      ];

      for (const scenario of scenarios) {
        const { editor } = createEditorWithSpy("abcd");
        scenario.run(editor);
      }
    });

    it("non-mutating classes preserve redo history", () => {
      const scenarios: Array<{
        name: string;
        run: (
          editor: ReturnType<typeof createEditorWithSpy>["editor"],
          staleRedoText: string,
        ) => void;
      }> = [
        {
          name: "navigation",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["l", "h", "\x12"]);
            assert.equal(editor.getText(), staleRedoText, "navigation preserves redo");
          },
        },
        {
          name: "yank",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["y", "y", "\x12"]);
            assert.equal(editor.getText(), staleRedoText, "yank preserves redo");
          },
        },
        {
          name: "failed motion",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["f", "z", "\x12"]);
            assert.equal(editor.getText(), staleRedoText, "failed motion preserves redo");
          },
        },
        {
          name: "mode toggle",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["i", "\x1b", "\x12"]);
            assert.equal(editor.getText(), staleRedoText, "mode toggle preserves redo");
          },
        },
        {
          name: "no-op redo",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["\x12"]);
            assert.equal(editor.getText(), staleRedoText, "redo setup should replay once");

            sendKeys(editor, ["\x12"]);
            assert.equal(editor.getText(), staleRedoText, "no-op redo does not mutate");

            sendKeys(editor, ["u", "\x12"]);
            assert.equal(editor.getText(), staleRedoText, "no-op redo keeps history intact");
          },
        },
      ];

      for (const scenario of scenarios) {
        const { editor, staleRedoText } = seedStaleRedo({ initial: "abcd" });
        scenario.run(editor, staleRedoText);
      }
    });

    it("empty redo-stack fast path is harmless", () => {
      const { editor } = createEditorWithSpy("abcd");

      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "abcd");

      sendKeys(editor, ["i", "Z", "\x1b"]);
      assert.equal(editor.getText(), "Zabcd");

      sendKeys(editor, ["u", "\x12"]);
      assert.equal(editor.getText(), "Zabcd");
    });

    it("no-op synthetic edit (J on last line) preserves redo", () => {
      const { editor } = createEditorWithSpy("hello");
      sendKeys(editor, ["x"]);
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "hello");
      sendKeys(editor, ["J"]);
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "ello");
    });
  });

  it("bracketed paste in normal mode still clears pending state before redo", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "u"]);
    assert.equal(editor.getText(), "abcd");

    editor.setRegister("keep");
    sendKeys(editor, ["d", "\x1b[200~paste\x1b[201~", "\x12"]);

    assert.equal(editor.getText(), "bcd");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    assert.equal(editor.getRegister(), "keep");
  });

  it("ctrl+k still cancels pending delete and clears stale redo history", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "u"]);
    assert.equal(editor.getText(), "abcd");
    assert.equal(editor.getRegister(), "a");

    sendKeys(editor, ["d", "\x0b"]);

    assert.equal(editor.getText(), "");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    assert.equal(editor.getRegister(), "a");

    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    assert.equal(editor.getRegister(), "a");
  });

  it("redo does not stomp a newer unnamed register value", () => {
    const { editor } = createEditorWithSpy("hello world");

    sendKeys(editor, ["x", "u"]);
    sendKeys(editor, ["y", "w"]);
    assert.equal(editor.getRegister(), "hello ");

    sendKeys(editor, ["\x12"]);

    assert.equal(editor.getText(), "ello world");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    assert.equal(editor.getRegister(), "hello ");
  });

  it("u in insert mode inserts literal 'u' (not intercepted)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["i"]); // → insert mode
    assert.equal(editor.getMode(), "insert");
    sendKeys(editor, ["u"]);
    assert.ok(editor.getText().includes("u"), "u in insert mode must insert character");
  });

  it("undo does not self-invalidate redo stack", () => {
    const { editor } = createEditorWithSpy("abcd");
    sendKeys(editor, ["x", "x"]); // 'a' then 'b' deleted
    assert.equal(editor.getText(), "cd");
    sendKeys(editor, ["u"]); // undo 'b' delete → "bcd"
    // redo stack has 1 entry; second undo must not clear it
    sendKeys(editor, ["u"]); // undo 'a' delete → "abcd"
    assert.equal(editor.getText(), "abcd");
    // both redo entries must survive
    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "bcd");
    sendKeys(editor, ["\x12"]);
    assert.equal(editor.getText(), "cd");
  });

  describe("stepwise counted redo — intermediate undo granularity", () => {
    it("2<C-r> then u lands on state after first redo", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "x", "x"]); // "d"
      sendKeys(editor, ["u", "u", "u"]); // "abcd"
      sendKeys(editor, ["2", "\x12"]); // redo 2 steps → "cd"
      assert.equal(editor.getText(), "cd");
      sendKeys(editor, ["u"]); // undo one redo → "bcd"
      assert.equal(editor.getText(), "bcd");
    });

    it("after 2<C-r> then u, another u returns to pre-redo state", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "x", "x"]);
      sendKeys(editor, ["u", "u", "u"]);
      sendKeys(editor, ["2", "\x12"]);
      sendKeys(editor, ["u"]); // → "bcd"
      sendKeys(editor, ["u"]); // → "abcd"
      assert.equal(editor.getText(), "abcd");
    });

    it("stepwise redo with synthetic-edit history (J)", () => {
      const { editor } = createMultiLineEditor("a\nb\nc");
      sendKeys(editor, ["J"]); // join → "a b\nc"
      sendKeys(editor, ["J"]); // join → "a b c"
      assert.equal(editor.getText(), "a b c");

      sendKeys(editor, ["u", "u"]); // undo both → "a\nb\nc"
      assert.equal(editor.getText(), "a\nb\nc");

      sendKeys(editor, ["2", "\x12"]); // redo 2 → "a b c"
      assert.equal(editor.getText(), "a b c");

      sendKeys(editor, ["u"]); // undo last redo → "a b\nc"
      assert.equal(editor.getText(), "a b\nc");
    });
  });

  describe("redo restore hardening", () => {
    it("restore failure does not consume redo entry or change visible state", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "u"]);
      assert.equal(editor.getText(), "abcd");

      const raw = editor as any;
      const savedState = raw.state;
      raw.state = undefined;

      try {
        assert.throws(
          () => sendKeys(editor, ["\x12"]),
          /redo restore prerequisite: editor state unavailable/i,
        );
      } finally {
        raw.state = savedState;
      }

      assert.equal(editor.getText(), "abcd");

      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "bcd");
    });

    it("partial counted redo failure preserves committed steps", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "x"]); // "cd"
      sendKeys(editor, ["u", "u"]); // "abcd"
      assert.equal(editor.getText(), "abcd");

      const raw = editor as any;
      const originalPushUndoSnapshot = raw.pushUndoSnapshot;
      let pushCalls = 0;
      let suspendedState = raw.state;

      raw.pushUndoSnapshot = () => {
        pushCalls++;
        originalPushUndoSnapshot?.call(raw);
        if (pushCalls === 2) {
          suspendedState = raw.state;
          raw.state = undefined;
        }
      };

      try {
        assert.throws(
          () => sendKeys(editor, ["2", "\x12"]),
          /redo restore prerequisite: editor state unavailable/i,
        );
      } finally {
        raw.state = suspendedState;
        raw.pushUndoSnapshot = originalPushUndoSnapshot;
      }

      assert.equal(editor.getText(), "bcd");

      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "cd");
    });

    it("redo throws when pushUndoSnapshot is unavailable", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "u"]);
      assert.equal(editor.getText(), "abcd");

      const raw = editor as any;
      const saved = raw.pushUndoSnapshot;
      raw.pushUndoSnapshot = undefined;

      try {
        assert.throws(
          () => sendKeys(editor, ["\x12"]),
          /pushUndoSnapshot/i,
        );
      } finally {
        raw.pushUndoSnapshot = saved;
      }

      // Redo entry must NOT have been consumed
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "bcd");
    });
  });

  describe("post-redo motion/cache coherence", () => {
    it("w motion after redo of join reads restored buffer", () => {
      const { editor } = createMultiLineEditor("aaa\nbbb ccc");

      sendKeys(editor, ["J"]);
      assert.equal(editor.getText(), "aaa bbb ccc");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "aaa\nbbb ccc");

      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "aaa bbb ccc");

      sendKeys(editor, ["w", "x"]);
      assert.equal(editor.getText(), "aaa bb ccc");
    });

    it("b motion after redo reads restored buffer", () => {
      const { editor } = createEditorWithSpy("hello world");

      sendKeys(editor, ["x"]);
      assert.equal(editor.getText(), "ello world");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "hello world");

      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "ello world");

      sendKeys(editor, ["$", "b", "x"]);
      assert.equal(editor.getText(), "ello orld");
    });
  });

  describe("normal-mode CTRL_UNDERSCORE undo alias", () => {
    it("CTRL_UNDERSCORE in normal mode acts as undo", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x"]); // delete 'a'
      assert.equal(editor.getText(), "bcd");
      sendKeys(editor, ["\x1f"]); // CTRL_UNDERSCORE
      assert.equal(editor.getText(), "abcd");
    });

    it("CTRL_UNDERSCORE feeds redo history like u", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x"]);
      sendKeys(editor, ["\x1f"]); // undo via CTRL_UNDERSCORE
      assert.equal(editor.getText(), "abcd");
      sendKeys(editor, ["\x12"]); // redo
      assert.equal(editor.getText(), "bcd");
    });

    it("no-op CTRL_UNDERSCORE does not create redo history", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["\x1f"]); // undo with nothing to undo
      sendKeys(editor, ["\x12"]); // redo should be no-op
      assert.equal(editor.getText(), "abcd");
    });

    it("CTRL_UNDERSCORE does not insert literal control char", () => {
      const { editor } = createEditorWithSpy("hello");
      sendKeys(editor, ["\x1f"]);
      assert.ok(
        !editor.getText().includes("\x1f"),
        "must not insert literal \\x1f",
      );
    });
  });

  describe("count-state safety for counted redo", () => {
    it("{count}<C-r> does not leak count into next command (9)", () => {
      const { editor } = createEditorWithSpy("abcdefghij");
      sendKeys(editor, ["x", "u"]);
      // 9<C-r> clamps to 1 available entry, then x deletes one char
      sendKeys(editor, ["9", "\x12", "x"]);
      assert.equal(editor.getText(), "cdefghij");
      assert.equal(editor.getRegister(), "b");
    });

    it("0 after counted redo is treated as line-start motion", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["l", "l", "x", "u"]);
      // 1<C-r> redoes the x at col 2 → "abd"; 0 = line-start; x deletes 'a'
      sendKeys(editor, ["1", "\x12", "0", "x"]);
      assert.equal(editor.getText(), "bd");
    });
  });
  describe("counted undo", () => {
    it("3u undoes 3 separate edits", () => {
      const { editor } = createMultiLineEditor("hello");
      // make 3 edits
      sendKeys(editor, ["A"]);
      sendKeys(editor, [" "]);
      sendKeys(editor, ["\x1b"]);
      sendKeys(editor, ["A"]);
      sendKeys(editor, ["w"]);
      sendKeys(editor, ["\x1b"]);
      sendKeys(editor, ["A"]);
      sendKeys(editor, ["!"]);
      sendKeys(editor, ["\x1b"]);
      // buffer should be "hello w!"
      assert.equal(editor.getText(), "hello w!");
      // 3u should undo all 3 edits
      sendKeys(editor, ["3", "u"]);
      assert.equal(editor.getText(), "hello");
    });

    it("counted undo clamps at available history", () => {
      // Start with empty text so no setup undo history exists
      const { editor } = createMultiLineEditor("");
      // make 1 edit: type a char in insert mode
      sendKeys(editor, ["i", "!", "\x1b"]);
      assert.equal(editor.getText(), "!");
      // 9u should undo the 1 available edit without error
      sendKeys(editor, ["9", "u"]);
      assert.equal(editor.getText(), "");
    });

    it("counted undo does not leak count to next command", () => {
      const { editor } = createMultiLineEditor("aaa\nbbb\nccc");
      // make 2 edits
      sendKeys(editor, ["A"]);
      sendKeys(editor, ["!"]);
      sendKeys(editor, ["\x1b"]);
      sendKeys(editor, ["j"]);
      sendKeys(editor, ["A"]);
      sendKeys(editor, ["?"]);
      sendKeys(editor, ["\x1b"]);
      // 2u
      sendKeys(editor, ["2", "u"]);
      // now press j — should move 1 line, not 2
      sendKeys(editor, ["j"]);
      // cursor should be on line 1 (0-indexed), not line 2
      assert.strictEqual(editor.getCursor().line, 1);
    });
  });

  describe("kitty keyboard protocol sequences", () => {
    it("kitty ctrl+r triggers redo", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "u"]);
      assert.equal(editor.getText(), "abcd");
      sendKeys(editor, ["\x1b[114;5u"]); // kitty ctrl+r
      assert.equal(editor.getText(), "bcd");
    });

    it("kitty ctrl+_ triggers undo and feeds redo", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x"]);
      assert.equal(editor.getText(), "bcd");
      sendKeys(editor, ["\x1b[95;5u"]); // kitty ctrl+_
      assert.equal(editor.getText(), "abcd");
      sendKeys(editor, ["\x12"]); // redo
      assert.equal(editor.getText(), "bcd");
    });

    it("counted kitty ctrl+r works", () => {
      const { editor } = createEditorWithSpy("abcd");
      sendKeys(editor, ["x", "x"]);
      assert.equal(editor.getText(), "cd");
      sendKeys(editor, ["u", "u"]);
      assert.equal(editor.getText(), "abcd");
      sendKeys(editor, ["2", "\x1b[114;5u"]); // 2<kitty-C-r>
      assert.equal(editor.getText(), "cd");
    });
  });
});

// ---------------------------------------------------------------------------
// Char-find motions — f / t / F / T / ; / ,
// ---------------------------------------------------------------------------

describe("char-find motions — f / F / t / T / ; / ,", () => {
  it("f{char}: cursor moves to next occurrence of char", () => {
    // "hello world" col 0, fo → cursor to col 4 ('o')
    // verify via x: delete 'o' at col 4
    chk("hello world", ["f", "o", "x"], "hell world", "o");
  });

  it("t{char}: cursor moves to one before char", () => {
    // "hello world" col 0, to → cursor to col 3 ('l'), x deletes 'l'
    chk("hello world", ["t", "o", "x"], "helo world", "l");
  });

  it("F{char}: cursor moves backward to char", () => {
    // "aba" col 0→2 (ll), Fa → cursor to col 0, x deletes 'a'
    chk("aba", ["l", "l", "F", "a", "x"], "ba", "a");
  });

  it("T{char}: cursor moves to one after backward target", () => {
    // "abcde" col 4 (press e for end), Tb → finds 'b' at col 1, returns col 2
    // x at col 2 deletes 'c' → "abde"
    chk("abcde", ["e", "T", "b", "x"], "abde", "c");
  });

  it("; repeats last f motion forward", () => {
    // "hello world" col 0: fo → col 4 ('o'); ; → next 'o' col 7; x
    chk("hello world", ["f", "o", ";", "x"], "hello wrld", "o");
  });

  it(", reverses last f motion", () => {
    // "hello world" col 0: fo → col 4; ; → col 7; , → back to col 4; x
    chk("hello world", ["f", "o", ";", ",", "x"], "hell world", "o");
  });

  it("f{char} with operator: df{char} deletes to char (inclusive)", () => {
    // "hello world" col 0, dfo → deletes "hello" (col 0..4 inclusive)
    chk("hello world", ["d", "f", "o"], " world", "hello");
  });

  it("t{char} with operator: dt{char} deletes up to char (exclusive)", () => {
    // "hello world" col 0, dto → deletes "hell" (col 0..3, not 'o')
    chk("hello world", ["d", "t", "o"], "o world", "hell");
  });

  it("f{char} handles an emoji before the target", () => {
    const { editor } = createEditorWithSpy("😀xy");

    sendKeys(editor, ["f", "y"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("T{char} at EOL lands at line end instead of crashing", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["$", "T", "c"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("T{char} after an emoji target at EOL lands safely", () => {
    const { editor } = createEditorWithSpy("ab😀");

    sendKeys(editor, ["$", "T", "😀"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("f{char} accepts a single grapheme made of multiple code points", () => {
    const target = "e\u0301";
    const { editor } = createEditorWithSpy(`x${target}y`);

    sendKeys(editor, ["f", target]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });
});

// ---------------------------------------------------------------------------
// Operator cancellation / edge safety
// ---------------------------------------------------------------------------

describe("operator cancellation", () => {
  it("Escape cancels pending operator without mutation", () => {
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["d"]);        // pendingOperator = 'd'
    sendKeys(editor, ["\x1b"]);     // cancel
    assert.equal(editor.getText(), before);
    assert.equal(editor.getMode(), "normal");
  });

  it("Escape cancels pending motion without mutation", () => {
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["f"]);        // pendingMotion = 'f'
    sendKeys(editor, ["\x1b"]);     // cancel
    assert.equal(editor.getText(), before);
  });

  it("unrecognised key after d operator cancels cleanly", () => {
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["d", "z"]);   // 'z' is not a valid motion
    assert.equal(editor.getText(), before);
  });

  it("invalid delete motion does not stay sticky", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();

    // If d stays pending after z, next w would delete instead of move.
    sendKeys(editor, ["d", "z", "w"]);
    assert.equal(editor.getText(), before);
  });

  it("invalid change motion does not stay sticky", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();

    // If c stays pending after z, next w would change/delete unexpectedly.
    sendKeys(editor, ["c", "z", "w"]);
    assert.equal(editor.getText(), before);
    assert.equal(editor.getMode(), "normal");
  });

  it("printable chunk cancels df target wait without insertion", () => {
    const { editor } = createEditorWithSpy("foo bar");

    // After d f, pasted printable chunks should cancel the wait and be ignored.
    // If operator stays sticky or text is inserted, final state differs.
    sendKeys(editor, ["d", "f", "ab", "w", "x"]);

    assert.equal(editor.getText(), "foo ar");
    assert.equal(editor.getRegister(), "b");
  });

  it("bracketed paste chunk cancels df target wait", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["d", "f", "\x1b[200~PASTE\x1b[201~", "w", "x"]);

    assert.equal(editor.getText(), "foo ar");
    assert.equal(editor.getRegister(), "b");
  });

  it("split bracketed paste cancels df target wait", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["d", "f", "\x1b[200~", "PASTE", "\x1b[201~", "w", "x"]);

    assert.equal(editor.getText(), "foo ar");
    assert.equal(editor.getRegister(), "b");
  });

  it("double-escape recovers from unterminated bracketed paste discard mode", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["\x1b[200~", "\x1b", "\x1b", "w", "x"]);

    assert.equal(editor.getText(), "foo ar");
    assert.equal(editor.getRegister(), "b");
  });

  it("double-escape recovery does not forward escape upward", () => {
    const { editor } = createEditorWithSpy("foo bar");

    const customEditorProto = Object.getPrototypeOf(Object.getPrototypeOf(editor));
    const originalHandleInput = customEditorProto.handleInput;
    let forwardedEscapeCount = 0;

    customEditorProto.handleInput = function (this: unknown, data: string): unknown {
      if (data === "\x1b") forwardedEscapeCount++;
      return originalHandleInput.call(this, data);
    };

    try {
      sendKeys(editor, ["\x1b[200~", "\x1b", "\x1b"]);
      assert.equal(forwardedEscapeCount, 0);
    } finally {
      customEditorProto.handleInput = originalHandleInput;
    }
  });

  it("split bracketed paste end marker closes discard state", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["\x1b[200~", "PASTE", "\x1b", "[201~", "w", "x"]);

    assert.equal(editor.getText(), "foo ar");
    assert.equal(editor.getRegister(), "b");
  });

  it("non-printable input cancels df target wait without stickiness", () => {
    const { editor } = createEditorWithSpy("foo bar");
    const before = editor.getText();

    // After d f, a non-printable key must cancel the pending operator+motion.
    // If it stays sticky, the next w would delete.
    sendKeys(editor, ["d", "f", "\x1b[C", "w"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "");
  });

  it("non-printable invalid motion is passed through after cancel", () => {
    const { editor } = createEditorWithSpy("abc");

    // d + RightArrow should cancel d and still move right.
    // Then x should delete 'b' (not 'a').
    sendKeys(editor, ["d", "\x1b[C", "x"]);

    assert.equal(editor.getText(), "ac");
    assert.equal(editor.getRegister(), "b");
  });
});

// ---------------------------------------------------------------------------
// Anti-brittleness regression: no recursive delete handler re-entry
// ---------------------------------------------------------------------------

describe("regression — delete handler recursion", () => {
  it("D repeatedly does not recurse or overflow call stack", () => {
    const { editor } = createMultiLineEditor("alpha\nbeta\ngamma");

    assert.doesNotThrow(() => {
      for (let i = 0; i < 12; i++) {
        sendKeys(editor, ["D"]);
      }
    });

    // If recursion reappears, this test typically throws RangeError before here.
    assert.ok(editor.getText().length >= 0);
  });
});

describe("additional count combinations", () => {
  it("d2k deletes current line and two above", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd\ne");
    sendKeys(editor, ["j", "j", "j", "d", "2", "k"]);
    assert.equal(editor.getText(), "a\ne");
    assert.equal(editor.getRegister(), "b\nc\nd\n");
  });

  it("d2j from middle of line deletes properly", () => {
    const { editor } = createMultiLineEditor("abc\ndef\nghi\njkl");
    sendKeys(editor, ["l", "d", "2", "j"]);
    assert.equal(editor.getText(), "jkl");
  });

  it("d2d deletes two lines just like 2dd", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");
    sendKeys(editor, ["d", "2", "d"]);
    assert.equal(editor.getText(), "c");
    assert.equal(editor.getRegister(), "a\nb\n");
  });

  it("2j moves cursor down two lines (counted navigation)", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");
    sendKeys(editor, ["2", "j", "x"]);
    assert.equal(editor.getText(), "a\nb\n\nd");
  });

  it("2dG cancels cleanly and swallows G because it is printable", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");
    sendKeys(editor, ["2", "d", "G", "x"]);
    // Since 2dG is canceled, G is swallowed, and we just execute x on line 0
    assert.equal(editor.getText(), "\nb\nc");
    assert.equal(editor.getRegister(), "a");
  });
});

describe("surrogate pair / buffer replacement regression", () => {
  it("dd deletes only the current line when it contains surrogate pairs", () => {
    const { editor } = createEditorWithSpy("");
    (editor as unknown as {
      state: { lines: string[]; cursorLine: number; cursorCol: number };
    }).state = {
      lines: ["😀x", "keep"],
      cursorLine: 0,
      cursorCol: 0,
    };
    sendKeys(editor, ["d", "d"]);
    assert.equal(editor.getRegister(), "😀x\n");
    assert.equal(editor.getText(), "keep");
  });

  it("9x on multiline buffer does not cross newline", () => {
    const { editor } = createEditorWithSpy("");
    (editor as unknown as {
      state: { lines: string[]; cursorLine: number; cursorCol: number };
    }).state = {
      lines: ["ab", "cd"],
      cursorLine: 0,
      cursorCol: 0,
    };
    sendKeys(editor, ["9", "x"]);
    assert.equal(editor.getText(), "\ncd");
  });

  it("x deletes a surrogate pair without corrupting the buffer", () => {
    const { editor } = createEditorWithSpy("😀x");
    sendKeys(editor, ["x"]);
    assert.equal(editor.getText(), "x");
    assert.equal(editor.getRegister(), "😀");
  });
});

// ---------------------------------------------------------------------------
// Underscore motion — _ (first non-whitespace, linewise with operators)
// ---------------------------------------------------------------------------

describe("underscore motion — _ (first non-whitespace)", () => {
  it("_ moves to first non-whitespace char on indented line", () => {
    const { editor } = createEditorWithSpy("   hello");
    sendKeys(editor, ["_"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("_ on line with no leading whitespace stays at col 0", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["_"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("_ from mid-line moves back to first non-whitespace", () => {
    const { editor } = createEditorWithSpy("   hello world");
    sendKeys(editor, ["w", "w"]);
    sendKeys(editor, ["_"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("_ stays in normal mode", () => {
    const { editor } = createEditorWithSpy("   hello");
    sendKeys(editor, ["_"]);
    assert.equal(editor.getMode(), "normal");
  });
});

describe("counted underscore motion — {count}_", () => {
  it("2_ moves down one line then to first non-whitespace", () => {
    const { editor } = createMultiLineEditor("foo\n   bar\nbaz");
    sendKeys(editor, ["2", "_"]);
    assert.deepEqual(editor.getCursor(), { line: 1, col: 3 });
  });

  it("1_ is same as plain _", () => {
    const { editor } = createEditorWithSpy("   hello");
    sendKeys(editor, ["1", "_"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("counted _ clamps at last line", () => {
    const { editor } = createMultiLineEditor("foo\n   bar");
    sendKeys(editor, ["9", "_"]);
    assert.deepEqual(editor.getCursor(), { line: 1, col: 3 });
  });

  it("3_ skips wrapped visual rows and lands on the target logical line", () => {
    const wrappedLine = "x".repeat(200);
    const { editor } = createMultiLineEditor(`top\n${wrappedLine}\n  bottom`);
    sendKeys(editor, ["3", "_"]);
    assert.deepEqual(editor.getCursor(), { line: 2, col: 2 });
  });
});

describe("operator + underscore — d_ / c_ / y_ (linewise)", () => {
  it("d_ deletes entire current line (linewise)", () => {
    const { editor } = createMultiLineEditor("hello\nworld\nfoo");
    sendKeys(editor, ["d", "_"]);
    assert.equal(editor.getText(), "world\nfoo");
    assert.equal(editor.getRegister(), "hello\n");
  });

  it("d3_ deletes 3 lines", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd\ne");
    sendKeys(editor, ["d", "3", "_"]);
    assert.equal(editor.getText(), "d\ne");
    assert.equal(editor.getRegister(), "a\nb\nc\n");
  });

  it("c_ changes current line and enters insert mode", () => {
    const { editor } = createMultiLineEditor("hello\nworld");
    sendKeys(editor, ["c", "_"]);
    assert.equal(editor.getMode(), "insert");
    // Line content should be cleared but line preserved
  });

  it("y_ yanks current line without mutation", () => {
    const { editor } = createMultiLineEditor("hello\nworld");
    const before = editor.getText();
    sendKeys(editor, ["y", "_"]);
    assert.equal(editor.getRegister(), "hello\n");
    assert.equal(editor.getText(), before);
  });
});

// ---------------------------------------------------------------------------
// Replace — r{char}
// ---------------------------------------------------------------------------

describe("replace — r{char}", () => {
  it("ra replaces char at cursor", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["r", "a"]);
    assert.equal(editor.getText(), "aello");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("r replaces char in middle of word", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["l", "l", "r", "x"]);
    assert.equal(editor.getText(), "hexlo");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("r replaces a surrogate pair without splitting it", () => {
    const { editor } = createEditorWithSpy("😀x");
    sendKeys(editor, ["r", "a"]);
    assert.equal(editor.getText(), "ax");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("r accepts a single grapheme made of multiple code points", () => {
    const replacement = "e\u0301";
    const { editor } = createEditorWithSpy("abc");
    sendKeys(editor, ["r", replacement]);
    assert.equal(editor.getText(), `${replacement}bc`);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("3rx replaces 3 chars", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["3", "r", "x"]);
    assert.equal(editor.getText(), "xxxlo");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("r + Escape cancels", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["r", "\x1b"]);
    assert.equal(editor.getText(), "hello");
    assert.equal(editor.getMode(), "normal");
  });

  it("5rx on short line cancels (not enough chars)", () => {
    const { editor } = createEditorWithSpy("hi");
    sendKeys(editor, ["5", "r", "x"]);
    assert.equal(editor.getText(), "hi");
  });

  it("r stays in normal mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["r", "a"]);
    assert.equal(editor.getMode(), "normal");
  });

  it("r does not affect register", () => {
    const { editor } = createEditorWithSpy("hello");
    editor.setRegister("untouched");
    sendKeys(editor, ["r", "a"]);
    assert.equal(editor.getRegister(), "untouched");
  });
});
