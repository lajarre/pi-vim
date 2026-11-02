import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import installPiVim, { ModalEditor } from "../index.js";
import { setPiVimSettingsReaderForTests } from "../settings.js";
import { getVisualRenderSpan, highlightRenderedTextRange } from "../visual.js";
import {
  createCursorShapeTui,
  createExtensionApiHarness,
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const OPEN = "\x1b[44m";
const CLOSE = "\x1b[49m";
const colorize = (text: string) => `${OPEN}${text}${CLOSE}`;
const plain = (text: string) =>
  stripVTControlCharacters(text.replaceAll(CURSOR_MARKER, ""));
const selected = (text: string) =>
  text
    .split(OPEN)
    .slice(1)
    .map((part) => plain(part.split(CLOSE)[0] ?? ""))
    .join("");

function editorFor(text: string, hardware = true) {
  const tui = createCursorShapeTui({
    terminalWrite: hardware,
    setShowHardwareCursor: hardware,
  });
  const editor = new ModalEditor(tui, stubTheme, stubKeybindings, {
    selectionColorizer: colorize,
    labelColorizers: {
      insert: (s) => `\x1b[32m${s}\x1b[39m`,
      normal: (s) => `\x1b[31m${s}\x1b[39m`,
      visual: (s) => `\x1b[35m${s}\x1b[39m`,
      ex: (s) => s,
    },
  });
  const writes: string[] = [];
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setText(text);
  editor.handleInput("\x1b");
  setInternalCursor(editor, 0);
  editor.focused = true;
  return { editor, tui, writes };
}

function snapshot(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

describe("visual selection render integration", () => {
  for (const grapheme of ["中", "😀", "e\u0301", "👩‍💻"]) {
    for (const hardware of [true, false]) {
      it(`keeps ${grapheme} intact at both edges with a ${hardware ? "hardware" : "software"} cursor`, () => {
        const { editor } = editorFor(`a${grapheme}b`, hardware);
        sendKeys(editor, ["l", "v"]);
        const before = snapshot(editor);
        const row = editor.render(20)[1] ?? "";
        assert.equal(selected(row), grapheme);
        assert.equal(plain(row).trimEnd(), `a${grapheme}b`);
        assert.equal(row.split(CURSOR_MARKER).length, 2);
        assert.deepEqual(snapshot(editor), before);
      });
    }
  }

  it("keeps wide and combining interiors intact in either direction", () => {
    const { editor } = editorFor("a中e\u0301😀z");
    sendKeys(editor, ["v", "3", "l"]);
    const before = snapshot(editor);
    const forward = editor.render(20);
    assert.equal(selected(forward[1] ?? ""), "a中e\u0301😀");
    editor.handleInput("o");
    assert.equal(selected(editor.render(20)[1] ?? ""), "a中e\u0301😀");
    editor.handleInput("o");
    assert.deepEqual(snapshot(editor), before);
  });

  it("clips charwise spans to wrapped rows with padding and a colored footer", () => {
    const { editor } = editorFor("ab中 e\u0301😀 z");
    editor.setPaddingX(1);
    sendKeys(editor, ["l", "v", "$", "h", "h"]);
    const lines = editor.render(8);
    assert.equal(lines.slice(1, -1).map(selected).join(""), "b中 e\u0301😀 ");
    assert.ok(lines.slice(1, -1).every((line) => line.startsWith(" ")));
    assert.ok(lines.every((line) => visibleWidth(line) <= 8));
    assert.ok(!lines[0]?.includes(OPEN));
    assert.ok(!lines.at(-1)?.includes(OPEN));
    assert.ok(lines.at(-1)?.includes("\x1b[35m"));
    assert.equal(plain(lines.at(-1) ?? ""), " VISUAL ");
  });

  it("limits V paint to visible selected rows and preserves scroll borders", () => {
    const text = Array.from({ length: 12 }, (_, i) => `row${i}`).join("\n");
    const { editor, tui } = editorFor(text);
    tui.terminal.rows = 10; // Host minimum is five visible text rows.
    sendKeys(editor, ["V", "8", "j"]);
    const lines = editor.render(24);
    assert.equal(lines.length, 7);
    assert.equal(
      plain(lines[0] ?? "")
        .trimEnd()
        .startsWith("─── ↑ 4 more"),
      true,
    );
    assert.deepEqual(lines.slice(1, -1).map(selected), [
      "row4 ",
      "row5 ",
      "row6 ",
      "row7 ",
      "row8 ",
    ]);
    assert.ok(!lines[0]?.includes(OPEN));
    assert.ok(!lines.at(-1)?.includes(OPEN));
    assert.ok(plain(lines.at(-1) ?? "").includes("V-LINE"));
    tui.terminal.rows = 40;
    assert.equal(editor.render(24).length, 14);
  });

  it("paints empty rows and newline cells, not the remaining line padding", () => {
    const { editor } = editorFor("a\n\nb");
    sendKeys(editor, ["v", "2", "j"]);
    assert.deepEqual(editor.render(16).slice(1, -1).map(selected), [
      "a ",
      " ",
      "b",
    ]);
    editor.handleInput("V");
    assert.deepEqual(editor.render(16).slice(1, -1).map(selected), [
      "a ",
      " ",
      "b ",
    ]);
    const empty = editorFor("").editor;
    empty.handleInput("v");
    assert.equal(selected(empty.render(8)[1] ?? ""), " ");
    const finalEmpty = editorFor("a\n").editor;
    sendKeys(finalEmpty, ["v", "j"]);
    assert.deepEqual(finalEmpty.render(8).slice(1, -1).map(selected), [
      "a ",
      " ",
    ]);
  });

  it("preserves a software cursor at either end and resumes paint after its reset", () => {
    const { editor } = editorFor("abcdef", false);
    sendKeys(editor, ["v", "3", "l", "o"]);
    const row = editor.render(20)[1] ?? "";
    assert.equal(selected(row), "abcd");
    assert.ok(row.includes(`${CURSOR_MARKER}${OPEN}\x1b[7ma`));
    assert.ok(row.includes(`\x1b[0m${OPEN}bcd${CLOSE}`));
    assert.equal(plain(row).trimEnd(), "abcdef");
    editor.handleInput("o");
    const last = editor.render(20)[1] ?? "";
    assert.equal(selected(last), "abcd");
    assert.ok(last.includes(`${CURSOR_MARKER}${OPEN}\x1b[7md${CLOSE}\x1b[0m`));
    assert.ok(!last.includes(`${OPEN}ef`));
  });

  it("keeps resize paint current, with no extra cells at narrow widths", () => {
    const { editor } = editorFor("abc def ghi");
    editor.handleInput("V");
    for (const width of [20, 4, 8, 1, 20]) {
      const lines = editor.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      // Presentation deliberately paints text + one EOL cell, not Vim's
      // full window-width linewise background. See README visual mode.
      assert.equal(
        lines.slice(1, -1).map(selected).join(""),
        width === 1 ? "abc def ghi" : "abc def ghi ",
      );
      assert.ok(!lines.at(-1)?.includes(OPEN));
    }
  });

  for (const size of [4096, 16384]) {
    it(`segments the selection end once per frame on a ${size}-unit wrapped line`, (t) => {
      const text = "x".repeat(size);
      const { editor, writes } = editorFor(text);
      editor.handleInput("v");
      const before = snapshot(editor);
      const segment = Intl.Segmenter.prototype.segment;
      let calls = 0;
      t.mock.method(
        Intl.Segmenter.prototype,
        "segment",
        function (this: Intl.Segmenter, input: string) {
          if (
            input === text &&
            new Error().stack?.includes("getInclusiveEndColumn")
          )
            calls++;
          return segment.call(this, input);
        },
      );
      for (const width of [80, 40, 80]) {
        calls = 0;
        const rows = editor.render(width);
        assert.ok(rows.length > 4);
        assert.equal(
          calls,
          1,
          "wrapped rows must share one prepared selection",
        );
        assert.equal(rows.slice(1, -1).map(selected).join(""), "x");
        assert.deepEqual(snapshot(editor), before);
        assert.deepEqual(writes, []);
      }
    });
  }

  it("does no selection work in insert or normal mode", () => {
    const { editor } = editorFor("abc");
    Object.defineProperty(editor, "renderVisualSelection", {
      value: () => assert.fail("idle paint helper called"),
    });
    Object.defineProperty(editor, "buildVisualLineMap", {
      value: () => assert.fail("idle layout map built"),
    });
    assert.ok(!editor.render(20).some((line) => line.includes(OPEN)));
    editor.handleInput("i");
    assert.ok(!editor.render(20).some((line) => line.includes(OPEN)));
  });

  for (const layout of [
    undefined,
    () => null,
    () => [null],
    () => [{ logicalLine: 0, startCol: -1, length: 3 }],
    () => {
      throw new Error("changed host");
    },
  ]) {
    it(`fails soft with an unavailable layout contract: ${String(layout)}`, () => {
      const { editor } = editorFor("abc");
      editor.handleInput("V");
      const before = snapshot(editor);
      Object.defineProperty(editor, "buildVisualLineMap", { value: layout });
      const lines = editor.render(20);
      assert.equal(plain(lines[1] ?? "").trimEnd(), "abc");
      assert.ok(!lines.some((line) => line.includes(OPEN)));
      assert.deepEqual(snapshot(editor), before);
      editor.handleInput("y");
      assert.equal(editor.getMode(), "normal");
      assert.equal(editor.getRegister(), "abc\n");
    });
  }

  it("paint is transparent to register/clipboard, counts and undo/redo", () => {
    const painted = editorFor("one two three");
    const control = editorFor("one two three");
    for (const key of [
      "v",
      "2",
      "l",
      "y",
      "p",
      "u",
      "\x12",
      "V",
      "\x1b",
      "x",
      "u",
    ]) {
      painted.editor.handleInput(key);
      control.editor.handleInput(key);
      painted.editor.render(8);
      painted.editor.render(20);
      assert.deepEqual(snapshot(painted.editor), snapshot(control.editor));
      assert.deepEqual(painted.writes, control.writes);
    }
  });
});

// Host metadata is a presentation contract, not part of nvim's text oracle.
describe("host cursor marker paint compatibility", () => {
  const fakeStart = "\x1b_pi:fc\x07";
  const fakeEnd = "\x1b_pi:/fc\x07";
  const unmark = (text: string) =>
    text.replaceAll(fakeStart, "").replaceAll(fakeEnd, "");
  const focusedFakeCursor = new RegExp(
    `(${CURSOR_MARKER})${fakeStart}(.*?)(?:${fakeEnd}|$)`,
    "s",
  );
  for (const host of ["0.78", "1.4"]) {
    function wrap(cell: string) {
      return host === "1.4"
        ? `${CURSOR_MARKER}${fakeStart}${cell}${fakeEnd}`
        : `${CURSOR_MARKER}\x1b[7m${cell}\x1b[0m`;
    }
    function check(
      row: string,
      start: number,
      end: number,
      expected: string,
      cell: string,
    ) {
      const result = highlightRenderedTextRange(row, start, end, colorize);
      assert.equal(result.replaceAll(OPEN, "").replaceAll(CLOSE, ""), row);
      assert.equal(selected(unmark(result)), expected);
      if (host === "1.4") {
        assert.equal(
          result.match(focusedFakeCursor)?.[2],
          `${OPEN}${cell}${CLOSE}`,
        );
        assert.ok(
          result.includes(
            `${CURSOR_MARKER}${fakeStart}${OPEN}${cell}${CLOSE}${fakeEnd}`,
          ),
        );
      }
    }
    for (const cursor of [1, 3, 5]) {
      it(`${host}: preserves markers with the cursor at selection offset ${cursor - 1}`, () => {
        const text = "_abcde_";
        const cell = text[cursor] ?? "";
        const row = text.slice(0, cursor) + wrap(cell) + text.slice(cursor + 1);
        check(row, 1, 6, "abcde", cell);
      });
    }
    for (const cursor of [2, 3]) {
      it(`${host}: preserves a cursor beside a wrapped row boundary (${cursor})`, () => {
        const text = "_abcde_";
        for (const [startCol, length] of [
          [0, 3],
          [3, 4],
        ] as const) {
          const span = getVisualRenderSpan(
            "visual",
            { line: 0, col: 1 },
            { line: 0, col: 5 },
            [text],
            { logicalLine: 0, startCol, length },
          );
          assert.ok(span);
          const row = text.slice(startCol, startCol + length);
          const local = cursor - startCol;
          const hasCursor = local >= 0 && local < row.length;
          const cell = row[local] ?? "";
          const marked = hasCursor
            ? row.slice(0, local) + wrap(cell) + row.slice(local + 1)
            : row;
          if (hasCursor)
            check(
              marked,
              span.start,
              span.end,
              row.slice(span.start, span.end),
              cell,
            );
          else
            assert.equal(
              selected(
                highlightRenderedTextRange(
                  marked,
                  span.start,
                  span.end,
                  colorize,
                ),
              ),
              row.slice(span.start, span.end),
            );
        }
      });
    }
  }

  for (const terminator of ["\x07", "\x1b\\"]) {
    it(`skips unknown APC metadata terminated by ${JSON.stringify(terminator)}`, () => {
      const apc = `\x1b_other:metadata${terminator}`;
      assert.equal(
        highlightRenderedTextRange(`a${apc}bc`, 1, 2, colorize),
        `a${apc}${OPEN}b${CLOSE}c`,
      );
    });
  }
  for (const row of [
    "\x1b_unknown",
    "a\x1b_unknown",
    "abc\x1b_unknown",
    "a\x1b_unknown\x1b[",
  ]) {
    it(`leaves an unterminated APC frame unchanged: ${JSON.stringify(row)}`, () => {
      assert.equal(highlightRenderedTextRange(row, 0, 1, colorize), row);
    });
  }
});

describe("extension selection theme fallback", () => {
  it("uses the theme receiver and recovers after a theme replacement", async () => {
    const restore = setPiVimSettingsReaderForTests(() => ({}));
    const pi = createExtensionApiHarness();
    const theme = {
      ...stubTheme,
      available: true,
      color: "\x1b[44m",
      bg(token: string, text: string): string {
        assert.equal(token, "selectedBg");
        if (!this.available) throw new Error("missing background");
        return `${this.color}${text}\x1b[49m`;
      },
    };
    let editor: ModalEditor | undefined;
    try {
      installPiVim(pi);
      await pi.emit("session_start", undefined, {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          theme,
          notify() {},
          setEditorComponent(
            factory: (
              tui: typeof stubTui,
              theme: typeof stubTheme,
              kb: typeof stubKeybindings,
            ) => ModalEditor,
          ) {
            editor = factory(stubTui, stubTheme, stubKeybindings);
          },
        },
      });
      assert.ok(editor);
      editor.setText("abcd");
      sendKeys(editor, ["\x1b", "0", "v", "2", "l"]);
      assert.equal(selected(editor.render(20)[1] ?? ""), "abc");
      theme.available = false;
      assert.ok(editor.render(20)[1]?.includes("\x1b[7mab"));
      theme.available = true;
      theme.color = "\x1b[45m";
      assert.ok(editor.render(20)[1]?.includes("\x1b[45mab"));
      assert.equal(editor.getText(), "abcd");
    } finally {
      await pi.emit("session_shutdown");
      restore();
    }
  });

  for (const bg of [
    undefined,
    "not a function",
    () => {
      throw new Error("Unknown theme background color: selectedBg");
    },
  ]) {
    it(`uses reverse video when selectedBg is unavailable: ${String(bg)}`, async () => {
      const restore = setPiVimSettingsReaderForTests(() => ({}));
      const pi = createExtensionApiHarness();
      const theme = { ...stubTheme, bg };
      let editor: ModalEditor | undefined;
      try {
        installPiVim(pi);
        await pi.emit("session_start", undefined, {
          cwd: process.cwd(),
          hasUI: true,
          ui: {
            theme,
            notify() {},
            setEditorComponent(
              factory: (
                tui: typeof stubTui,
                theme: typeof stubTheme,
                kb: typeof stubKeybindings,
              ) => ModalEditor,
            ) {
              editor = factory(stubTui, stubTheme, stubKeybindings);
            },
          },
        });
        assert.ok(editor);
        editor.setClipboardFn(() => {});
        editor.setText("abcd");
        sendKeys(editor, ["\x1b", "0", "v", "2", "l"]);
        const row = editor.render(20)[1] ?? "";
        assert.ok(row.includes("\x1b[7mab"));
        assert.equal(plain(row).trimEnd(), "abcd");
        assert.equal(editor.getMode(), "visual");
      } finally {
        await pi.emit("session_shutdown");
        restore();
      }
    });
  }
});
