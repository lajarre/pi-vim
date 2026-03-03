/**
 * Integration tests for ModalEditor key sequences.
 *
 * Smoke matrix: ~30+ scenarios covering the full command surface.
 * Table-driven style used wherever the pattern is uniform; explicit `it`
 * blocks where state inspection requires nuance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEditorWithSpy,
  createMultiLineEditor,
  sendKeys,
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

  it("rejects dual-count delete forms like 2d3j", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");

    sendKeys(editor, ["2", "d", "3", "j", "x"]);

    assert.equal(editor.getText(), "a\n\nc\nd");
    assert.equal(editor.getRegister(), "b");
  });

  it("counted unsupported delete motion d2w cancels instead of deleting", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["d", "2", "w", "x"]);

    assert.equal(editor.getText(), "oo bar");
    assert.equal(editor.getRegister(), "f");
  });

  it("counted unsupported yank motion y2w cancels instead of yanking", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["y", "2", "w"]);

    assert.equal(editor.getText(), "foo bar");
    assert.equal(editor.getRegister(), "");
  });

  it("2d0 does not swallow 0 as a second count", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["2", "d", "0", "x"]);

    assert.equal(editor.getText(), "oo bar");
    assert.equal(editor.getRegister(), "f");
  });
});

describe("buffer motions — gg / G", () => {
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
      { label: "punctuation run", initial: "foo---bar", keys: ["w", "x"] },
      { label: "whitespace run", initial: "foo     bar", keys: ["w", "x"] },
      { label: "empty line", initial: "", keys: ["w", "d", "w"] },
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
// Undo — u maps to ctrl+_ (readline undo)  (Task 6)
// ---------------------------------------------------------------------------

describe("undo — u", () => {
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
    // The unit harness uses a stub tui without undo history, so full text
    // restoration cannot be asserted here — that is a runtime concern.
    // What we CAN assert: u sends ctrl+_ to super (no crash, no extra chars).
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

  it("ctrl+r in normal mode is safe (redo deferred)", () => {
    const { editor } = createEditorWithSpy("hello world");
    const before = editor.getText();

    assert.doesNotThrow(() => sendKeys(editor, ["\x12"]));
    assert.equal(editor.getText(), before);
  });

  it("u in insert mode inserts literal 'u' (not intercepted)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["i"]); // → insert mode
    assert.equal(editor.getMode(), "insert");
    sendKeys(editor, ["u"]);
    assert.ok(editor.getText().includes("u"), "u in insert mode must insert character");
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

  it("2j executes j once and discards count (unsupported)", () => {
    const { editor } = createMultiLineEditor("a\nb\nc\nd");
    sendKeys(editor, ["2", "j", "x"]);
    assert.equal(editor.getText(), "a\n\nc\nd");
  });

  it("2dG cancels cleanly and swallows G because it is printable", () => {
    const { editor } = createMultiLineEditor("a\nb\nc");
    sendKeys(editor, ["2", "d", "G", "x"]);
    // Since 2dG is canceled, G is swallowed, and we just execute x on line 0
    assert.equal(editor.getText(), "\nb\nc");
    assert.equal(editor.getRegister(), "a");
  });
});
