import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after } from "node:test";
import type { KeybindingsManager as PiKeybindingsManager } from "@earendil-works/pi-coding-agent";
import { ModalEditor } from "../index.js";
import { sendKeys, setInternalCursor, stubTheme, stubTui } from "./harness.js";

// Actual host defaults and its TUI singleton, not user config or a fake
// matches implementation. These internal module paths are test-only seams.
const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
export const { KeybindingsManager } = (await import(
  new URL("./core/keybindings.js", hostEntry).href
)) as {
  KeybindingsManager: new (
    bindings?: Record<string, string | string[]>,
  ) => PiKeybindingsManager;
};
export const hostTui = (await import(
  createRequire(hostEntry).resolve("@earendil-works/pi-tui")
)) as typeof import("@earendil-works/pi-tui");
const originalKeybindings = hostTui.getKeybindings();
after(() => hostTui.setKeybindings(originalKeybindings));

export const APP_KEYS = [
  {
    name: "Ctrl-P",
    raw: "\x10",
    kitty: "\x1b[112;5u",
    action: "app.model.cycleForward",
  },
  {
    name: "Ctrl-G",
    raw: "\x07",
    kitty: "\x1b[103;5u",
    action: "app.editor.external",
  },
  {
    name: "Ctrl-T",
    raw: "\x14",
    kitty: "\x1b[116;5u",
    action: "app.thinking.toggle",
  },
  { name: "Ctrl-C", raw: "\x03", kitty: "\x1b[99;5u", action: "app.clear" },
  {
    name: "Ctrl-L",
    raw: "\x0c",
    kitty: "\x1b[108;5u",
    action: "app.model.select",
  },
  {
    name: "Shift-Tab",
    raw: "\x1b[Z",
    kitty: "\x1b[9;2u",
    action: "app.thinking.cycle",
  },
] as const;

function internals(editor: ModalEditor) {
  return editor as unknown as {
    historyIndex: number;
    undoStack: { stack: unknown[] };
    redoStack: unknown[];
    lastRepeatableCommand: unknown;
    visualAnchor: unknown;
    pendingExCommand: string | null;
    pendingMotion: unknown;
    pendingTextObject: unknown;
    pendingOperator: unknown;
    pendingReplace: boolean;
    pendingG: boolean;
    pendingZ: boolean;
    prefixCount: string;
    operatorCount: string;
    pendingGCount: string;
  };
}

export function fixture(setup: readonly string[], bindings = {}) {
  const kb = new KeybindingsManager(bindings);
  hostTui.setKeybindings(kb);
  const editor = new ModalEditor(stubTui, stubTheme, kb);
  const writes: string[] = [];
  const fired: string[] = [];
  const forwarded: string[] = [];
  const submitted: string[] = [];
  editor.setClipboardFn((text) => writes.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setText("alpha\nbravo\ncider\ndelta\neagle");
  // Seed redo and dot: harmless chords must not invalidate either history.
  sendKeys(editor, ["\x1b", "i", "X", "\x1b", "u"]);
  setInternalCursor(editor, 2, 2);
  editor.setRegister("keep\n");
  editor.addToHistory("older prompt");
  editor.addToHistory("newer prompt");
  for (const { action } of APP_KEYS)
    editor.onAction(action, () => fired.push(action));
  editor.onAction("app.interrupt", () => fired.push("app.interrupt"));
  editor.onAction("app.exit", () => fired.push("app.exit"));
  editor.onAction("app.suspend", () => fired.push("app.suspend"));
  editor.onSubmit = (text) => submitted.push(text);
  editor.onExtensionShortcut = (key) => {
    forwarded.push(key);
    return false;
  };
  if (setup[0] === ":") {
    sendKeys(editor, [":", "ex-a", "\r", ":", "ex-b", "\r"]);
  }
  sendKeys(editor, [...setup]);
  const state = internals(editor);
  const snapshot = () =>
    structuredClone({
      text: editor.getText(),
      cursor: editor.getCursor(),
      mode: editor.getMode(),
      register: editor.getRegister(),
      writes,
      historyIndex: state.historyIndex,
      undo: state.undoStack.stack,
      redo: state.redoStack,
      repeat: state.lastRepeatableCommand,
      anchor: state.visualAnchor,
      ex: state.pendingExCommand,
    });
  return { editor, kb, state, snapshot, fired, forwarded, submitted };
}

export function assertNoPending(state: ReturnType<typeof internals>) {
  assert.equal(state.pendingMotion, null);
  assert.equal(state.pendingTextObject, null);
  assert.equal(state.pendingOperator, null);
  assert.equal(state.pendingReplace, false);
  assert.equal(state.pendingG, false);
  assert.equal(state.pendingZ, false);
  assert.equal(state.prefixCount, "");
  assert.equal(state.operatorCount, "");
  assert.equal(state.pendingGCount, "");
}
