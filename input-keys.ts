import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getLineGraphemes } from "./motions.js";

// Keyboard-input classification predicates. Pure functions over the raw
// input chunk a terminal delivers to the editor — no editor state. Shared
// by the EX mini-mode, insert, and normal-mode dispatch paths.

// Snapshot the public editor-factory manager, not the TUI singleton (which can
// be a different package instance). /reload installs a new editor and snapshot.
export function createCursorBindingResolver(
  keybindings: Pick<KeybindingsManager, "getKeys">,
): (data: string) => "h" | "j" | "k" | "l" | undefined {
  // Implemented Vim controls keep their modal meanings, not host cursor remaps.
  // Ctrl-H still takes the fixed Backspace/h path below. Keep this list explicit.
  const vimControls = new Set([
    "ctrl+b",
    "ctrl+d",
    "ctrl+f",
    "ctrl+u",
    "ctrl+h",
    "ctrl+r",
  ]);
  const bindings = (
    [
      ["tui.editor.cursorUp", "k"],
      ["tui.editor.cursorDown", "j"],
      ["tui.editor.cursorRight", "l"],
      ["tui.editor.cursorLeft", "h"],
    ] as const
  ).flatMap(([action, motion]) =>
    keybindings
      .getKeys(action)
      .filter((key) => !vimControls.has(key))
      .map((key) => ({ key, motion })),
  );
  return (data) =>
    isBackspaceLikeInput(data)
      ? "h"
      : bindings.find(({ key }) => matchesKey(data, key))?.motion;
}

export function isEscapeLikeInput(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
}

export function isEnterLikeInput(data: string): boolean {
  return (
    data === "\r" ||
    data === "\n" ||
    matchesKey(data, "enter") ||
    matchesKey(data, "return")
  );
}

export function isBackspaceLikeInput(data: string): boolean {
  return (
    data === "\x7f" ||
    data === "\x08" ||
    matchesKey(data, "backspace") ||
    matchesKey(data, "ctrl+h")
  );
}

export function isPrintableChunk(data: string): boolean {
  if (data.length === 0) return false;
  for (const char of data) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127)
      return false;
  }
  return true;
}

export function isPrintableInput(data: string): boolean {
  return isPrintableChunk(data) && getLineGraphemes(data).length === 1;
}

export function isDigit(data: string): boolean {
  return data.length === 1 && data >= "0" && data <= "9";
}

export function isCountStarter(data: string): boolean {
  return data.length === 1 && data >= "1" && data <= "9";
}
