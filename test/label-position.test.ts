/**
 * Intentional non-Vim surface: Pi border label placement, not Vim statusline
 * emulation. No input semantics change. Host 1.0 border rows are fixtures;
 * wrapped/scrolling integration runs on the installed host.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { ModalEditor } from "../index.js";
import { fitModeLabel } from "../mode-label.js";
import type { LabelPosition, SurfaceSync } from "../settings.js";
import {
  createCursorShapeTui,
  hostFakeCursor,
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const plain = (s: string) =>
  stripVTControlCharacters(s.replaceAll(CURSOR_MARKER, ""));
const fg = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[39m`;
const reverse = (s: string) => `\x1b[7m${s}\x1b[27m`;
const modeColors = { insert: 32, normal: 31, visual: 35, ex: 33 };
const borderColorizers = {
  insert: fg(32),
  normal: fg(31),
  visual: fg(35),
  ex: fg(33),
};
const labelColorizers = Object.fromEntries(
  Object.entries(modeColors).map(([mode, code]) => [
    mode,
    (s: string) => reverse(fg(code)(s)),
  ]),
) as typeof borderColorizers;
const all = (policy: SurfaceSync) => ({
  insert: policy,
  normal: policy,
  visual: policy,
  ex: policy,
});

function editorFor(position: LabelPosition, policy: SurfaceSync = "mode") {
  const tui = createCursorShapeTui();
  const editor = new ModalEditor(tui, stubTheme, stubKeybindings, {
    labelPosition: position,
    labelColorizers,
    borderColorizers,
    borderSync: all("host"),
    labelSync: all(policy),
    labelTransform: reverse,
    offBorderColor: fg(34),
    selectionColorizer: (s) => `\x1b[44m${s}\x1b[49m`,
  });
  editor.borderColor = fg(34);
  editor.focused = true;
  editor.setText("abcd");
  const writes: string[] = [];
  editor.setClipboardFn((s) => writes.push(s));
  editor.setClipboardReadFn(() => null);
  return { editor, tui, writes };
}

// Interpret the SGR subset used by these fixtures, asserting actual cell paint
// rather than merely the presence of a color escape somewhere in the row.
function cells(row: string) {
  let foreground = 0;
  let reversed = false;
  const result: { text: string; foreground: number; reversed: boolean }[] = [];
  const token = new RegExp(
    `${String.fromCharCode(27)}\\[([0-9;]*)m|([^\x1b])`,
    "gu",
  );
  for (const match of row.matchAll(token)) {
    if (match[1] !== undefined) {
      for (const code of match[1].split(";").map(Number)) {
        if (code === 0) {
          foreground = 0;
          reversed = false;
        } else if (code === 7) reversed = true;
        else if (code === 27) reversed = false;
        else if (code === 39) foreground = 0;
        else if (code >= 30 && code <= 37) foreground = code;
      }
    } else if (match[2]) {
      result.push({ text: match[2], foreground, reversed });
    }
  }
  return result;
}

function state(editor: ModalEditor) {
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

describe("mode label positions", () => {
  for (const position of ["bottom-right", "top-left"] as const) {
    it(`${position}: paints all modes and pending commands, leaving other rows alone`, () => {
      const { editor, writes } = editorFor(position);
      for (const [keys, label, color] of [
        [[], " INSERT ", 32],
        [["\x1b", "0"], " NORMAL ", 31],
        [["d"], " NORMAL d_ ", 31],
        [["\x1b", ":", "q"], " EX :q_ ", 33],
        [["\x1b", "v"], " VISUAL ", 35],
        [["V"], " V-LINE ", 35],
      ] as const) {
        sendKeys(editor, [...keys]);
        const before = state(editor);
        const host = CustomEditor.prototype.render.call(editor, 32);
        const rows = editor.render(32);
        const row = position === "top-left" ? 0 : rows.length - 1;
        const col = position === "top-left" ? 0 : 32 - label.length;
        assert.equal(rows.length, host.length);
        assert.equal(
          plain(rows[row] ?? "").slice(col, col + label.length),
          label,
        );
        assert.equal(
          rows[position === "top-left" ? rows.length - 1 : 0],
          host[position === "top-left" ? host.length - 1 : 0],
        );
        const painted = cells(rows[row] ?? "");
        assert.deepEqual(
          painted.slice(col, col + label.length),
          [...label].map((text) => ({
            text,
            foreground: color,
            reversed: true,
          })),
        );
        assert.ok(
          painted
            .filter((_, i) => i < col || i >= col + label.length)
            .every((cell) => cell.foreground === 34 && !cell.reversed),
        );
        assert.deepEqual(state(editor), before);
        assert.deepEqual(editor.render(32), rows); // cached frame
        for (let width = 1; width <= 16; width++) {
          const narrowHost = CustomEditor.prototype.render.call(editor, width);
          const narrow = editor.render(width);
          const fitted = plain(fitModeLabel(label, width));
          const target =
            narrow[position === "top-left" ? 0 : narrow.length - 1] ?? "";
          assert.ok(visibleWidth(target) <= width);
          // At width 1 the 0.78 host can overflow its own EOL cursor cell;
          // label positioning must not alter those text rows to compensate.
          assert.deepEqual(
            narrow.slice(1, -1).map(plain),
            narrowHost.slice(1, -1).map(plain),
          );
          assert.ok(
            position === "top-left"
              ? plain(target).startsWith(fitted)
              : plain(target).endsWith(fitted),
          );
          assert.deepEqual(state(editor), before);
        }
      }
      assert.deepEqual(writes, []);
    });

    it(`${position}: fits long Unicode EX labels through widths 1–24 and resizes back`, () => {
      const { editor } = editorFor(position);
      sendKeys(editor, ["\x1b", ":", ..."very-long-中e\u0301👩‍💻-command"]);
      const before = state(editor);
      const raw = " EX :very-long-中e\u0301👩‍💻-command_ ";
      for (const width of [
        80,
        ...Array.from({ length: 24 }, (_, i) => 24 - i),
        80,
      ]) {
        const rows = editor.render(width);
        const label = plain(fitModeLabel(raw, width));
        const row = rows[position === "top-left" ? 0 : rows.length - 1] ?? "";
        assert.ok(rows.every((s) => visibleWidth(s) <= width));
        assert.ok(
          position === "top-left"
            ? plain(row).startsWith(label)
            : plain(row).endsWith(label),
        );
        assert.deepEqual(state(editor), before);
      }
    });

    for (const policy of ["host", "thinking"] as const) {
      it(`${position}: refreshes ${policy} label paint and source border color on cache hits`, () => {
        const { editor } = editorFor(position, policy);
        for (const hostColor of [34, 36, 34]) {
          editor.borderColor = fg(hostColor);
          for (let i = 0; i < 2; i++) {
            const rows = editor.render(24);
            const row =
              rows[position === "top-left" ? 0 : rows.length - 1] ?? "";
            const labelCells = cells(row).filter((c) => c.reversed);
            assert.equal(labelCells.map((c) => c.text).join(""), " INSERT ");
            assert.ok(
              labelCells.every(
                (c) =>
                  c.foreground ===
                  (policy === "thinking" && hostColor === 34 ? 32 : hostColor),
              ),
            );
            assert.ok(
              cells(row)
                .filter((c) => !c.reversed)
                .every((c) => c.foreground === hostColor),
            );
          }
        }
      });
    }

    it(`${position}: refreshes label colors even when the host row is unchanged`, () => {
      let color = 32;
      const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
        labelPosition: position,
        labelColorizers: {
          ...labelColorizers,
          insert: (s) => reverse(fg(color)(s)),
        },
      });
      const first = editor.render(24);
      color = 36;
      const next = editor.render(24);
      assert.notDeepEqual(next, first);
      assert.ok(
        next[position === "top-left" ? 0 : next.length - 1]?.includes(
          "\x1b[36m INSERT ",
        ),
      );
    });
  }

  it("preserves borderSync mode paint after the top-left label's resets", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
      labelPosition: "top-left",
      labelColorizers,
      borderColorizers,
      borderSync: all("mode"),
      labelSync: all("host"),
      labelTransform: reverse,
    });
    editor.borderColor = fg(36);
    sendKeys(editor, ["\x1b"]);
    const row = cells(editor.render(24)[0] ?? "");
    assert.ok(row.slice(0, 8).every((c) => c.foreground === 36 && c.reversed));
    assert.ok(row.slice(8).every((c) => c.foreground === 31 && !c.reversed));
  });

  it("keeps wrapped visual rows, cursor markers and scroll indicators in place", () => {
    const { editor, tui } = editorFor("top-left");
    tui.terminal.rows = 10;
    editor.setText(
      Array.from({ length: 12 }, (_, i) => `row${i} ${"ab ".repeat(12)}`).join(
        "\n",
      ),
    );
    sendKeys(editor, ["\x1b", "g", "g", "V", "G"]);
    for (const width of [32, 24, 20, 32]) {
      const host = CustomEditor.prototype.render.call(editor, width);
      const before = state(editor);
      const rows = editor.render(width);
      const indicator = plain(host[0] ?? "").match(/↑ \d+ more/);
      assert.ok(indicator);
      assert.ok(plain(rows[0] ?? "").includes(indicator[0]));
      assert.equal(
        plain(rows[0] ?? "").indexOf(indicator[0]),
        plain(host[0] ?? "").indexOf(indicator[0]),
      );
      assert.ok(rows.slice(1, -1).some((row) => row.includes("\x1b[44m")));
      assert.deepEqual(
        rows.slice(1, -1).map(plain),
        host.slice(1, -1).map(plain),
      );
      assert.equal(
        rows.join("").split(CURSOR_MARKER).length,
        host.join("").split(CURSOR_MARKER).length,
      );
      assert.equal(rows.length, host.length);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.deepEqual(state(editor), before);
    }
    setInternalCursor(editor, 0, 0);
    assert.ok(plain(editor.render(32)[0] ?? "").startsWith(" V-LINE "));
  });

  it("keeps the old last-row width cap when moving the label off a scroll footer", () => {
    const { editor, tui } = editorFor("top-left");
    tui.terminal.rows = 10;
    editor.setText("abcdef ghi\n".repeat(12));
    editor.handleInput("\x1b");
    for (const line of [0, 4, 10]) {
      setInternalCursor(editor, 0, line);
      for (const width of [1, 2, 3, 4, 8, 12, 16, 24]) {
        const host = CustomEditor.prototype.render.call(editor, width);
        const before = state(editor);
        const rows = editor.render(width);
        assert.ok(rows.every((row) => visibleWidth(row) <= width));
        assert.equal(rows.length, host.length);
        assert.deepEqual(
          rows.slice(1, -1).map(plain),
          host.slice(1, -1).map(plain),
        );
        assert.equal(
          plain(rows.at(-1) ?? ""),
          plain(host.at(-1) ?? "").slice(0, width),
        );
        assert.deepEqual(state(editor), before);
        assert.deepEqual(editor.render(width), rows);
      }
    }
  });

  it("preserves left/centered/truncated indicator fixtures and whole-row SGR runs", (t) => {
    const { editor } = editorFor("top-left");
    const fixtures = [
      "─── ↑ 12 more ───────────────────",
      `${"─".repeat(34)} ↑ 12 more ${"─".repeat(35)}`, // pi-tui 1.0, width 80
      "──── ↑ 12 more ────", // centered, both gaps shorter than label
      "─── ↑ 123...", // narrow 0.78 / 1.0 indicator
      "...", // indicator fills entire row
      ".",
    ];
    for (const source of fixtures) {
      const width = visibleWidth(source);
      const host = [fg(34)(source), "x", fg(34)("─".repeat(width))];
      const render = t.mock.method(CustomEditor.prototype, "render", () => [
        ...host,
      ]);
      try {
        const rows = editor.render(width);
        const row = rows[0] ?? "";
        assert.equal(rows.length, host.length);
        assert.deepEqual(rows.slice(1), host.slice(1));
        assert.equal(visibleWidth(row), width);
        // Every non-border indicator cell survives at its original column.
        for (let col = 0; col < source.length; col++) {
          if (source[col] !== "─") assert.equal(plain(row)[col], source[col]);
        }
        const painted = cells(row);
        assert.ok(
          painted.filter((c) => c.reversed).every((c) => c.foreground === 32),
        );
        assert.ok(
          painted.filter((c) => !c.reversed).every((c) => c.foreground === 34),
        );
        if (width === 80) assert.ok(plain(row).startsWith(" INSERT "));
        if (source.startsWith("─── ↑ 12 more "))
          assert.ok(plain(row).startsWith("─── ↑ 12 more  INSERT "));
        assert.deepEqual(editor.render(width), rows);
      } finally {
        render.mock.restore();
      }
    }
  });

  it("leaves autocomplete rows untouched in top-left mode, including a short last row", (t) => {
    const rows = [
      fg(34)("─".repeat(24)),
      "text",
      fg(34)("─".repeat(24)),
      "one",
      "x",
    ];
    t.mock.method(CustomEditor.prototype, "render", () => [...rows]);
    const { editor } = editorFor("top-left");
    assert.deepEqual(editor.render(24).slice(1), rows.slice(1));
    const bottom = editorFor("bottom-right").editor;
    assert.equal(plain(bottom.render(24).at(-1) ?? ""), " INSERT ");
  });

  it("accepts an empty host render without introducing rows", (t) => {
    t.mock.method(CustomEditor.prototype, "render", () => []);
    for (const position of ["bottom-right", "top-left"] as const) {
      assert.deepEqual(editorFor(position).editor.render(1), []);
    }
  });

  it("does not affect edits, counts, clipboard, registers or undo/redo", () => {
    const top = editorFor("top-left");
    const bottom = editorFor("bottom-right");
    for (const key of [
      "\x1b",
      "0",
      "2",
      "x",
      "u",
      "\x12",
      "u",
      "v",
      "l",
      "y",
      "p",
      "u",
      "\x12",
      "i",
      "z",
      "\x1b",
      "u",
      "\x12",
    ]) {
      for (const { editor } of [top, bottom]) {
        editor.handleInput(key);
        editor.render(8);
        editor.render(24);
      }
      assert.deepEqual(state(top.editor), state(bottom.editor));
      assert.deepEqual(top.writes, bottom.writes);
    }
  });
});

describe("bottom-right byte compatibility", () => {
  // Captured from base 46b1f047b3dae17a54ef1dd567249baf06bc6e3c,
  // pi-tui 0.78.0, before changing the overlay. Literal ANSI bytes are part
  // of the assertion, not just stripped display text. Only cursor bytes use
  // the installed host's grammar: 0.78 SGR versus 1.4 fake-cursor APCs.
  for (const labelPosition of [undefined, "bottom-right"] as const) {
    it(`preserves base snapshots with ${labelPosition ?? "omitted"} position`, () => {
      const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
        labelPosition,
      });
      editor.setText("abc");
      assert.deepEqual(editor.render(16), [
        "────────────────",
        `abc${hostFakeCursor(" ")}            `,
        "────────\x1b[0m INSERT ",
      ]);
      sendKeys(editor, ["\x1b", "0"]);
      assert.deepEqual(editor.render(16), [
        "────────────────",
        `${hostFakeCursor("a")}bc             `,
        "────────\x1b[0m NORMAL ",
      ]);
      editor.handleInput("d");
      assert.deepEqual(editor.render(10), [
        "──────────",
        `${hostFakeCursor("a")}bc       `,
        " NORMAL … ",
      ]);
      sendKeys(editor, ["\x1b", ":", ..."abcdef"]);
      assert.deepEqual(editor.render(8), [
        "────────",
        `${hostFakeCursor("a")}bc     `,
        " EX …f_ ",
      ]);
      const colored = new ModalEditor(
        stubTui,
        { ...stubTheme, borderColor: fg(34) },
        stubKeybindings,
        { labelPosition, labelColorizers },
      );
      colored.setText("x");
      // 0.78 colors each border glyph; 1.4's border methods color one row.
      const rowBorders = "renderTopBorder" in CustomEditor.prototype;
      assert.deepEqual(colored.render(12), [
        rowBorders ? fg(34)("─".repeat(12)) : "\x1b[34m─\x1b[39m".repeat(12),
        `x${hostFakeCursor(" ")}          `,
        (rowBorders
          ? "\x1b[34m────"
          : `${"\x1b[34m─\x1b[39m".repeat(3)}\x1b[34m─`) +
          "\x1b[0m\x1b[7m\x1b[32m INSERT \x1b[39m\x1b[27m",
      ]);
    });
  }
});
