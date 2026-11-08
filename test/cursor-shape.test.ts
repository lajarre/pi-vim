/**
 * Terminal cursor shaping is an intentional non-Vim host surface: DECSCUSR
 * writes/lifecycle use the TUI stub, not the nvim text/cursor/mode oracle.
 * Real cursor glyphs and blinking still require the maintainer TTY QA script.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURSOR_MARKER } from "@earendil-works/pi-tui";

import {
  CURSOR_SHAPE_SEQUENCES,
  hasPromptCursorMarker,
  stripSoftwareCursorAfterMarker,
  stripSoftwareCursorWhenHardwareCursorIsUsed,
} from "../cursor-shape.js";

import vim, { ModalEditor } from "../index.js";
import {
  type CursorShapeSettings,
  resolveCursorShapeSettings,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import {
  createCursorShapeTui,
  createExtensionApiHarness,
  sendKeys,
  stubKeybindings,
  stubTheme,
} from "./harness.js";

function fixture(settings: CursorShapeSettings) {
  const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
  const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
  editor.setCursorShapeSettings(settings);
  editor.focused = true;
  editor.setText("abc");
  return { tui, editor };
}

describe("cursor ownership across editor reconstruction", () => {
  for (const initial of [false, true]) {
    for (const reason of [undefined, "reload", "quit"]) {
      it(`balances two factories from visibility=${initial}, shutdown=${String(reason)}`, async () => {
        const restore = setPiVimSettingsReaderForTests(() => ({}));
        const pi = createExtensionApiHarness();
        type Factory = (
          ...args: ConstructorParameters<typeof ModalEditor>
        ) => ModalEditor;
        let factory: Factory | undefined;
        const tui = createCursorShapeTui({
          initialShowHardwareCursor: initial,
        });
        try {
          vim(pi);
          await pi.emit(
            "session_start",
            {},
            {
              cwd: ".",
              hasUI: true,
              ui: {
                theme: stubTheme,
                notify() {},
                setEditorComponent: (next: Factory) => {
                  factory = next;
                },
              },
            },
          );
          assert.ok(factory);
          factory(tui, stubTheme, stubKeybindings);
          assert.equal(tui.getShowHardwareCursor?.(), true);
          factory(tui, stubTheme, stubKeybindings);
          assert.deepEqual(tui.hardwareCursorValues, [true, initial, true]);
          assert.deepEqual(tui.terminalWrites, ["\x1b[0 q"]);
          await pi.emit("session_shutdown", { reason });
          assert.deepEqual(
            tui.hardwareCursorValues,
            reason === "quit"
              ? [true, initial, true]
              : [true, initial, true, initial],
          );
          assert.equal(
            tui.getShowHardwareCursor?.(),
            reason === "quit" ? true : initial,
          );
          assert.deepEqual(
            tui.terminalWrites,
            reason === "quit"
              ? ["\x1b[0 q", "\x1b[0 q", "\x1b[?25h"]
              : ["\x1b[0 q", "\x1b[0 q"],
          );
          const writes = tui.terminalWrites.slice();
          await pi.emit("session_shutdown", { reason });
          assert.deepEqual(
            tui.terminalWrites,
            writes,
            "cleanup must not run twice",
          );
        } finally {
          await pi.emit("session_shutdown");
          restore();
        }
      });
    }
  }
});

describe("configured cursor shape rendering", () => {
  it("maps all six DEC shapes to their exact sequences", () => {
    assert.deepEqual(CURSOR_SHAPE_SEQUENCES, {
      block: "\x1b[1 q",
      underline: "\x1b[3 q",
      bar: "\x1b[5 q",
      "steady-block": "\x1b[2 q",
      "steady-underline": "\x1b[4 q",
      "steady-bar": "\x1b[6 q",
    });
  });

  it("writes steady shapes at render time without changing the defaults", () => {
    const { tui, editor } = fixture({
      insert: "steady-bar",
      normal: "steady-block",
    });
    editor.render(40);
    sendKeys(editor, ["\x1b"]);
    editor.render(40);
    editor.setCursorShapeSettings({
      insert: "bar",
      normal: "steady-underline",
    });
    editor.render(40);
    assert.deepEqual(tui.terminalWrites, ["\x1b[6 q", "\x1b[2 q", "\x1b[4 q"]);
    const defaults = fixture(resolveCursorShapeSettings(undefined).settings);
    defaults.editor.render(40);
    defaults.editor.handleInput("\x1b");
    defaults.editor.render(40);
    assert.deepEqual(defaults.tui.terminalWrites, ["\x1b[5 q", "\x1b[1 q"]);
  });

  for (const [mode, keys, label] of [
    ["insert", [], " INSERT "],
    ["normal", ["\x1b"], " NORMAL "],
    ["visual", ["\x1b", "v"], " VISUAL "],
    ["visual-line", ["\x1b", "V"], " V-LINE "],
    ["ex", ["\x1b", ":"], " EX :_ "],
  ] as const) {
    it(`uses configured shape in ${mode} without rewriting unchanged renders`, () => {
      const { tui, editor } = fixture({ insert: "block", normal: "underline" });
      sendKeys(editor, [...keys]);
      const lines = editor.render(40);
      editor.render(40);
      assert.deepEqual(tui.terminalWrites, [
        mode === "insert" ? "\x1b[1 q" : "\x1b[3 q",
      ]);
      assert.equal(editor.getMode(), mode === "ex" ? "normal" : mode);
      assert.equal(editor.getText(), "abc");
      assert.ok(lines.at(-1)?.includes(label));
      assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
      assert.ok(
        lines.every(
          (line) => !line.includes("\x1b[3 q") && !line.includes("\x1b[1 q"),
        ),
      );
    });
  }

  it("writes configured insert -> normal -> insert transitions once each", () => {
    const { tui, editor } = fixture({ insert: "underline", normal: "bar" });
    editor.render(40);
    editor.handleInput("\x1b");
    editor.render(40);
    editor.render(40);
    editor.handleInput("i");
    editor.render(40);
    editor.render(40);
    assert.deepEqual(tui.terminalWrites, ["\x1b[3 q", "\x1b[5 q", "\x1b[3 q"]);
  });

  it("does not rewrite identical shapes across mode changes", () => {
    const { tui, editor } = fixture({ insert: "block", normal: "block" });
    for (const key of ["\x1b", "v", "V", "\x1b", ":", "\x1b", "i"]) {
      editor.render(40);
      editor.handleInput(key);
    }
    editor.render(40);
    assert.deepEqual(tui.terminalWrites, ["\x1b[1 q"]);
  });

  it("changes the cache only when a new setting changes the rendered shape", () => {
    const settings: CursorShapeSettings = { insert: "block", normal: "bar" };
    const { tui, editor } = fixture(settings);
    settings.insert = "bar";
    editor.render(40);
    editor.setCursorShapeSettings({ insert: "block", normal: "underline" });
    editor.render(40);
    editor.setCursorShapeSettings({ insert: "underline", normal: "block" });
    editor.render(40);
    assert.deepEqual(tui.terminalWrites, ["\x1b[1 q", "\x1b[3 q"]);
  });

  it("restores the configured shape after hardware cursor ownership is lost", () => {
    const { tui, editor } = fixture({ insert: "underline", normal: "bar" });
    editor.render(40);
    tui.setShowHardwareCursor?.(false);
    editor.render(40);
    editor.render(40);
    assert.deepEqual(tui.terminalWrites, ["\x1b[3 q", "\x1b[3 q"]);
    assert.deepEqual(tui.hardwareCursorValues, [false, true]);
  });

  for (const hasUI of [true, false]) {
    it(`resolves at session start with one warning only when hasUI=${hasUI}`, async () => {
      const restore = setPiVimSettingsReaderForTests(() => ({
        cursorShape: { insert: "block", normal: "invalid" },
      }));
      const warnings: [string, string][] = [];
      const pi = createExtensionApiHarness();
      vim(pi);
      let factory:
        | ((...args: ConstructorParameters<typeof ModalEditor>) => ModalEditor)
        | undefined;
      try {
        await pi.emit(
          "session_start",
          {},
          {
            cwd: ".",
            hasUI,
            ui: {
              theme: stubTheme,
              notify: (message: string, level: string) =>
                warnings.push([message, level]),
              setEditorComponent: (fn: NonNullable<typeof factory>) => {
                factory = fn;
              },
            },
          },
        );
        assert.ok(factory);
        for (let i = 0; i < 2; i++) {
          const tui = createCursorShapeTui();
          const editor = factory(tui, stubTheme, stubKeybindings);
          editor.focused = true;
          editor.render(40);
          editor.handleInput("\x1b");
          editor.render(40);
          assert.deepEqual(tui.terminalWrites, ["\x1b[1 q"]);
        }
        const expected = resolveCursorShapeSettings({
          normal: "invalid",
        }).warning;
        assert.deepEqual(warnings, hasUI ? [[expected, "warning"]] : []);
      } finally {
        await pi.emit("session_shutdown", { reason: "quit" });
        restore();
      }
    });
  }
});

const SW_START = "\x1b[7m";
const RESET = "\x1b[0m";
const RESET27 = "\x1b[27m";

describe("stripSoftwareCursorAfterMarker", () => {
  it("returns the line unchanged when there is no cursor marker", () => {
    assert.equal(stripSoftwareCursorAfterMarker("plain text"), "plain text");
  });

  it("returns the line unchanged when the marker has no software cursor", () => {
    const line = `${CURSOR_MARKER}abc`;
    assert.equal(stripSoftwareCursorAfterMarker(line), line);
  });

  it("leaves 1.4 fake-cursor markers and later reverse-video styling untouched", () => {
    for (const suffix of ["cd", "\x1b[7mcd\x1b[27m"]) {
      const line = `ab${CURSOR_MARKER}\x1b_pi:fc\x07X\x1b_pi:/fc\x07${suffix}`;
      assert.equal(stripSoftwareCursorAfterMarker(line), line);
    }
  });

  it("removes the reverse-video wrapper but keeps the cursor glyph", () => {
    const line = `${CURSOR_MARKER}ab${SW_START}X${RESET}cd`;
    assert.equal(stripSoftwareCursorAfterMarker(line), `${CURSOR_MARKER}abXcd`);
  });

  it("also handles the \\x1b[27m reset variant", () => {
    const line = `${CURSOR_MARKER}${SW_START}Y${RESET27}z`;
    assert.equal(stripSoftwareCursorAfterMarker(line), `${CURSOR_MARKER}Yz`);
  });
});

describe("hasPromptCursorMarker", () => {
  it("is false when no line carries the marker", () => {
    assert.equal(hasPromptCursorMarker(["no", "marker", "here"]), false);
  });

  it("is true when any line carries the marker", () => {
    assert.equal(
      hasPromptCursorMarker(["plain", `${CURSOR_MARKER}here`]),
      true,
    );
  });
});

describe("stripSoftwareCursorWhenHardwareCursorIsUsed", () => {
  it("strips the software cursor in place on the marker line", () => {
    const lines = ["top", `${CURSOR_MARKER}ab${SW_START}X${RESET}cd`];
    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    assert.equal(lines[1], `${CURSOR_MARKER}abXcd`);
    assert.equal(lines[0], "top");
  });

  it("leaves marker-free buffers untouched", () => {
    const lines = ["a", "b"];
    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    assert.deepEqual(lines, ["a", "b"]);
  });

  it("only strips the last marker-bearing line", () => {
    const first = `${CURSOR_MARKER}p${SW_START}P${RESET}q`;
    const last = `${CURSOR_MARKER}r${SW_START}R${RESET}s`;
    const lines = [first, last];
    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    assert.equal(lines[1], `${CURSOR_MARKER}rRs`);
    assert.equal(lines[0], first);
  });
});
