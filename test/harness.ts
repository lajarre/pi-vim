/**
 * Test harness for ModalEditor integration tests.
 */

import { ModalEditor } from "../index.js";

// Minimal pi-tui stub types — avoids importing the full extension runtime.
export const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
} as unknown as import("@mariozechner/pi-tui").Tui;

export const stubTheme = {
  borderColor: (s: string) => s,
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as import("@mariozechner/pi-tui").Theme;

export const stubKeybindings = {
  matches: () => false,
} as unknown as import("@mariozechner/pi-tui").Keybindings;

/**
 * Send an array of key events to the editor.
 * Each element is one atomic key press (may be a multi-byte escape sequence).
 */
export function sendKeys(editor: ModalEditor, keys: string[]): void {
  for (const key of keys) {
    editor.handleInput(key);
  }
}

/**
 * Create a ModalEditor pre-loaded with `initialText`, positioned in NORMAL
 * mode with cursor at line start.  Returns the editor plus helpers for
 * observing register writes.
 *
 * Flow:
 *   1. Type initialText in INSERT mode (editor starts in insert).
 *   2. Escape → NORMAL mode.
 *   3. Press "0" → cursor to line start.
 */
export function createEditorWithSpy(initialText: string): {
  editor: ModalEditor;
  getRegister: () => string;
  clipboardWrites: string[];
} {
  const clipboardWrites: string[] = [];
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);

  editor.setClipboardFn((text) => clipboardWrites.push(text));

  // Populate buffer in insert mode (editor starts in insert)
  for (const char of initialText) {
    editor.handleInput(char);
  }

  // Escape → NORMAL, then go to line start
  editor.handleInput("\x1b");
  editor.handleInput("0");

  return { editor, getRegister: () => editor.getRegister(), clipboardWrites };
}

/**
 * Create a ModalEditor pre-loaded with multi-line text (use "\n" as separator).
 * Cursor is placed at col 0 of line 0 in NORMAL mode.
 *
 * Useful for testing EOL / newline edge cases.
 */
export function createMultiLineEditor(text: string): {
  editor: ModalEditor;
  clipboardWrites: string[];
} {
  const clipboardWrites: string[] = [];
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn((t) => clipboardWrites.push(t));

  // Type text in insert mode (newlines create new lines)
  for (const char of text) {
    editor.handleInput(char);
  }

  // Escape → normal
  editor.handleInput("\x1b");

  // Navigate to line 0 by pressing k as many times as needed
  const lineCount = text.split("\n").length;
  for (let i = 1; i < lineCount; i++) {
    editor.handleInput("k");
  }

  // Go to col 0
  editor.handleInput("0");

  return { editor, clipboardWrites };
}
