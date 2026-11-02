/**
 * Test harness for ModalEditor integration tests.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";

// Pi 0.78 draws SGR cursors; 1.4 defers APC fake cursors to the compositor.
// Strip only known metadata for display assertions, never arbitrary controls.
export function stripHostCursorMarkers(text: string): string {
  return text
    .replaceAll(hostTui.CURSOR_MARKER, "")
    .replaceAll("\x1b_pi:fc\x07", "")
    .replaceAll("\x1b_pi:/fc\x07", "");
}

export const hostUsesFakeCursor = "renderFakeCursor" in hostTui;
export function hostFakeCursor(text: string): string {
  return hostUsesFakeCursor
    ? `\x1b_pi:fc\x07${text}\x1b_pi:/fc\x07`
    : `\x1b[7m${text}\x1b[0m`;
}

import { ModalEditor } from "../index.js";

type ModalEditorConstructorArgs = ConstructorParameters<typeof ModalEditor>;

// Minimal pi-tui stub types — avoids importing the full extension runtime.
export const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
} as unknown as ModalEditorConstructorArgs[0];

export type CursorShapeTuiOptions = {
  terminalWrite?: boolean;
  getShowHardwareCursor?: boolean;
  setShowHardwareCursor?: boolean;
  initialShowHardwareCursor?: boolean;
};

export type CursorShapeTuiShape = {
  requestRender(): void;
  terminal: {
    rows: number;
    cols: number;
    write?: (data: string) => void;
  };
  getShowHardwareCursor?: () => boolean;
  setShowHardwareCursor?: (show: boolean) => void;
};

export type CursorShapeTuiStub = ModalEditorConstructorArgs[0] &
  CursorShapeTuiShape & {
    terminalWrites: string[];
    hardwareCursorValues: boolean[];
    getShowHardwareCursorCalls: number;
  };

export function createCursorShapeTui(
  options: CursorShapeTuiOptions = {},
): CursorShapeTuiStub {
  const terminalWrites: string[] = [];
  const hardwareCursorValues: boolean[] = [];
  let showHardwareCursor = options.initialShowHardwareCursor ?? false;
  let getShowHardwareCursorCalls = 0;

  const tui = {
    requestRender() {},
    terminal: { rows: 40, cols: 120 },
    terminalWrites,
    hardwareCursorValues,
    get getShowHardwareCursorCalls() {
      return getShowHardwareCursorCalls;
    },
  } as CursorShapeTuiStub;

  if (options.terminalWrite !== false) {
    tui.terminal.write = (data: string) => {
      terminalWrites.push(data);
    };
  }

  if (options.getShowHardwareCursor !== false) {
    tui.getShowHardwareCursor = () => {
      getShowHardwareCursorCalls++;
      return showHardwareCursor;
    };
  }

  if (options.setShowHardwareCursor !== false) {
    tui.setShowHardwareCursor = (show: boolean) => {
      showHardwareCursor = show;
      hardwareCursorValues.push(show);
    };
  }

  return tui;
}

export type ExtensionApiHarness = ExtensionAPI & {
  handlersFor(event: string): ExtensionHandlerStub[];
  emit(event: string, payload?: unknown, ctx?: unknown): Promise<unknown[]>;
  eventBusEmissions(): Array<{ event: string; data: unknown }>;
  /** Stub the extension/prompt/skill commands `pi.getCommands()` reports. */
  setCommands(names: readonly string[]): void;
};

type ExtensionHandlerStub = (event: unknown, ctx: unknown) => unknown;
type EventBusHandlerStub = (data: unknown) => unknown;

export function createExtensionApiHarness(): ExtensionApiHarness {
  const handlers = new Map<string, ExtensionHandlerStub[]>();
  const eventBusHandlers = new Map<string, EventBusHandlerStub[]>();
  const eventBusEmissions: Array<{ event: string; data: unknown }> = [];
  let commands: Array<{ name: string }> = [];

  const harness = {
    getCommands(): Array<{ name: string }> {
      return commands;
    },
    setCommands(names: readonly string[]): void {
      commands = names.map((name) => ({ name }));
    },
    events: {
      on(event: string, handler: EventBusHandlerStub): void {
        const eventHandlers = eventBusHandlers.get(event) ?? [];
        eventHandlers.push(handler);
        eventBusHandlers.set(event, eventHandlers);
      },
      emit(event: string, data: unknown): boolean {
        eventBusEmissions.push({ event, data });
        for (const handler of eventBusHandlers.get(event) ?? []) {
          handler(data);
        }
        return true;
      },
    },
    on(event: string, handler: ExtensionHandlerStub): void {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    handlersFor(event: string): ExtensionHandlerStub[] {
      return [...(handlers.get(event) ?? [])];
    },
    async emit(
      event: string,
      payload?: unknown,
      ctx?: unknown,
    ): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
    eventBusEmissions(): Array<{ event: string; data: unknown }> {
      return [...eventBusEmissions];
    },
  };

  return harness as unknown as ExtensionApiHarness;
}

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

export function setInternalCursor(
  editor: ModalEditor,
  cursorCol: number,
  cursorLine: number = 0,
): void {
  const internal = editor as unknown as {
    state?: { cursorLine?: number; cursorCol?: number };
    preferredVisualCol?: number | null;
    lastAction?: string | null;
    tui?: { requestRender?: () => void };
  };

  if (!internal.state) {
    throw new Error("ModalEditor test internal state unavailable");
  }

  internal.state.cursorLine = cursorLine;
  internal.state.cursorCol = cursorCol;
  internal.preferredVisualCol = null;
  internal.lastAction = null;
  internal.tui?.requestRender?.();
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
  editor.setQuitFn(() => {
    quitCalls++;
  });
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
    get quitCalls() {
      return quitCalls;
    },
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
  editor.setQuitFn(() => {
    quitCalls++;
  });
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
    get quitCalls() {
      return quitCalls;
    },
    notifications,
  };
}
