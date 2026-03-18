/**
 * Test harness for ModalEditor integration tests.
 */

import { ModalEditor } from "../index.js";

type ModalEditorConstructorArgs = ConstructorParameters<typeof ModalEditor>;

// Minimal pi-tui stub types — avoids importing the full extension runtime.
export const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
} as unknown as ModalEditorConstructorArgs[0];

export const stubTheme = {
  borderColor: (s: string) => s,
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as ModalEditorConstructorArgs[1];

export const stubKeybindings = {
  matches: () => false,
} as unknown as ModalEditorConstructorArgs[2];

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
 * mode with cursor at line start. Returns the editor plus clipboard spy data.
 *
 * Flow:
 *   1. Type initialText in INSERT mode (editor starts in insert).
 *   2. Escape → NORMAL mode.
 *   3. Press "0" → cursor to line start.
 */
export function createEditorWithSpy(initialText: string): {
  editor: ModalEditor;
  clipboardWrites: string[];
  quitCalls: number;
  notifications: string[];
} {
  const clipboardWrites: string[] = [];
  const notifications: string[] = [];
  let quitCalls = 0;
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);

  editor.setClipboardFn((text) => clipboardWrites.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setQuitFn(() => { quitCalls++; });
  editor.setNotifyFn((message) => notifications.push(message));

  // Populate buffer in insert mode (editor starts in insert)
  for (const char of initialText) {
    editor.handleInput(char);
  }

  // Escape → NORMAL, then go to line start
  editor.handleInput("\x1b");
  editor.handleInput("0");

  return {
    editor,
    clipboardWrites,
    get quitCalls() { return quitCalls; },
    notifications,
  };
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
  quitCalls: number;
  notifications: string[];
} {
  const clipboardWrites: string[] = [];
  const notifications: string[] = [];
  let quitCalls = 0;
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn((t) => clipboardWrites.push(t));
  editor.setClipboardReadFn(() => null);
  editor.setQuitFn(() => { quitCalls++; });
  editor.setNotifyFn((message) => notifications.push(message));

  // Type text in insert mode (newlines create new lines)
  for (const char of text) {
    editor.handleInput(char);
  }

  // Escape → normal, then position at line 0 / col 0 directly so the
  // fixture doesn't depend on navigation behavior under test.
  editor.handleInput("\x1b");
  const internal = editor as unknown as {
    state?: { cursorLine?: number; cursorCol?: number };
    preferredVisualCol?: number | null;
    lastAction?: string | null;
    tui?: { requestRender?: () => void };
  };
  if (internal.state) {
    internal.state.cursorLine = 0;
    internal.state.cursorCol = 0;
  }
  internal.lastAction = null;
  internal.preferredVisualCol = null;
  internal.tui?.requestRender?.();

  return {
    editor,
    clipboardWrites,
    get quitCalls() { return quitCalls; },
    notifications,
  };
}
