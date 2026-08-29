/**
 * Integration tests for ModalEditor key sequences.
 *
 * Smoke matrix: ~30+ scenarios covering the full command surface.
 * Table-driven style used wherever the pattern is uniform; explicit `it`
 * blocks where state inspection requires nuance.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildClipboardReadHelperSource,
  buildClipboardWriteHelperSource,
} from "../clipboard-mirror.js";
import installPiVim, {
  ModalEditor,
  setModeChangeCommandRunnerForTests,
} from "../index.js";
import type { WordMotionClass } from "../motions.js";
import {
  type PiVimSettings,
  type SurfaceSync,
  type SurfaceSyncMap,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import type { Mode } from "../types.js";
import type {
  WordMotionDirection,
  WordMotionTarget,
} from "../word-boundary-cache.js";
import {
  createCursorShapeTui,
  createEditorWithSpy,
  createExtensionApiHarness,
  createMultiLineEditor,
  sendKeys,
  setInternalCursor,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ModalEditorWordBoundaryCacheInternals = {
  tryFindTarget(
    line: string,
    col: number,
    direction: WordMotionDirection,
    target: WordMotionTarget,
    semanticClass?: WordMotionClass,
  ): number | null;
};

type ModalEditorTestInternals = {
  tryFindWordTargetLineLocal?: (
    direction: WordMotionDirection,
    target: WordMotionTarget,
    semanticClass?: WordMotionClass,
  ) => number | null;
  findWordTargetInText(
    text: string,
    abs: number,
    direction: "forward" | "backward",
    target: "start" | "end",
    count?: number,
    semanticClass?: WordMotionClass,
  ): number;
  wordBoundaryCache: ModalEditorWordBoundaryCacheInternals;
  state?: unknown;
  pushUndoSnapshot?: (() => void) | undefined;
};

type FindWordTargetInTextArgs = Parameters<
  ModalEditorTestInternals["findWordTargetInText"]
>;
type TryFindTargetArgs = Parameters<
  ModalEditorWordBoundaryCacheInternals["tryFindTarget"]
>;

type EditorFactory = (
  tui: ConstructorParameters<typeof ModalEditor>[0],
  theme: ConstructorParameters<typeof ModalEditor>[1],
  keybindings: ConstructorParameters<typeof ModalEditor>[2],
) => ModalEditor;
type Theme = ConstructorParameters<typeof ModalEditor>[1];

type NotificationCall = { message: string; type: string };
type ThemeFgCall = { token: string; text: string };

function getRawEditor(editor: ModalEditor): ModalEditorTestInternals {
  return editor as unknown as ModalEditorTestInternals;
}

const INSERT_CURSOR_SHAPE = "\x1b[5 q";
const BLOCK_CURSOR_SHAPE = "\x1b[1 q";
const RESET_CURSOR_SHAPE = "\x1b[0 q";
const SHOW_HARDWARE_CURSOR = "\x1b[?25h";
const SOFTWARE_CURSOR_SPACE = "\x1b[7m \x1b[0m";
/* eslint-disable no-control-regex -- DECSCUSR uses ESC. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: DECSCUSR uses ESC.
const DECSCUSR_PATTERN = /\x1b\[[015] q/;
/* eslint-enable no-control-regex */

function focusEditor(editor: ModalEditor): void {
  editor.focused = true;
}

type WrapperFacingEditor = ModalEditor & {
  actionHandlers: Map<string, unknown>;
  onSubmit: (text: string) => unknown;
  onChange: (text: string) => unknown;
  onEscape: () => unknown;
  onCtrlD: () => unknown;
  onPasteImage: (path: string) => unknown;
  onExtensionShortcut: (shortcut: string) => unknown;
  focused: boolean;
  disableSubmit: boolean;
  borderColor: (text: string) => string;
};

const WRAPPER_FACING_METHODS = [
  "handleInput",
  "render",
  "invalidate",
  "getText",
  "setText",
  "insertTextAtCursor",
  "getExpandedText",
  "addToHistory",
  "setAutocompleteProvider",
  "setPaddingX",
  "setAutocompleteMaxVisible",
  "getLines",
  "getCursor",
  "getMode",
  "onAction",
] as const satisfies readonly (keyof WrapperFacingEditor)[];

const WRAPPER_FACING_FIELDS = [
  "onSubmit",
  "onChange",
  "onEscape",
  "onCtrlD",
  "onPasteImage",
  "onExtensionShortcut",
  "actionHandlers",
  "focused",
  "disableSubmit",
  "borderColor",
] as const satisfies readonly (keyof WrapperFacingEditor)[];

type DecoratedCall =
  | { method: "insertTextAtCursor"; text: string }
  | { method: "handleInput"; data: string }
  | { method: "setText"; text: string };

function assertWrapperFacingSurface(
  editor: ModalEditor,
): asserts editor is WrapperFacingEditor {
  const candidate = editor as WrapperFacingEditor;

  for (const method of WRAPPER_FACING_METHODS) {
    assert.equal(
      typeof candidate[method],
      "function",
      `${method} should be a function`,
    );
  }

  for (const field of WRAPPER_FACING_FIELDS) {
    assert.ok(field in candidate, `${field} should exist`);
  }

  assert.ok(
    candidate.actionHandlers instanceof Map,
    "actionHandlers should be a Map",
  );
  assert.equal(
    typeof candidate.focused,
    "boolean",
    "focused should be a boolean",
  );
  assert.equal(
    typeof candidate.disableSubmit,
    "boolean",
    "disableSubmit should be a boolean",
  );
  assert.equal(
    typeof candidate.borderColor,
    "function",
    "borderColor should be a function",
  );
}

function decorateLikeImageAttachments(editor: ModalEditor): DecoratedCall[] {
  assertWrapperFacingSurface(editor);
  const calls: DecoratedCall[] = [];
  const originalInsertTextAtCursor = editor.insertTextAtCursor.bind(editor);
  const originalHandleInput = editor.handleInput.bind(editor);
  const originalSetText = editor.setText.bind(editor);

  editor.insertTextAtCursor = (text: string) => {
    calls.push({ method: "insertTextAtCursor", text });
    return originalInsertTextAtCursor(text);
  };
  editor.handleInput = (data: string) => {
    calls.push({ method: "handleInput", data });
    return originalHandleInput(data);
  };
  editor.setText = (text: string) => {
    calls.push({ method: "setText", text });
    return originalSetText(text);
  };

  return calls;
}

function findCursorMarkerLine(lines: string[]): string {
  const line = lines.find((line) => line.includes(CURSOR_MARKER));
  assert.ok(line, "expected rendered lines to include CURSOR_MARKER");
  return line;
}

function removeCursorMarker(line: string): string {
  return line.replace(CURSOR_MARKER, "");
}

function assertNoCursorShapeSequences(lines: string[]): void {
  for (const line of lines) {
    assert.doesNotMatch(line, DECSCUSR_PATTERN);
  }
}

type InstalledExtension = {
  editorFactory: EditorFactory;
  eventBusEmissions(): Array<{ event: string; data: unknown }>;
  readonly notificationCalls: number;
  readonly notifications: NotificationCall[];
  readonly shutdownCalls: number;
  emitShutdown(event?: { type?: string; reason?: string }): Promise<void>;
  readonly sessionShutdownHandlerCount: number;
  readonly sessionEndHandlerCount: number;
  setCommands(names: readonly string[]): void;
};

function createRecordingTheme(rejectedTokens: readonly string[] = []): Theme & {
  fg: (token: string, text: string) => string;
  fgCalls: ThemeFgCall[];
} {
  const fgCalls: ThemeFgCall[] = [];
  const rejected = new Set(rejectedTokens);
  return {
    borderColor: (s: string) => s,
    fg: (token: string, text: string) => {
      fgCalls.push({ token, text });
      if (rejected.has(token)) {
        throw new Error(`unknown theme token: ${token}`);
      }
      return `<${token}>${text}</${token}>`;
    },
    bold: (s: string) => s,
    fgCalls,
  } as unknown as Theme & {
    fg: (token: string, text: string) => string;
    fgCalls: ThemeFgCall[];
  };
}

async function installExtensionWithEditorFactory(
  theme: Theme = stubTheme,
): Promise<InstalledExtension> {
  const pi = createExtensionApiHarness();
  let editorFactory: EditorFactory | null = null;
  let notificationCalls = 0;
  const notifications: NotificationCall[] = [];
  let shutdownCalls = 0;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      theme,
      setEditorComponent(factory: EditorFactory): void {
        editorFactory = factory;
      },
      notify(message: string, type: string): void {
        notificationCalls++;
        notifications.push({ message, type });
      },
    },
    shutdown(): void {
      shutdownCalls++;
    },
  };

  installPiVim(pi);
  await pi.emit("session_start", undefined, ctx);

  if (!editorFactory) {
    throw new Error("expected session_start to install an editor factory");
  }

  return {
    editorFactory,
    eventBusEmissions: () => pi.eventBusEmissions(),
    setCommands: (names: readonly string[]) => pi.setCommands(names),
    get notificationCalls() {
      return notificationCalls;
    },
    get notifications() {
      return notifications;
    },
    get shutdownCalls() {
      return shutdownCalls;
    },
    async emitShutdown(event?: {
      type?: string;
      reason?: string;
    }): Promise<void> {
      await pi.emit("session_shutdown", event, ctx);
    },
    get sessionShutdownHandlerCount() {
      return pi.handlersFor("session_shutdown").length;
    },
    get sessionEndHandlerCount() {
      return pi.handlersFor("session_end").length;
    },
  };
}

// Fills a per-mode paint-policy map with one value for every mode.
const allSurfaces = (value: SurfaceSync): SurfaceSyncMap => ({
  insert: value,
  normal: value,
  visual: value,
  ex: value,
});

// Builds a ModalEditor from the given piVim settings. The settings reader is
// restored via the returned `restore` (settings are read once at session_start
// and baked into the factory closure, so construction is already finalized).
async function createBorderEditor(
  theme: ReturnType<typeof createRecordingTheme>,
  settings: PiVimSettings,
): Promise<{ editor: ModalEditor; restore: () => void }> {
  const restore = setPiVimSettingsReaderForTests(() => settings);
  const extension = await installExtensionWithEditorFactory(theme);
  const editor = extension.editorFactory(stubTui, stubTheme, stubKeybindings);
  return { editor, restore };
}

function createSpawnErrno(message: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.syscall = "spawn clipboard-helper";
  return error;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise();
  });

  if (resolve === undefined) {
    throw new Error("deferred promise was not initialized");
  }

  return { promise, resolve };
}

function nextImmediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

async function readLinesIfExists(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLineCount(path: string, count: number): Promise<void> {
  await withTimeout(
    (async () => {
      while ((await readLinesIfExists(path)).length < count) {
        await delay(10);
      }
    })(),
    1_000,
    `timed out waiting for ${path} to contain ${count} lines`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

type HelperRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const CLIPBOARD_HELPER_TEST_TIMEOUT_MS = 5_000;

function getClipboardHelperSourceWithMock(mockModuleSource: string): string {
  const mockModuleUrl = `data:text/javascript,${encodeURIComponent(mockModuleSource)}`;
  return buildClipboardWriteHelperSource(mockModuleUrl);
}

function getClipboardReadHelperSourceWithMock(
  mockClipboardExpression: string,
): string {
  const mockModuleUrl = import.meta.url;
  const helperSource = buildClipboardReadHelperSource(mockModuleUrl);
  const requireLine = `const require = createRequire(${JSON.stringify(mockModuleUrl)});`;
  const clipboardLine = 'const clipboard = require("@mariozechner/clipboard");';
  const replacement = `const clipboard = ${mockClipboardExpression};`;
  const mockedSource = helperSource.replace(
    `${requireLine}\n${clipboardLine}`,
    replacement,
  );

  assert.notEqual(
    mockedSource,
    helperSource,
    "clipboard read helper require was not replaced",
  );
  assert.equal(
    mockedSource.includes(clipboardLine),
    false,
    "real clipboard read helper require remains",
  );
  assert.equal(
    mockedSource.includes(replacement),
    true,
    "mock clipboard object missing",
  );

  return mockedSource;
}

function runClipboardHelperSource(
  source: string,
  input: string,
): Promise<HelperRunResult> {
  return new Promise<HelperRunResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    function finish(error: unknown, result?: HelperRunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      if (error) {
        reject(error);
        return;
      }
      if (result === undefined) {
        reject(new Error("clipboard helper result missing"));
        return;
      }

      resolve(result);
    }

    const timeoutId = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort: the timeout already fails the helper-source test.
      }
      finish(
        new Error(
          `clipboard helper timed out after ${CLIPBOARD_HELPER_TEST_TIMEOUT_MS}ms`,
        ),
      );
    }, CLIPBOARD_HELPER_TEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      finish(null, {
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    child.stdin.end(input);
  });
}

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
  assert.deepEqual(
    editor.getCursor(),
    expectedCursor,
    `cursor after [${keys.join("")}]`,
  );
  assert.equal(
    editor.getRegister(),
    expectedRegister,
    `register after [${keys.join("")}]`,
  );

  sendKeys(editor, ["u", "\x12"]);

  assert.equal(
    editor.getText(),
    expectedText,
    `redo text after [${keys.join("")}]`,
  );
  assert.deepEqual(
    editor.getCursor(),
    expectedCursor,
    `redo cursor after [${keys.join("")}]`,
  );
  assert.equal(
    editor.getRegister(),
    expectedRegister,
    `redo register after [${keys.join("")}]`,
  );
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
  const pick = (values: readonly string[]): string =>
    values[next() % values.length] ?? "";

  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const partCount = 1 + (next() % 6);

    for (let part = 0; part < partCount; part++) {
      const bucket = next() % 5;
      if (bucket <= 1) {
        parts.push(pick(words));
      } else if (bucket === 2) {
        parts.push(pick(punct));
      } else {
        parts.push(pick(spaces));
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
  editorMode: Mode;
  cursorLine: number;
  cursorCol: number;
} {
  const { editor } = initial.includes("\n")
    ? createMultiLineEditor(initial)
    : createEditorWithSpy(initial);

  if (mode === "canonical") {
    getRawEditor(editor).tryFindWordTargetLineLocal = () => null;
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

function assertInsertBorderAfterModeChangingCommand(
  fixtureText: string,
  commandKeys: string[],
): void {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
    borderColorizers: {
      insert: (s: string) => `<insert>${s}</insert>`,
      normal: (s: string) => `<normal>${s}</normal>`,
      visual: (s: string) => `<visual>${s}</visual>`,
      ex: (s: string) => `<ex>${s}</ex>`,
    },
  });

  for (const char of fixtureText) {
    editor.handleInput(char);
  }
  editor.handleInput("\x1b");

  sendKeys(editor, commandKeys);

  assert.equal(
    editor.getMode(),
    "insert",
    `mode after [${commandKeys.join("")}]`,
  );
  assert.equal(
    editor.borderColor("x"),
    "<insert>x</insert>",
    `border after [${commandKeys.join("")}]`,
  );
}

// ---------------------------------------------------------------------------
// Wrapper-facing editor surface
// ---------------------------------------------------------------------------

describe("wrapper-facing editor surface", () => {
  it("exposes the CustomEditor-style surface later decorators need", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);

    assertWrapperFacingSurface(editor);
  });

  it("keeps modal behavior when a later decorator patches core methods in place", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    const calls = decorateLikeImageAttachments(editor);

    editor.insertTextAtCursor("abc");
    assert.equal(editor.getText(), "abc");

    editor.setText("hello");
    assert.equal(editor.getText(), "hello");

    editor.handleInput("!");
    assert.equal(editor.getText(), "hello!");
    assert.equal(editor.getMode(), "insert");

    editor.handleInput("\x1b");
    assert.equal(editor.getMode(), "normal");

    editor.handleInput("0");
    editor.handleInput("x");
    assert.equal(editor.getText(), "ello!");
    assert.equal(editor.getMode(), "normal");

    assert.deepEqual(calls, [
      { method: "insertTextAtCursor", text: "abc" },
      { method: "setText", text: "hello" },
      { method: "handleInput", data: "!" },
      { method: "handleInput", data: "\x1b" },
      { method: "handleInput", data: "0" },
      { method: "handleInput", data: "x" },
    ]);
  });
});

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

  it("escape from insert mode places normal cursor on previous character", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);

    sendKeys(editor, ["h", "e", "l", "l", "o"]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });

    sendKeys(editor, ["\x1b"]);

    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("escape from insert mode does not move before line start", () => {
    const { editor } = createEditorWithSpy("hello");

    sendKeys(editor, ["i", "\x1b"]);

    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("escape from insert mode moves by one grapheme", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);

    sendKeys(editor, ["a", "😀", "\x1b"]);

    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
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

    const customEditorProto = Object.getPrototypeOf(
      Object.getPrototypeOf(editor),
    );
    const originalHandleInput = customEditorProto.handleInput;
    let forwardedEscapeCount = 0;

    customEditorProto.handleInput = function (
      this: unknown,
      data: string,
    ): unknown {
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

describe("mode change callback", () => {
  type ModeChangeEvent = {
    mode: Mode;
    prev: Mode;
  };

  it("fires on transitions only, with prev and new modes", () => {
    const { editor } = createEditorWithSpy("hello");
    const events: ModeChangeEvent[] = [];
    editor.setModeChangeFn((mode, prev) => events.push({ mode, prev }));

    // editor is in normal after createEditorWithSpy; setModeChangeFn was
    // installed afterwards, so the prior insert→normal transition is not seen.
    sendKeys(editor, ["i"]);
    sendKeys(editor, ["\x1b"]);
    sendKeys(editor, ["a"]);
    sendKeys(editor, ["\x1b"]);

    assert.deepEqual(events, [
      { mode: "insert", prev: "normal" },
      { mode: "normal", prev: "insert" },
      { mode: "insert", prev: "normal" },
      { mode: "normal", prev: "insert" },
    ]);
  });

  it("does not fire on no-op same-mode setMode calls", () => {
    const { editor } = createEditorWithSpy("hello");
    const events: ModeChangeEvent[] = [];
    editor.setModeChangeFn((mode, prev) => events.push({ mode, prev }));

    // Already in normal mode; bare escape stays in normal and must not fire.
    sendKeys(editor, ["\x1b"]);

    assert.deepEqual(events, []);
  });

  for (const key of ["o", "O"] as const) {
    it(`fires once for ${key} which opens a line and enters insert`, () => {
      const { editor } = createMultiLineEditor("foo\nbar");
      const events: ModeChangeEvent[] = [];
      editor.setModeChangeFn((mode, prev) => events.push({ mode, prev }));

      sendKeys(editor, [key]);

      assert.equal(editor.getMode(), "insert");
      assert.deepEqual(events, [{ mode: "insert", prev: "normal" }]);
    });
  }

  for (const scenario of [
    { name: "A", text: "hello", keys: ["A"] },
    { name: "I", text: "  hello", keys: ["I"] },
    { name: "C", text: "hello", keys: ["C"] },
    { name: "S", text: "hello", keys: ["S"] },
    { name: "s", text: "hello", keys: ["s"] },
    { name: "cc", text: "hello", keys: ["c", "c"] },
    { name: "c_", text: "hello", keys: ["c", "_"] },
    { name: "c%", text: "(hello)", keys: ["c", "%"] },
    { name: "cw", text: "hello world", keys: ["c", "w"] },
    { name: "ciw", text: "hello world", keys: ["c", "i", "w"] },
  ] as const) {
    it(`fires once when ${scenario.name} enters insert`, () => {
      const { editor } = createEditorWithSpy(scenario.text);
      const events: ModeChangeEvent[] = [];
      editor.setModeChangeFn((mode, prev) => events.push({ mode, prev }));

      sendKeys(editor, [...scenario.keys]);

      assert.equal(editor.getMode(), "insert");
      assert.deepEqual(events, [{ mode: "insert", prev: "normal" }]);
    });
  }

  it("does not fire when entering or leaving EX mini-mode", () => {
    const { editor } = createEditorWithSpy("hello");
    const events: ModeChangeEvent[] = [];
    editor.setModeChangeFn((mode, prev) => events.push({ mode, prev }));

    sendKeys(editor, [":", "q", "\x1b"]);

    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(events, []);
  });

  it("swallows callback errors so editing keeps working", () => {
    const { editor } = createEditorWithSpy("hello");
    editor.setModeChangeFn(() => {
      throw new Error("boom");
    });

    assert.doesNotThrow(() => sendKeys(editor, ["i"]));
    assert.equal(editor.getMode(), "insert");
  });
});

describe("mode change extension hook", () => {
  it("emits mode-change events and runs configured commands", async () => {
    const commands: string[] = [];
    const restoreRunner = setModeChangeCommandRunnerForTests((command) => {
      commands.push(command);
    });
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({
      modeChange: { insert: "insert-cmd", normal: "normal-cmd" },
    }));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      sendKeys(editor, ["\x1b", ":", "\x1b", "i"]);

      assert.deepEqual(commands, ["normal-cmd", "insert-cmd"]);
      assert.deepEqual(extension.eventBusEmissions(), [
        {
          event: "pi-vim:mode-change",
          data: { mode: "normal", previousMode: "insert" },
        },
        {
          event: "pi-vim:mode-change",
          data: { mode: "insert", previousMode: "normal" },
        },
      ]);
    } finally {
      restoreSettings();
      restoreRunner();
    }
  });

  it("clears a queued command when the latest mode has no configured command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-vim-mode-change-"));
    const scriptPath = join(dir, "hook.mjs");
    const startsPath = join(dir, "starts.log");
    const releasePath = join(dir, "release");
    const command = [process.execPath, scriptPath, startsPath, releasePath]
      .map(shellQuote)
      .join(" ");
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({
      modeChange: { normal: command },
    }));
    let extension: InstalledExtension | null = null;

    await writeFile(
      scriptPath,
      [
        'import { access, appendFile } from "node:fs/promises";',
        "const [startsPath, releasePath] = process.argv.slice(2);",
        'await appendFile(startsPath, "start\\n");',
        "for (;;) {",
        "  try {",
        "    await access(releasePath);",
        "    break;",
        "  } catch {",
        "    await new Promise((resolve) => setTimeout(resolve, 10));",
        "  }",
        "}",
      ].join("\n"),
    );

    try {
      extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      sendKeys(editor, ["\x1b"]);
      await waitForLineCount(startsPath, 1);

      sendKeys(editor, ["i", "\x1b", "i"]);
      await writeFile(releasePath, "");
      await delay(100);

      assert.deepEqual(await readLinesIfExists(startsPath), ["start"]);
    } finally {
      restoreSettings();
      await writeFile(releasePath, "").catch(() => {});
      await extension?.emitShutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves external commands off by default", async () => {
    const commands: string[] = [];
    const restoreRunner = setModeChangeCommandRunnerForTests((command) => {
      commands.push(command);
    });
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({}));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      sendKeys(editor, ["\x1b", "i"]);

      assert.deepEqual(commands, []);
      assert.deepEqual(
        extension.eventBusEmissions().map((emission) => emission.event),
        ["pi-vim:mode-change", "pi-vim:mode-change"],
      );
    } finally {
      restoreSettings();
      restoreRunner();
    }
  });
});

describe("ex mini-mode", () => {
  it("renders the pending EX command and consumes prefixed counts", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, ["2", ":"]);

    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :_ "));

    sendKeys(session.editor, ["\x1b", "x"]);

    assert.equal(session.quitCalls, 0);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "ello");
    assert.equal(session.editor.getRegister(), "h");
  });

  it("keeps the EX label visible on narrow renders", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", ...Array.from("averyveryverylongcommand")]);

    const footer = session.editor.render(20).at(-1) ?? "";

    assert.ok(footer.includes(" EX "));
    assert.ok(footer.endsWith("_ "));
  });

  it("renders EX labels with the EX-specific colorizer", () => {
    const calls: string[] = [];
    const colorizers = {
      insert: (s: string) => {
        calls.push(`insert:${s}`);
        return `\x1b[32m${s}\x1b[39m`;
      },
      normal: (s: string) => {
        calls.push(`normal:${s}`);
        return `\x1b[34m${s}\x1b[39m`;
      },
      visual: (s: string) => {
        calls.push(`visual:${s}`);
        return `\x1b[35m${s}\x1b[39m`;
      },
      ex: (s: string) => {
        calls.push(`ex:${s}`);
        return `\x1b[36m${s}\x1b[39m`;
      },
    };
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
      labelColorizers: colorizers,
    });

    editor.handleInput("\x1b");
    sendKeys(editor, [":"]);

    const footer = editor.render(80).at(-1) ?? "";

    assert.deepEqual(calls, ["ex: EX :_ "]);
    assert.ok(footer.includes(" EX :_ "));
    assert.ok(footer.endsWith("\x1b[36m EX :_ \x1b[39m"));
  });

  it("renders VISUAL and V-LINE labels with the visual colorizer", () => {
    const calls: string[] = [];
    const colorizers = {
      insert: (s: string) => `<insert>${s}</insert>`,
      normal: (s: string) => {
        calls.push(`normal:${s}`);
        return `<normal>${s}</normal>`;
      },
      visual: (s: string) => {
        calls.push(`visual:${s}`);
        return `<visual>${s}</visual>`;
      },
      ex: (s: string) => `<ex>${s}</ex>`,
    };
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, {
      labelColorizers: colorizers,
    });

    // hi, Esc → normal, v → VISUAL, V → V-LINE.
    sendKeys(editor, ["h", "i", "\x1b", "v"]);
    const visualFooter = editor.render(80).at(-1) ?? "";
    sendKeys(editor, ["V"]);
    const vLineFooter = editor.render(80).at(-1) ?? "";

    assert.ok(visualFooter.endsWith("<visual> VISUAL </visual>"));
    assert.ok(vLineFooter.endsWith("<visual> V-LINE </visual>"));
    // Visual modes use the visual colorizer, never collapsing to normal.
    assert.deepEqual(calls, ["visual: VISUAL ", "visual: V-LINE "]);
  });

  it(":q refuses to quit when prompt has non-whitespace text", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "q", "\r"]);

    assert.equal(session.quitCalls, 0);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 0 });
    assert.deepEqual(session.notifications, [
      "Prompt is not empty; use :q! to quit anyway",
    ]);
  });

  it(":qa refuses to quit when prompt has non-whitespace text", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "q", "a", "\r"]);

    assert.equal(session.quitCalls, 0);
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, [
      "Prompt is not empty; use :qa! to quit anyway",
    ]);
  });

  it(":q requests quit when prompt is empty", () => {
    const session = createEditorWithSpy("");

    sendKeys(session.editor, [":", "q", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getText(), "");
    assert.deepEqual(session.notifications, []);
  });

  it(":qa requests quit when prompt is whitespace-only", () => {
    const session = createEditorWithSpy("   ");

    sendKeys(session.editor, [":", "q", "a", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getText(), "   ");
    assert.deepEqual(session.notifications, []);
  });

  it(":qa! requests quit when prompt has non-whitespace text", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "q", "a", "!", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, []);
  });

  for (const alias of ["quit", "qall", "quitall"]) {
    it(`:${alias} refuses to quit when prompt has non-whitespace text`, () => {
      const session = createEditorWithSpy("hello");

      sendKeys(session.editor, [":", ...alias, "\r"]);

      assert.equal(session.quitCalls, 0);
      assert.equal(session.editor.getText(), "hello");
      assert.deepEqual(session.notifications, [
        `Prompt is not empty; use :${alias}! to quit anyway`,
      ]);
    });

    it(`:${alias} requests quit when prompt is empty`, () => {
      const session = createEditorWithSpy("");

      sendKeys(session.editor, [":", ...alias, "\r"]);

      assert.equal(session.quitCalls, 1);
      assert.deepEqual(session.notifications, []);
    });

    it(`:${alias}! requests quit when prompt has non-whitespace text`, () => {
      const session = createEditorWithSpy("hello");

      sendKeys(session.editor, [":", ...alias, "!", "\r"]);

      assert.equal(session.quitCalls, 1);
      assert.equal(session.editor.getText(), "hello");
      assert.deepEqual(session.notifications, []);
    });
  }

  it("unlisted quit abbreviations stay unsupported", () => {
    const session = createEditorWithSpy("");

    sendKeys(session.editor, [":", ..."quita", "\r"]);

    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :quita"]);
  });

  it(":! alone stays unsupported", () => {
    const session = createEditorWithSpy("");

    sendKeys(session.editor, [":", "!", "\r"]);

    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :!"]);
  });

  it("escape cancels ex mini-mode", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "q", "\x1b", "x"]);

    assert.equal(session.quitCalls, 0);
    assert.equal(session.editor.getText(), "ello");
    assert.equal(session.editor.getRegister(), "h");
  });

  it("backspace edits the pending ex command", () => {
    const session = createEditorWithSpy("");

    sendKeys(session.editor, [":", "q", "a", "\x7f", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, []);
  });

  it("ctrl+h edits the pending ex command", () => {
    const session = createEditorWithSpy("");

    sendKeys(session.editor, [":", "q", "a", "\x08", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, []);
  });

  it("backspace removes one full grapheme from the pending ex command", () => {
    const session = createEditorWithSpy("");

    sendKeys(session.editor, [":", "e\u0301", "\x7f", "q", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, []);
    assert.equal(session.editor.getText(), "");
  });

  it(":q! requests quit when prompt has non-whitespace text", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "q", "!", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, []);
  });

  it("bracketed paste payload is accepted in ex mini-mode", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x1b[200~q!\x1b[201~", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, []);
  });

  it("does not submit trailing enter bytes from a paste chunk", () => {
    const session = createEditorWithSpy("");
    const dispatched: string[] = [];
    session.editor.setCommandNamesFn(() => new Set(["tree"]));
    session.editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
    });

    sendKeys(session.editor, [":", "\x1b[200~tree\x1b[201~\r"]);

    assert.deepEqual(dispatched, []);
    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :tree_ "));

    sendKeys(session.editor, ["\r"]);
    assert.deepEqual(dispatched, ["/tree"]);
  });

  it("does not submit enter bytes after a split paste terminator", () => {
    const session = createEditorWithSpy("");
    const dispatched: string[] = [];
    session.editor.setCommandNamesFn(() => new Set(["tree"]));
    session.editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
    });

    sendKeys(session.editor, [":", "\x1b[200~tree", "\x1b", "[201~\r"]);

    assert.deepEqual(dispatched, []);
    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :tree_ "));

    sendKeys(session.editor, ["\r"]);
    assert.deepEqual(dispatched, ["/tree"]);
  });

  it("keeps discarding when a discarded tail starts another paste", () => {
    const session = createEditorWithSpy("");
    const dispatched: string[] = [];
    session.editor.setCommandNamesFn(() => new Set(["tree", "treeevil"]));
    session.editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
    });

    sendKeys(session.editor, [
      ":",
      "\x1b[200~tree\x1b[201~\x1b[200~",
      "evil\r",
      "\x1b[201~",
    ]);

    assert.deepEqual(dispatched, []);
    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :tree_ "));

    sendKeys(session.editor, ["\r"]);
    assert.deepEqual(dispatched, ["/tree"]);
  });

  it("keeps discarding across a split nested paste start", () => {
    const session = createEditorWithSpy("");
    const dispatched: string[] = [];
    session.editor.setCommandNamesFn(() => new Set(["tree", "tree[200~evil"]));
    session.editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
    });

    sendKeys(session.editor, [
      ":",
      "\x1b[200~tree\x1b[201~\x1b",
      "[200~evil\r",
      "\x1b[201~",
    ]);

    assert.deepEqual(dispatched, []);
    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :tree_ "));

    sendKeys(session.editor, ["\r"]);
    assert.deepEqual(dispatched, ["/tree"]);
  });

  it("split bracketed paste payload is accepted in ex mini-mode", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [
      ":",
      "\x1b[200~",
      "q",
      "a",
      "!",
      "\x1b",
      "[201~",
      "\r",
    ]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, []);
  });

  const pendingExLabel = (session: {
    editor: { render(w: number): string[] };
  }) => session.editor.render(80).at(-1);

  it("newline in bracketed paste does not submit the pending ex command", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x1b[200~q!\n\x1b[201~"]);

    assert.equal(session.quitCalls, 0);
    assert.ok(pendingExLabel(session)?.endsWith(" EX :q!_ "));
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, []);
  });

  it("typed enter after a pasted newline submits the first pasted line", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x1b[200~q!\nrest\x1b[201~", "\r"]);

    assert.equal(session.quitCalls, 1);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.notifications, []);
  });

  it("text after a pasted newline is discarded, not appended", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x1b[200~q\nall!\x1b[201~"]);

    assert.equal(session.quitCalls, 0);
    assert.ok(pendingExLabel(session)?.endsWith(" EX :q_ "));
  });

  it("pasted newline in a split paste waits for a typed enter", () => {
    const session = createEditorWithSpy("hello");
    const customEditorProto = Object.getPrototypeOf(
      Object.getPrototypeOf(session.editor),
    );
    const originalHandleInput = customEditorProto.handleInput;
    let forwardedEscapeCount = 0;

    customEditorProto.handleInput = function (
      this: unknown,
      data: string,
    ): unknown {
      if (data === "\x1b") forwardedEscapeCount++;
      return originalHandleInput.call(this, data);
    };

    try {
      sendKeys(session.editor, [":", "\x1b[200~q!\n", "\x1b", "[201~"]);

      assert.equal(session.quitCalls, 0);
      assert.equal(forwardedEscapeCount, 0);
      assert.ok(pendingExLabel(session)?.endsWith(" EX :q!_ "));

      sendKeys(session.editor, ["\r"]);

      assert.equal(session.quitCalls, 1);
      assert.equal(session.editor.getMode(), "normal");
      assert.equal(session.editor.getText(), "hello");
      assert.deepEqual(session.notifications, []);
    } finally {
      customEditorProto.handleInput = originalHandleInput;
    }
  });

  it("payload split across chunks keeps only the first pasted line", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [
      ":",
      "\x1b[200~q",
      "a!",
      "\nrest",
      "more",
      "\x1b[201~",
    ]);

    assert.equal(session.quitCalls, 0);
    assert.ok(pendingExLabel(session)?.endsWith(" EX :qa!_ "));

    sendKeys(session.editor, ["\r"]);
    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, []);
  });

  it("a paste that begins with a newline leaves the ex line empty", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x1b[200~\nq!\x1b[201~"]);

    assert.equal(session.quitCalls, 0);
    assert.ok(pendingExLabel(session)?.endsWith(" EX :_ "));
  });

  it("typing continues after a discarded paste tail", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [
      ":",
      "\x1b[200~q\nrest\x1b[201~",
      "a",
      "!",
      "\r",
    ]);

    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, []);
  });

  it("a pasted crlf truncates at the carriage return", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x1b[200~q!\r\nrest\x1b[201~"]);

    assert.equal(session.quitCalls, 0);
    assert.ok(pendingExLabel(session)?.endsWith(" EX :q!_ "));
  });

  it("each paste contributes its own first line", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [
      ":",
      "\x1b[200~q\nX\x1b[201~",
      "\x1b[200~a!\nY\x1b[201~",
    ]);

    assert.ok(pendingExLabel(session)?.endsWith(" EX :qa!_ "));

    sendKeys(session.editor, ["\r"]);
    assert.equal(session.quitCalls, 1);
    assert.deepEqual(session.notifications, []);
  });

  it("empty submit is a silent no-op", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\r"]);

    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, []);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "hello");
  });

  it("backspace on bare colon exits ex mode", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, [":", "\x7f", "x"]);

    assert.equal(session.quitCalls, 0);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "ello");
    assert.equal(session.editor.getRegister(), "h");
  });

  it("non-printable input cancels ex mode and is reprocessed", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, ["x", "u", ":", "q", "\x12"]);

    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, []);
    assert.equal(session.editor.getMode(), "normal");
    assert.equal(session.editor.getText(), "ello");
    assert.equal(session.editor.getRegister(), "h");
  });

  it("unsupported ex commands do not quit", () => {
    const session = createEditorWithSpy("hello");

    sendKeys(session.editor, ["l", "l", ":", "w", "q", "\r"]);

    assert.equal(session.quitCalls, 0);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :wq"]);
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 2 });
  });
});

describe("ex pi-command bridge", () => {
  type BridgeSession = ReturnType<typeof createEditorWithSpy> & {
    dispatched: string[];
  };

  function createBridgeSession(
    initialText: string,
    knownCommands: readonly string[] = ["tree", "model"],
  ): BridgeSession {
    const session = createEditorWithSpy(initialText);
    const dispatched: string[] = [];
    session.editor.setCommandNamesFn(() => new Set(knownCommands));
    session.editor.setRunCommandFn((commandLine) => {
      dispatched.push(commandLine);
      // Every real dispatch route clears the prompt before running.
      session.editor.setText("");
    });
    // Object.assign, not a spread: `quitCalls` is a getter on the session.
    return Object.assign(session, { dispatched });
  }

  function runEx(editor: ModalEditor, command: string): void {
    sendKeys(editor, [":", ...command.split(""), "\r"]);
  }

  it("dispatches a known pi command as a slash command", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "tree");

    assert.deepEqual(session.dispatched, ["/tree"]);
    assert.deepEqual(session.notifications, []);
    assert.equal(session.editor.getMode(), "normal");
  });

  it("passes arguments after the first whitespace run verbatim", () => {
    const session = createBridgeSession("", ["model"]);

    runEx(session.editor, "model  claude  opus ");

    assert.deepEqual(session.dispatched, ["/model claude  opus"]);
  });

  it("dispatches a bare name when the args are whitespace only", () => {
    const session = createBridgeSession("", ["model"]);

    runEx(session.editor, "model   ");

    assert.deepEqual(session.dispatched, ["/model"]);
  });

  it("routes dispatch through the editor submit path by default", () => {
    const session = createEditorWithSpy("");
    const submitted: string[] = [];
    const textAtSubmit: string[] = [];
    session.editor.setCommandNamesFn(() => new Set(["tree"]));
    session.editor.onSubmit = (text) => {
      submitted.push(text);
      textAtSubmit.push(session.editor.getText());
      session.editor.setText("");
    };

    runEx(session.editor, "tree");

    assert.deepEqual(submitted, ["/tree"]);
    // The buffer holds the command line while the submit handler runs, exactly
    // as if the user had typed `/tree` and pressed Enter.
    assert.deepEqual(textAtSubmit, ["/tree"]);
  });

  it("dispatches builtin names without any registered extension command", () => {
    const session = createEditorWithSpy("");
    const submitted: string[] = [];
    session.editor.onSubmit = (text) => {
      submitted.push(text);
      session.editor.setText("");
    };

    runEx(session.editor, "compact");
    runEx(session.editor, "hotkeys");

    assert.deepEqual(submitted, ["/compact", "/hotkeys"]);
    assert.deepEqual(session.notifications, []);
  });

  it("dispatches trust from the builtin command mirror", () => {
    const session = createEditorWithSpy("");
    const submitted: string[] = [];
    session.editor.onSubmit = (text) => {
      submitted.push(text);
      session.editor.setText("");
    };

    runEx(session.editor, "trust");

    assert.deepEqual(submitted, ["/trust"]);
    assert.deepEqual(session.notifications, []);
  });

  it("reserves future vim ex names instead of dispatching them", () => {
    for (const name of ["s", "g", "v", "d", "m", "t", "co", "j", "w", "r"]) {
      const session = createBridgeSession("", [name]);

      runEx(session.editor, name);

      assert.deepEqual(session.dispatched, []);
      assert.deepEqual(session.notifications, [
        `Reserved ex command: :${name}`,
      ]);
    }
  });

  it("reserves the long-form vim ex names normal and sort", () => {
    const session = createBridgeSession("", ["normal", "sort"]);

    runEx(session.editor, "normal");
    runEx(session.editor, "sort");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, [
      "Reserved ex command: :normal",
      "Reserved ex command: :sort",
    ]);
  });

  it("reserves a forced vim ex name", () => {
    const session = createBridgeSession("", ["w"]);

    runEx(session.editor, "w!");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, ["Reserved ex command: :w!"]);
  });

  it("reserves a name even when a pi command of that name exists", () => {
    const session = createBridgeSession("", ["w", "tree"]);

    runEx(session.editor, "w");
    runEx(session.editor, "tree");

    assert.deepEqual(session.dispatched, ["/tree"]);
    assert.deepEqual(session.notifications, ["Reserved ex command: :w"]);
  });

  it("rejects an unknown name without dispatching or messaging the agent", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "unknownxyz");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, [
      "Unsupported ex command: :unknownxyz",
    ]);
  });

  it("rejects a trailing bang on a non-reserved command name", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "tree!");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :tree!"]);
  });

  it("keeps quit names out of the bridge even though /quit is a builtin", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "quit");

    assert.deepEqual(session.dispatched, []);
    assert.equal(session.quitCalls, 1);
  });

  it("restores the composed prompt and cursor after a dispatch", () => {
    const session = createBridgeSession("hello world");
    sendKeys(session.editor, ["0", "l", "l"]);

    runEx(session.editor, "tree");

    assert.equal(session.editor.getText(), "hello world");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 2 });
  });

  it("restores a multi-line prompt after a dispatch", () => {
    const session = createBridgeSession("line one");
    sendKeys(session.editor, ["o", ..."line two".split(""), "\x1b"]);
    sendKeys(session.editor, ["k", "0", "l"]);

    runEx(session.editor, "tree");

    assert.equal(session.editor.getText(), "line one\nline two");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 1 });
  });

  it("leaves the undo stack where it was before the dispatch", () => {
    // The dispatch's own setText("") would otherwise sit on the undo stack and
    // swallow this `u`, making the first undo after any command a silent no-op.
    const session = createBridgeSession("hello");
    sendKeys(session.editor, ["x"]);

    runEx(session.editor, "tree");
    sendKeys(session.editor, ["u"]);

    assert.equal(session.editor.getText(), "hello");
  });

  it("leaves a prior insert session undoable in one u across a dispatch", () => {
    // Compose the undo window (whole insert session = one unit) with the
    // bridge's savedUndoDepth restore: after a dispatch, one `u` reverts the
    // pre-dispatch insert session, not the phantom setText("") clear.
    const session = createBridgeSession("");
    sendKeys(session.editor, ["i", ..."hello world", "\x1b"]);

    runEx(session.editor, "tree");
    assert.equal(session.editor.getText(), "hello world");

    sendKeys(session.editor, ["u"]);
    assert.equal(
      session.editor.getText(),
      "",
      "u reverts the whole pre-dispatch insert session",
    );
  });

  it("consumes no more undo steps than a session with no dispatch", () => {
    const undoStepsToEmpty = (dispatch: boolean): number => {
      const session = createBridgeSession("hello");
      sendKeys(session.editor, ["x"]);
      if (dispatch) runEx(session.editor, "tree");

      let steps = 0;
      while (session.editor.getText() !== "" && steps < 10) {
        sendKeys(session.editor, ["u"]);
        steps++;
      }
      return steps;
    };

    assert.equal(undoStepsToEmpty(true), undoStepsToEmpty(false));
  });

  it("preserves the redo stack across a dispatch", () => {
    const session = createBridgeSession("hello");
    sendKeys(session.editor, ["x", "u"]);

    runEx(session.editor, "tree");
    sendKeys(session.editor, ["\x12"]);

    assert.equal(session.editor.getText(), "ello");
  });

  it("keeps the repeatable command armed across a dispatch", () => {
    const session = createBridgeSession("hello");
    sendKeys(session.editor, ["x"]);

    runEx(session.editor, "tree");
    sendKeys(session.editor, ["."]);

    assert.equal(session.editor.getText(), "llo");
  });

  it("restores the prompt when the dispatch throws", () => {
    const session = createBridgeSession("keep me");
    session.editor.setRunCommandFn(() => {
      session.editor.setText("");
      throw new Error("dispatch failed");
    });

    assert.throws(() => runEx(session.editor, "tree"), /dispatch failed/);
    assert.equal(session.editor.getText(), "keep me");
  });

  it("restores an async clear through the default submit path", async () => {
    const session = createEditorWithSpy("compose");
    session.editor.setCommandNamesFn(() => new Set(["tree"]));
    session.editor.onSubmit = async () => {
      await Promise.resolve();
      session.editor.setText("");
    };

    runEx(session.editor, "tree");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.editor.getText(), "compose");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 0 });
  });

  it("restores all prompt state after an asynchronous clear", async () => {
    const session = createBridgeSession("hello");
    sendKeys(session.editor, ["l", "l", "x", "u"]);
    session.editor.setRunCommandFn(async () => {
      await Promise.resolve();
      session.editor.setText("");
    });

    runEx(session.editor, "tree");
    assert.equal(session.editor.getText(), "hello");

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(session.editor.getText(), "hello");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 2 });

    sendKeys(session.editor, ["\x12"]);
    assert.equal(session.editor.getText(), "helo");
    sendKeys(session.editor, ["."]);
    assert.equal(session.editor.getText(), "heo");
    sendKeys(session.editor, ["u", "u"]);
    assert.equal(session.editor.getText(), "hello");
  });

  it("preserves input received before a delayed clear", async () => {
    const session = createBridgeSession("hello");
    let finishDispatch: (() => void) | undefined;
    session.editor.setRunCommandFn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = () => {
            session.editor.setText("");
            resolve();
          };
        }),
    );

    runEx(session.editor, "tree");
    sendKeys(session.editor, ["x", "l"]);
    assert.ok(finishDispatch);
    finishDispatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.editor.getText(), "ello");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 1 });
    sendKeys(session.editor, ["u", "."]);
    assert.equal(session.editor.getText(), "ello");
  });

  it("preserves a wrapper's out-of-band setText across a delayed async clear", async () => {
    // A wrapper replaces the prompt through the public setter while the
    // dispatch is still pending, with no handleInput after it to refresh the
    // restore seam. The delayed clear must reapply the wrapper's newer prompt,
    // not overwrite it with the stale pre-dispatch text.
    const session = createBridgeSession("stale prompt");
    let finishDispatch: (() => void) | undefined;
    session.editor.setRunCommandFn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = () => {
            session.editor.setText("");
            resolve();
          };
        }),
    );

    runEx(session.editor, "tree");
    session.editor.setText("wrapper prompt");
    assert.ok(finishDispatch);
    finishDispatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.editor.getText(), "wrapper prompt");
  });

  it("preserves a wrapper's out-of-band insert across a delayed async clear", async () => {
    const session = createBridgeSession("stale");
    let finishDispatch: (() => void) | undefined;
    session.editor.setRunCommandFn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = () => {
            session.editor.setText("");
            resolve();
          };
        }),
    );

    runEx(session.editor, "tree");
    session.editor.insertTextAtCursor("!");
    const afterInsert = session.editor.getText();
    assert.ok(finishDispatch);
    finishDispatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The insert survives; the stale pre-dispatch prompt does not clobber it.
    assert.equal(session.editor.getText(), afterInsert);
    assert.notEqual(session.editor.getText(), "stale");
    assert.ok(session.editor.getText().includes("!"));
  });

  it("keeps edits when an async dispatch settles without clearing", async () => {
    const session = createBridgeSession("hello");
    let finishDispatch: (() => void) | undefined;
    session.editor.setRunCommandFn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    runEx(session.editor, "tree");
    sendKeys(session.editor, ["x"]);
    assert.ok(finishDispatch);
    finishDispatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.editor.getText(), "ello");
    sendKeys(session.editor, ["u", "."]);
    assert.equal(session.editor.getText(), "ello");
  });

  it("keeps an intentional empty prompt after async settlement", async () => {
    const session = createBridgeSession("hello");
    let finishDispatch: (() => void) | undefined;
    session.editor.setRunCommandFn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    runEx(session.editor, "tree");
    sendKeys(session.editor, ["d", "d"]);
    assert.equal(session.editor.getText(), "");
    assert.ok(finishDispatch);
    finishDispatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.editor.getText(), "");
    sendKeys(session.editor, ["u"]);
    assert.equal(session.editor.getText(), "hello");
  });

  it("handles rejected async dispatches without losing prompt state", async () => {
    const cleared = createBridgeSession("restore me");
    cleared.editor.setRunCommandFn(async () => {
      await Promise.resolve();
      cleared.editor.setText("");
      throw new Error("dispatch failed");
    });

    runEx(cleared.editor, "tree");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cleared.editor.getText(), "restore me");

    const edited = createBridgeSession("hello");
    let rejectDispatch: ((reason: Error) => void) | undefined;
    edited.editor.setRunCommandFn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    );

    runEx(edited.editor, "tree");
    sendKeys(edited.editor, ["x"]);
    assert.ok(rejectDispatch);
    rejectDispatch(new Error("dispatch failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(edited.editor.getText(), "ello");
    sendKeys(edited.editor, ["u", "."]);
    assert.equal(edited.editor.getText(), "ello");
  });

  it("keeps the latest prompt when async dispatches settle out of order", async () => {
    const session = createBridgeSession("first");
    const finishDispatches: Array<() => void> = [];
    session.editor.setRunCommandFn(
      () =>
        new Promise<void>((resolve) => {
          finishDispatches.push(() => {
            session.editor.setText("");
            resolve();
          });
        }),
    );

    runEx(session.editor, "tree");
    session.editor.setText("second");
    sendKeys(session.editor, ["0", "x", "u"]);
    runEx(session.editor, "tree");

    const [finishFirst, finishSecond] = finishDispatches;
    assert.ok(finishFirst);
    assert.ok(finishSecond);
    finishSecond();
    await new Promise<void>((resolve) => setImmediate(resolve));
    finishFirst();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(session.editor.getText(), "second");
    assert.deepEqual(session.editor.getCursor(), { line: 0, col: 0 });
    sendKeys(session.editor, ["\x12", "."]);
    assert.equal(session.editor.getText(), "cond");
    sendKeys(session.editor, ["u", "u"]);
    assert.equal(session.editor.getText(), "second");
  });

  it("copies the prompt to the clipboard when copyInputToClipboard is on", async () => {
    const session = createBridgeSession("secret prompt");
    // Independent of the mirror policy: this is its own opt-in setting.
    session.editor.setClipboardMirrorPolicy("never");
    session.editor.setExCommandSettings({
      piDispatch: true,
      copyInputToClipboard: true,
    });

    runEx(session.editor, "tree");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(session.clipboardWrites, ["secret prompt"]);
    assert.deepEqual(session.dispatched, ["/tree"]);
  });

  it("skips the clipboard copy when the prompt is empty", async () => {
    const session = createBridgeSession("");
    session.editor.setExCommandSettings({
      piDispatch: true,
      copyInputToClipboard: true,
    });

    runEx(session.editor, "tree");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(session.clipboardWrites, []);
  });

  it("does not touch the clipboard by default", async () => {
    const session = createBridgeSession("secret prompt");

    runEx(session.editor, "tree");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(session.clipboardWrites, []);
  });

  it("falls back to quit-only behavior when piDispatch is off", () => {
    const session = createBridgeSession("");
    session.editor.setExCommandSettings({
      piDispatch: false,
      copyInputToClipboard: false,
    });

    runEx(session.editor, "tree");
    runEx(session.editor, "q");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :tree"]);
    assert.equal(session.quitCalls, 1);
  });

  it("dispatches :!cmd as a shell command through the submit seam", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "!ls -la");

    assert.deepEqual(session.dispatched, ["!ls -la"]);
    assert.deepEqual(session.notifications, []);
    assert.equal(session.editor.getMode(), "normal");
  });

  it("submits the shell line verbatim, including internal whitespace", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "!echo  hi   there");

    assert.deepEqual(session.dispatched, ["!echo  hi   there"]);
  });

  it("passes :!!cmd through as Pi's no-context bash form", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "!!git status");

    assert.deepEqual(session.dispatched, ["!!git status"]);
    assert.deepEqual(session.notifications, []);
  });

  it("restores the composed prompt after a shell dispatch", () => {
    const session = createBridgeSession("keep me");

    runEx(session.editor, "!ls");

    assert.deepEqual(session.dispatched, ["!ls"]);
    assert.equal(session.editor.getText(), "keep me");
  });

  it("does not let the shell branch shadow the :q! quit form", () => {
    const session = createBridgeSession("hello");

    runEx(session.editor, "q!");

    assert.deepEqual(session.dispatched, []);
    assert.equal(session.quitCalls, 1);
  });

  it("reports :!! with no command as unsupported", () => {
    const session = createBridgeSession("");

    runEx(session.editor, "!!");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :!!"]);
  });

  it("does not dispatch a shell command when piDispatch is off", () => {
    const session = createBridgeSession("");
    session.editor.setExCommandSettings({
      piDispatch: false,
      copyInputToClipboard: false,
    });

    runEx(session.editor, "!ls");

    assert.deepEqual(session.dispatched, []);
    assert.deepEqual(session.notifications, ["Unsupported ex command: :!ls"]);
  });

  it("copies the prompt before a shell dispatch when the setting is on", () => {
    const session = createBridgeSession("secret prompt");
    session.editor.setClipboardMirrorPolicy("never");
    session.editor.setExCommandSettings({
      piDispatch: true,
      copyInputToClipboard: true,
    });

    runEx(session.editor, "!ls");

    assert.deepEqual(session.clipboardWrites, ["secret prompt"]);
    assert.deepEqual(session.dispatched, ["!ls"]);
  });

  it("never submits a pasted shell command without a typed enter", () => {
    const session = createBridgeSession("");

    sendKeys(session.editor, [":", "\x1b[200~!rm -rf .\nrest\x1b[201~"]);

    assert.deepEqual(session.dispatched, []);
    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :!rm -rf ._ "));

    sendKeys(session.editor, ["\r"]);

    assert.deepEqual(session.dispatched, ["!rm -rf ."]);
  });

  it("does not dispatch a pasted command name without a typed enter", () => {
    const session = createBridgeSession("");

    sendKeys(session.editor, [":", "\x1b[200~tree\nrest\x1b[201~"]);

    assert.deepEqual(session.dispatched, []);
    assert.ok(session.editor.render(80).at(-1)?.endsWith(" EX :tree_ "));

    sendKeys(session.editor, ["\r"]);

    assert.deepEqual(session.dispatched, ["/tree"]);
  });

  it("unions builtin names with the commands pi reports at submit time", async () => {
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({}));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );
      const submitted: string[] = [];
      editor.onSubmit = (text) => {
        submitted.push(text);
        editor.setText("");
      };

      editor.handleInput("\x1b");
      extension.setCommands(["my-skill"]);

      runEx(editor, "tree"); // builtin, absent from getCommands()
      runEx(editor, "my-skill"); // registered extension/skill command
      runEx(editor, "absent"); // in neither source

      assert.deepEqual(submitted, ["/tree", "/my-skill"]);
      assert.deepEqual(extension.notifications, [
        { message: "Unsupported ex command: :absent", type: "warning" },
      ]);
    } finally {
      restoreSettings();
    }
  });

  it("sees a command registered after the editor was created", async () => {
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({}));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );
      const submitted: string[] = [];
      editor.onSubmit = (text) => {
        submitted.push(text);
        editor.setText("");
      };

      editor.handleInput("\x1b");
      runEx(editor, "late-command");
      extension.setCommands(["late-command"]);
      runEx(editor, "late-command");

      assert.deepEqual(submitted, ["/late-command"]);
      assert.deepEqual(extension.notifications, [
        { message: "Unsupported ex command: :late-command", type: "warning" },
      ]);
    } finally {
      restoreSettings();
    }
  });

  it("turns the bridge off from project settings", async () => {
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({
      exCommand: { piDispatch: false },
    }));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );
      const submitted: string[] = [];
      editor.onSubmit = (text) => submitted.push(text);

      editor.handleInput("\x1b");
      runEx(editor, "tree");

      assert.deepEqual(submitted, []);
      assert.deepEqual(extension.notifications, [
        { message: "Unsupported ex command: :tree", type: "warning" },
      ]);
    } finally {
      restoreSettings();
    }
  });

  it("warns once when the exCommand setting is invalid", async () => {
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({
      exCommand: { piDispatch: "yes" },
    }));

    try {
      const extension = await installExtensionWithEditorFactory();

      assert.deepEqual(extension.notifications, [
        {
          message: "Invalid piVim.exCommand piDispatch; expected a boolean.",
          type: "warning",
        },
      ]);
    } finally {
      restoreSettings();
    }
  });
});

describe("clipboard mirror policy settings", () => {
  it("applies clipboardMirror=never from settings", async () => {
    const restore = setPiVimSettingsReaderForTests(() => ({
      clipboardMirror: "never",
    }));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      assert.equal(editor.getClipboardMirrorPolicy(), "never");
      assert.equal(extension.notificationCalls, 0);
    } finally {
      restore();
    }
  });

  it("falls back to all and warns for invalid clipboardMirror", async () => {
    const restore = setPiVimSettingsReaderForTests(() => ({
      clipboardMirror: "delete",
    }));

    try {
      const extension = await installExtensionWithEditorFactory();
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      assert.equal(editor.getClipboardMirrorPolicy(), "all");
      assert.equal(extension.notificationCalls, 1);
      assert.equal(extension.notifications.length, 1);

      const notification = extension.notifications[0];
      assert.ok(notification, "expected warning notification");
      assert.equal(notification.type, "warning");
      assert.match(notification.message, /delete/);
      assert.match(notification.message, /all, yank, never/);
    } finally {
      restore();
    }
  });
});

describe("mode color settings", () => {
  const reverseInsertLabel = "\x1b[7m INSERT \x1b[27m";

  it("mode label uses default insert, normal, and EX mode color tokens", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({}));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      editor.render(80);
      sendKeys(editor, ["\x1b"]);
      editor.render(80);
      sendKeys(editor, [":"]);
      editor.render(80);

      assert.deepEqual(
        theme.fgCalls.map((call) => call.token),
        ["borderMuted", "borderAccent", "warning"],
      );
    } finally {
      restore();
    }
  });

  it("mode label uses the visual mode color token for VISUAL and V-LINE", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({}));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      sendKeys(editor, ["h", "i", "\x1b"]);
      editor.render(80);
      sendKeys(editor, ["v"]);
      editor.render(80);
      sendKeys(editor, ["V"]);
      editor.render(80);

      // Normal renders borderAccent; VISUAL and V-LINE both render the visual
      // default (customMessageLabel), never collapsing onto normal's color.
      assert.deepEqual(
        theme.fgCalls.map((call) => call.token),
        ["borderAccent", "customMessageLabel", "customMessageLabel"],
      );
    } finally {
      restore();
    }
  });

  it("mode label uses a custom insert mode color token", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({
      modeColors: { insert: "primary" },
    }));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      editor.render(80);

      assert.deepEqual(theme.fgCalls, [
        { token: "primary", text: reverseInsertLabel },
      ]);
    } finally {
      restore();
    }
  });

  it("mode label partial mode color overrides preserve default tokens", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({
      modeColors: { insert: "primary" },
    }));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      editor.render(80);
      sendKeys(editor, ["\x1b"]);
      editor.render(80);
      sendKeys(editor, [":"]);
      editor.render(80);

      assert.deepEqual(
        theme.fgCalls.map((call) => call.token),
        ["primary", "borderAccent", "warning"],
      );
    } finally {
      restore();
    }
  });

  it("mode label falls back when the EX mode color token is unknown", async () => {
    const theme = createRecordingTheme(["unknownToken"]);
    const restore = setPiVimSettingsReaderForTests(() => ({
      modeColors: { ex: "unknownToken" },
    }));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      sendKeys(editor, ["\x1b", ":"]);

      assert.doesNotThrow(() => editor.render(80));
      assert.deepEqual(
        theme.fgCalls.map((call) => call.token),
        ["unknownToken", "warning"],
      );
    } finally {
      restore();
    }
  });

  it("mode label passes reverse-video text to theme.fg", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({}));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );

      editor.render(80);

      assert.deepEqual(theme.fgCalls, [
        { token: "borderMuted", text: reverseInsertLabel },
      ]);
    } finally {
      restore();
    }
  });

  for (const [name, settings] of [
    ["absent", {}],
    ["false", { syncBorderColorWithMode: false }],
  ] as const) {
    it(`syncBorderColorWithMode ${name} keeps the original border color reference`, async () => {
      const theme = createRecordingTheme();
      const restore = setPiVimSettingsReaderForTests(() => settings);

      try {
        const extension = await installExtensionWithEditorFactory(theme);
        const editor = extension.editorFactory(
          stubTui,
          stubTheme,
          stubKeybindings,
        );
        const originalBorderColor = editor.borderColor;

        sendKeys(editor, ["\x1b", ":", "\x1b", "i"]);

        assert.equal(editor.borderColor, originalBorderColor);
      } finally {
        restore();
      }
    });
  }

  it("syncBorderColorWithMode true syncs border color across core transitions", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({
      modeColors: {
        insert: "insertToken",
        normal: "normalToken",
        ex: "exToken",
      },
      syncBorderColorWithMode: true,
    }));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );
      const originalBorderColor = editor.borderColor;

      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
      );

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<normalToken>border</normalToken>",
      );

      sendKeys(editor, [":"]);
      assert.equal(editor.borderColor("border"), "<exToken>border</exToken>");

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<normalToken>border</normalToken>",
      );

      sendKeys(editor, ["i"]);
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
      );
      assert.equal(editor.borderColor, originalBorderColor);
    } finally {
      restore();
    }
  });

  it("syncBorderColorWithMode true survives Pi host borderColor assignment", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({
      modeColors: {
        insert: "insertToken",
        normal: "normalToken",
        ex: "exToken",
      },
      syncBorderColorWithMode: true,
    }));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );
      const defaultEditorBorderColor = (text: string) =>
        `<hostBorder>${text}</hostBorder>`;

      // Pi's InteractiveMode.setCustomEditorComponent copies the default
      // editor's borderColor onto the extension editor after the factory
      // returns. With `true` the mode color always wins, regardless of what the
      // host assigned.
      editor.borderColor = defaultEditorBorderColor;
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
      );

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<normalToken>border</normalToken>",
      );

      sendKeys(editor, [":"]);
      assert.equal(editor.borderColor("border"), "<exToken>border</exToken>");
    } finally {
      restore();
    }
  });

  it("borderSync mode paints the mode color even while a thinking level is active", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: {
        insert: "insertToken",
        normal: "normalToken",
        ex: "exToken",
      },
      borderSync: allSurfaces("mode"),
    });

    try {
      // "mode" ignores the host border entirely: an active thinking level does
      // not stop pi-vim from painting each mode's color.
      editor.borderColor = (text: string) => theme.fg("thinkingHigh", text);

      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
      );

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<normalToken>border</normalToken>",
      );

      sendKeys(editor, [":"]);
      assert.equal(editor.borderColor("border"), "<exToken>border</exToken>");

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<normalToken>border</normalToken>",
      );

      sendKeys(editor, ["i"]);
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
      );
    } finally {
      restore();
    }
  });

  it("borderSync host (default) leaves the host border untouched", async () => {
    const theme = createRecordingTheme();
    // borderSync omitted → the all-"host" default; labelSync omitted → the
    // all-"mode" default. No border trap is installed.
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "insertToken", normal: "normalToken" },
    });

    try {
      const hostBorder = (text: string) => theme.fg("thinkingHigh", text);
      editor.borderColor = hostBorder;
      // The border property is exactly what the host assigned, and mode changes
      // never rewrite it.
      assert.equal(editor.borderColor, hostBorder);
      sendKeys(editor, ["\x1b", ":", "\x1b", "i"]);
      assert.equal(editor.borderColor, hostBorder);
      assert.equal(
        editor.borderColor("border"),
        "<thinkingHigh>border</thinkingHigh>",
      );
    } finally {
      restore();
    }
  });

  it("borderSync thinking recolors the neutral default and defers off -> on -> off", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "insertToken" },
      borderSync: allSurfaces("thinking"),
    });

    try {
      const off = (text: string) => theme.fg("thinkingOff", text);
      const high = (text: string) => theme.fg("thinkingHigh", text);

      editor.borderColor = off;
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
        "neutral base recolored with the mode color",
      );

      editor.borderColor = high;
      assert.equal(
        editor.borderColor("border"),
        "<thinkingHigh>border</thinkingHigh>",
        "active thinking level deferred to",
      );

      editor.borderColor = off;
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
        "returning to neutral re-applies the mode color",
      );
    } finally {
      restore();
    }
  });

  for (const [levelName, token] of [
    ["minimal", "thinkingMinimal"],
    ["high", "thinkingHigh"],
  ] as const) {
    it(`borderSync thinking defers to an active thinking level (${levelName})`, async () => {
      const theme = createRecordingTheme();
      const { editor, restore } = await createBorderEditor(theme, {
        modeColors: {},
        borderSync: allSurfaces("thinking"),
      });

      try {
        // An active thinking level carries a signal pi-vim must not clobber.
        // `minimal` is the critical case: it is a neutral gray, so only an exact
        // match against the "off" color (not a saturation test) can tell it
        // apart from the resting default.
        editor.borderColor = (text: string) => theme.fg(token, text);
        assert.equal(
          editor.borderColor("border"),
          `<${token}>border</${token}>`,
          `active ${levelName} border preserved in insert`,
        );

        sendKeys(editor, ["\x1b"]);
        assert.equal(
          editor.borderColor("border"),
          `<${token}>border</${token}>`,
          `active ${levelName} border preserved in normal`,
        );
      } finally {
        restore();
      }
    });
  }

  it("borderSync thinking defers to a third-party (non-thinking) border highlight", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: {},
      borderSync: allSurfaces("thinking"),
    });

    try {
      // Anything that is not the neutral resting default counts as "away from
      // rest" — a third-party highlight or bash-mode border is left untouched.
      editor.borderColor = (text: string) => `<custom>${text}</custom>`;
      assert.equal(editor.borderColor("border"), "<custom>border</custom>");
    } finally {
      restore();
    }
  });

  it("borderSync thinking paints each mode's own color when thinking is off", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "borderAccent", normal: "borderMuted" },
      borderSync: allSurfaces("thinking"),
    });

    try {
      editor.borderColor = (text: string) => theme.fg("thinkingOff", text);

      assert.equal(
        editor.borderColor("border"),
        "<borderAccent>border</borderAccent>",
        "insert (accent) paints its color when thinking is off",
      );

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<borderMuted>border</borderMuted>",
        "normal (muted) paints its color when thinking is off",
      );
    } finally {
      restore();
    }
  });

  it("labelSync mode (default) keeps the label mode color while the border defers", async () => {
    const theme = createRecordingTheme();
    // The border defers to thinking, but the label keeps its mode color under
    // the all-"mode" labelSync default.
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "insertToken" },
      borderSync: allSurfaces("thinking"),
    });

    try {
      editor.borderColor = (text: string) => theme.fg("thinkingHigh", text);
      theme.fgCalls.length = 0;
      editor.render(80);
      assert.equal(
        theme.fgCalls.at(-1)?.token,
        "insertToken",
        "label keeps its mode color even with thinking active",
      );
    } finally {
      restore();
    }
  });

  it("labelSync thinking defers the label to the host color, reverse-video wrapped", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "insertToken" },
      borderSync: allSurfaces("thinking"),
      labelSync: allSurfaces("thinking"),
    });

    try {
      // At rest (neutral host border) the label paints its own mode color, kept
      // in its reverse-video block.
      editor.borderColor = (text: string) => theme.fg("thinkingOff", text);
      theme.fgCalls.length = 0;
      let footer = editor.render(80).at(-1) ?? "";
      assert.equal(
        theme.fgCalls.at(-1)?.token,
        "insertToken",
        "label paints its mode color at rest",
      );
      assert.ok(
        footer.includes(`<insertToken>${reverseInsertLabel}</insertToken>`),
        "mode label keeps its reverse-video block styling at rest",
      );

      // With a level active the label inherits the host thinking color, still
      // reverse-video wrapped so it keeps its block styling.
      editor.borderColor = (text: string) => theme.fg("thinkingHigh", text);
      theme.fgCalls.length = 0;
      footer = editor.render(80).at(-1) ?? "";
      assert.equal(
        theme.fgCalls.at(-1)?.token,
        "thinkingHigh",
        "label inherits the active thinking color",
      );
      assert.ok(
        footer.includes("\x1b[7m<thinkingHigh> INSERT </thinkingHigh>\x1b[27m"),
        "deferred label wraps reverse-video around the host color",
      );
    } finally {
      restore();
    }
  });

  it("syncBorderColorWithMode true never defers to an active thinking level", async () => {
    const theme = createRecordingTheme();
    const restore = setPiVimSettingsReaderForTests(() => ({
      modeColors: { insert: "borderAccent", normal: "borderMuted" },
      syncBorderColorWithMode: true,
    }));

    try {
      const extension = await installExtensionWithEditorFactory(theme);
      const editor = extension.editorFactory(
        stubTui,
        stubTheme,
        stubKeybindings,
      );
      editor.borderColor = (text: string) => theme.fg("thinkingMinimal", text);

      assert.equal(
        editor.borderColor("border"),
        "<borderAccent>border</borderAccent>",
        "legacy `true` always applies the mode color",
      );

      sendKeys(editor, ["\x1b"]);
      assert.equal(
        editor.borderColor("border"),
        "<borderMuted>border</borderMuted>",
        "legacy `true` has no thinking detection",
      );
    } finally {
      restore();
    }
  });

  it("borderSync thinking: a visual mode paints on rest and defers to a level", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: {},
      borderSync: allSurfaces("thinking"),
    });

    try {
      editor.borderColor = (text: string) => theme.fg("thinkingOff", text);
      sendKeys(editor, ["h", "i", "\x1b", "v"]);
      assert.equal(
        editor.borderColor("border"),
        "<customMessageLabel>border</customMessageLabel>",
        "visual paints its default color when thinking is off",
      );

      editor.borderColor = (text: string) => theme.fg("thinkingMinimal", text);
      assert.equal(
        editor.borderColor("border"),
        "<thinkingMinimal>border</thinkingMinimal>",
        "visual defers to the active thinking level",
      );
    } finally {
      restore();
    }
  });

  it("legacy syncBorderColorWithMode inherit maps to thinking on both surfaces", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "insertToken" },
      syncBorderColorWithMode: "inherit",
    });

    try {
      const off = (text: string) => theme.fg("thinkingOff", text);
      const high = (text: string) => theme.fg("thinkingHigh", text);

      // Border: mode color at rest, host color while a level is active.
      editor.borderColor = off;
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
        "border paints the mode color at rest",
      );

      editor.borderColor = high;
      assert.equal(
        editor.borderColor("border"),
        "<thinkingHigh>border</thinkingHigh>",
        "border defers while a level is active",
      );

      // Label follows the same thinking policy.
      theme.fgCalls.length = 0;
      const footer = editor.render(80).at(-1) ?? "";
      assert.equal(
        theme.fgCalls.at(-1)?.token,
        "thinkingHigh",
        "label follows the same thinking policy",
      );
      assert.ok(
        footer.includes("\x1b[7m<thinkingHigh> INSERT </thinkingHigh>\x1b[27m"),
      );
    } finally {
      restore();
    }
  });

  it("a present borderSync wins over a legacy syncBorderColorWithMode", async () => {
    const theme = createRecordingTheme();
    const { editor, restore } = await createBorderEditor(theme, {
      modeColors: { insert: "insertToken" },
      borderSync: allSurfaces("mode"),
      // Legacy "inherit" would defer to an active level, but the new key wins.
      syncBorderColorWithMode: "inherit",
    });

    try {
      editor.borderColor = (text: string) => theme.fg("thinkingHigh", text);
      assert.equal(
        editor.borderColor("border"),
        "<insertToken>border</insertToken>",
        "borderSync mode is honored despite the active level and legacy key",
      );
    } finally {
      restore();
    }
  });

  for (const [name, commandKeys] of [
    ["i", ["i"]],
    ["a", ["a"]],
    ["A", ["A"]],
    ["I", ["I"]],
    ["o", ["o"]],
    ["O", ["O"]],
    ["C", ["C"]],
    ["S", ["S"]],
    ["s", ["s"]],
    ["cc", ["c", "c"]],
    ["cw", ["c", "w"]],
    ["ct space", ["0", "c", "t", " "]],
  ] as const) {
    it(`border updates for mode-changing commands: ${name}`, () => {
      assertInsertBorderAfterModeChangingCommand("alpha beta", [
        ...commandKeys,
      ]);
    });
  }
});

describe("cursor shape lifecycle", () => {
  it("registers cleanup on session_shutdown and not session_end", async () => {
    const extension = await installExtensionWithEditorFactory();

    assert.equal(extension.sessionShutdownHandlerCount, 1);
    assert.equal(extension.sessionEndHandlerCount, 0);
  });

  it("enables hardware cursor and restores the captured setting on legacy shutdown", async () => {
    const extension = await installExtensionWithEditorFactory();
    const tui = createCursorShapeTui({ initialShowHardwareCursor: false });
    const operations: string[] = [];
    const originalWrite = tui.terminal.write;
    const originalSetShowHardwareCursor = tui.setShowHardwareCursor;

    assert.ok(originalWrite, "expected terminal.write test stub");
    assert.ok(
      originalSetShowHardwareCursor,
      "expected setShowHardwareCursor test stub",
    );

    tui.terminal.write = (data: string) => {
      operations.push(`write:${data}`);
      originalWrite(data);
    };
    tui.setShowHardwareCursor = (show: boolean) => {
      operations.push(`set:${show}`);
      originalSetShowHardwareCursor(show);
    };

    const editor = extension.editorFactory(tui, stubTheme, stubKeybindings);

    assert.equal(editor instanceof ModalEditor, true);
    assert.equal(tui.getShowHardwareCursorCalls, 1);
    assert.deepEqual(tui.hardwareCursorValues, [true]);
    assert.deepEqual(tui.terminalWrites, []);

    await extension.emitShutdown();

    assert.deepEqual(tui.terminalWrites, [RESET_CURSOR_SHAPE]);
    assert.deepEqual(tui.hardwareCursorValues, [true, false]);
    assert.deepEqual(operations, [
      "set:true",
      `write:${RESET_CURSOR_SHAPE}`,
      "set:false",
    ]);
  });

  it("keeps hardware cursor visible for quit shutdown after Pi stop", async () => {
    const extension = await installExtensionWithEditorFactory();
    const tui = createCursorShapeTui({ initialShowHardwareCursor: false });
    const operations: string[] = [];
    const originalWrite = tui.terminal.write;
    const originalSetShowHardwareCursor = tui.setShowHardwareCursor;

    assert.ok(originalWrite, "expected terminal.write test stub");
    assert.ok(
      originalSetShowHardwareCursor,
      "expected setShowHardwareCursor test stub",
    );

    tui.terminal.write = (data: string) => {
      operations.push(`write:${data}`);
      originalWrite(data);
    };
    tui.setShowHardwareCursor = (show: boolean) => {
      operations.push(`set:${show}`);
      originalSetShowHardwareCursor(show);
    };

    extension.editorFactory(tui, stubTheme, stubKeybindings);
    operations.push("pi:show-cursor");

    await extension.emitShutdown({ type: "session_shutdown", reason: "quit" });

    assert.deepEqual(tui.terminalWrites, [
      RESET_CURSOR_SHAPE,
      SHOW_HARDWARE_CURSOR,
    ]);
    assert.deepEqual(tui.hardwareCursorValues, [true]);
    assert.deepEqual(operations, [
      "set:true",
      "pi:show-cursor",
      `write:${RESET_CURSOR_SHAPE}`,
      `write:${SHOW_HARDWARE_CURSOR}`,
    ]);
  });

  it("resets shape without guessing a previous setting when no getter exists", async () => {
    const extension = await installExtensionWithEditorFactory();
    const tui = createCursorShapeTui({ getShowHardwareCursor: false });
    const operations: string[] = [];
    const originalWrite = tui.terminal.write;
    const originalSetShowHardwareCursor = tui.setShowHardwareCursor;

    assert.ok(originalWrite, "expected terminal.write test stub");
    assert.ok(
      originalSetShowHardwareCursor,
      "expected setShowHardwareCursor test stub",
    );

    tui.terminal.write = (data: string) => {
      operations.push(`write:${data}`);
      originalWrite(data);
    };
    tui.setShowHardwareCursor = (show: boolean) => {
      operations.push(`set:${show}`);
      originalSetShowHardwareCursor(show);
    };

    extension.editorFactory(tui, stubTheme, stubKeybindings);

    assert.equal(tui.getShowHardwareCursorCalls, 0);
    assert.deepEqual(tui.hardwareCursorValues, [true]);

    await extension.emitShutdown();

    assert.deepEqual(tui.terminalWrites, [RESET_CURSOR_SHAPE]);
    assert.deepEqual(tui.hardwareCursorValues, [true]);
    assert.deepEqual(operations, ["set:true", `write:${RESET_CURSOR_SHAPE}`]);
  });

  it("skips startup enablement and cleanup cursor writes on unsupported runtimes", async () => {
    const extension = await installExtensionWithEditorFactory();
    const tui = createCursorShapeTui({ setShowHardwareCursor: false });

    extension.editorFactory(tui, stubTheme, stubKeybindings);

    assert.equal(tui.getShowHardwareCursorCalls, 0);
    assert.deepEqual(tui.hardwareCursorValues, []);

    await extension.emitShutdown();

    assert.deepEqual(tui.terminalWrites, []);
    assert.deepEqual(tui.hardwareCursorValues, []);
  });
});

describe("cursor shape rendering", () => {
  it("writes insert cursor shape and strips the EOL software cursor", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    focusEditor(editor);

    const lines = editor.render(20);
    const markerLine = findCursorMarkerLine(lines);

    assert.deepEqual(tui.terminalWrites, [INSERT_CURSOR_SHAPE]);
    assert.equal(tui.terminalWrites.includes(RESET_CURSOR_SHAPE), false);
    assert.equal(markerLine.includes(CURSOR_MARKER), true);
    assert.equal(markerLine.includes(SOFTWARE_CURSOR_SPACE), false);
    assert.equal(visibleWidth(removeCursorMarker(markerLine)), 20);
    assertNoCursorShapeSequences(lines);
  });

  it("preserves the character under the insert cursor", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    for (const char of "abc") {
      editor.handleInput(char);
    }
    focusEditor(editor);
    setInternalCursor(editor, 1);

    const lines = editor.render(20);
    const markerLine = findCursorMarkerLine(lines);
    const plainLine = removeCursorMarker(markerLine);

    assert.deepEqual(tui.terminalWrites, [INSERT_CURSOR_SHAPE]);
    assert.equal(markerLine.includes("\x1b[7mb\x1b[0m"), false);
    assert.equal(plainLine.startsWith("abc"), true);
    assert.equal(visibleWidth(plainLine), 20);
    assertNoCursorShapeSequences(lines);
  });

  it("writes normal block cursor shape and strips the software cursor", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    sendKeys(editor, ["a", "b", "\x1b"]);
    focusEditor(editor);

    const lines = editor.render(20);
    const markerLine = findCursorMarkerLine(lines);

    assert.deepEqual(tui.terminalWrites, [BLOCK_CURSOR_SHAPE]);
    assert.equal(markerLine.includes(SOFTWARE_CURSOR_SPACE), false);
    assertNoCursorShapeSequences(lines);
  });

  it("writes EX block cursor shape and preserves EX label rendering", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    sendKeys(editor, ["\x1b", ":"]);
    focusEditor(editor);

    const lines = editor.render(20);
    const markerLine = findCursorMarkerLine(lines);
    const footer = lines.at(-1) ?? "";

    assert.deepEqual(tui.terminalWrites, [BLOCK_CURSOR_SHAPE]);
    assert.ok(footer.includes(" EX :_ "));
    assert.equal(markerLine.includes(SOFTWARE_CURSOR_SPACE), false);
    assertNoCursorShapeSequences(lines);
  });

  it("caches repeated renders and writes only changed cursor shapes", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    focusEditor(editor);

    editor.render(20);
    editor.render(20);
    editor.handleInput("\x1b");
    editor.render(20);
    editor.render(20);
    editor.handleInput("i");
    editor.render(20);

    assert.deepEqual(tui.terminalWrites, [
      INSERT_CURSOR_SHAPE,
      BLOCK_CURSOR_SHAPE,
      INSERT_CURSOR_SHAPE,
    ]);
  });

  it("falls back to the software cursor when hardware cursor APIs are unsupported", () => {
    const tui = createCursorShapeTui({ setShowHardwareCursor: false });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    focusEditor(editor);

    const lines = editor.render(20);
    const markerLine = findCursorMarkerLine(lines);

    assert.deepEqual(tui.terminalWrites, []);
    assert.equal(markerLine.includes(SOFTWARE_CURSOR_SPACE), true);
    assertNoCursorShapeSequences(lines);
  });

  it("re-enables the hardware cursor when it has been disabled, restoring shape control", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: false });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    focusEditor(editor);

    const lines = editor.render(20);
    const markerLine = findCursorMarkerLine(lines);

    // pi-vim owns cursor shaping, so a disabled (but supported) hardware
    // cursor is re-enabled rather than falling back to a software block.
    assert.deepEqual(tui.hardwareCursorValues, [true]);
    assert.deepEqual(tui.terminalWrites, [INSERT_CURSOR_SHAPE]);
    assert.equal(tui.getShowHardwareCursorCalls, 1);
    assert.equal(markerLine.includes(SOFTWARE_CURSOR_SPACE), false);
    assertNoCursorShapeSequences(lines);
  });

  it("recovers cursor shape after the host disables the hardware cursor mid-session", () => {
    // Models the reload regression: pi re-applies showHardwareCursor=false
    // after pi-vim has already enabled it. The next render must re-assert and
    // re-write the shape instead of leaving a stuck software block cursor.
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    focusEditor(editor);

    editor.render(20);
    assert.deepEqual(tui.terminalWrites, [INSERT_CURSOR_SHAPE]);

    // Host (pi) disables the hardware cursor while the editor remains focused.
    tui.setShowHardwareCursor?.(false);
    tui.terminalWrites.length = 0;

    editor.render(20);
    assert.deepEqual(tui.hardwareCursorValues, [false, true]);
    assert.deepEqual(tui.terminalWrites, [INSERT_CURSOR_SHAPE]);
  });

  it("keeps the software cursor when focused render has no cursor marker", () => {
    const tui = createCursorShapeTui({ initialShowHardwareCursor: true });
    const editor = new ModalEditor(tui, stubTheme, stubKeybindings);
    const internal = editor as unknown as { autocompleteState?: string | null };
    internal.autocompleteState = "regular";
    focusEditor(editor);

    const lines = editor.render(20);

    assert.equal(
      lines.some((line) => line.includes(CURSOR_MARKER)),
      false,
    );
    assert.equal(
      lines.some((line) => line.includes(SOFTWARE_CURSOR_SPACE)),
      true,
    );
    assert.deepEqual(tui.terminalWrites, []);
    assertNoCursorShapeSequences(lines);
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

  it("clipboard helper reports Pi copyToClipboard throws via exit code 2", async () => {
    const helperSource = await getClipboardHelperSourceWithMock(
      [
        "export function copyToClipboard(text) {",
        '  process.stdout.write("copy:" + text);',
        '  throw new Error("clipboard backend failed");',
        "}",
      ].join("\n"),
    );

    const result = await runClipboardHelperSource(helperSource, "payload");

    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "copy:payload");
  });

  it("clipboard helper exits 0 when Pi copyToClipboard succeeds", async () => {
    const helperSource = await getClipboardHelperSourceWithMock(
      [
        "export function copyToClipboard(text) {",
        '  process.stdout.write("copy:" + text);',
        "}",
      ].join("\n"),
    );

    const result = await runClipboardHelperSource(helperSource, "payload");

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "copy:payload");
  });

  it("clipboard read helper treats no text as an empty successful read", async () => {
    const helperSource = await getClipboardReadHelperSourceWithMock(
      [
        "{",
        "  async hasText() { return false; },",
        '  async getText() { throw new Error("No string found"); },',
        "}",
      ].join("\n"),
    );

    const result = await runClipboardHelperSource(helperSource, "");

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
  });

  it("active clipboard write receives no abort event when superseded", async () => {
    const { editor } = createEditorWithSpy("foo bar baz");
    const activeWrite = deferred();
    const events: string[] = [];

    editor.setClipboardFn(async (text, signal) => {
      events.push(`start:${text}`);
      signal?.addEventListener(
        "abort",
        () => {
          events.push(`abort:${text}`);
        },
        { once: true },
      );

      if (text === "foo ") {
        await activeWrite.promise;
      }

      events.push(`end:${text}`);
    });

    sendKeys(editor, ["d", "w", "d", "w"]);

    try {
      await nextImmediate();

      assert.deepEqual(events, ["start:foo "]);
    } finally {
      activeWrite.resolve();
      await nextImmediate();
    }
  });

  it("three rapid clipboard writes keep first active and final pending text", async () => {
    const { editor } = createEditorWithSpy("foo bar baz qux");
    const firstWrite = deferred();
    const events: string[] = [];

    editor.setClipboardFn(async (text, signal) => {
      events.push(`start:${text}`);
      signal?.addEventListener(
        "abort",
        () => {
          events.push(`abort:${text}`);
        },
        { once: true },
      );

      if (text === "foo ") {
        await firstWrite.promise;
        if (signal?.aborted) {
          throw signal.reason ?? new Error("clipboard aborted");
        }
      }

      events.push(`end:${text}`);
    });

    sendKeys(editor, ["d", "w", "d", "w", "d", "w"]);
    firstWrite.resolve();
    await nextImmediate();

    assert.equal(editor.getText(), "qux");
    assert.equal(editor.getRegister(), "baz ");
    assert.deepEqual(events, [
      "start:foo ",
      "end:foo ",
      "start:baz ",
      "end:baz ",
    ]);
  });

  it("clipboard timeout abort still drains the latest pending text", async () => {
    const { editor } = createEditorWithSpy("foo bar baz qux");
    const finalWrite = deferred();
    const events: string[] = [];

    editor.setClipboardWriteTimeoutMs(5);
    editor.setClipboardFn(
      (text, signal) =>
        new Promise<void>((resolve, reject) => {
          events.push(`start:${text}`);
          signal?.addEventListener(
            "abort",
            () => {
              const reason =
                signal.reason instanceof Error
                  ? signal.reason.message
                  : String(signal.reason);
              events.push(`abort:${text}:${reason}`);
              reject(signal.reason ?? new Error("clipboard aborted"));
            },
            { once: true },
          );

          if (text === "foo ") {
            return;
          }

          events.push(`end:${text}`);
          if (text === "baz ") {
            finalWrite.resolve();
          }
          resolve();
        }),
    );

    sendKeys(editor, ["d", "w", "d", "w", "d", "w"]);
    await withTimeout(
      finalWrite.promise,
      100,
      "timed out waiting for clipboard drain to write latest pending text",
    );

    assert.equal(editor.getText(), "qux");
    assert.equal(editor.getRegister(), "baz ");
    assert.deepEqual(events, [
      "start:foo ",
      "abort:foo :clipboard write timed out",
      "start:baz ",
      "end:baz ",
    ]);
  });

  it("clipboard timeouts do not trip the spawn failure circuit breaker", async () => {
    const { editor } = createEditorWithSpy("one two three four five");
    const attempts: string[] = [];
    const expectedRegisters = ["one ", "two ", "three ", "four "];
    const aborts = new Map(expectedRegisters.map((text) => [text, deferred()]));

    editor.setClipboardWriteTimeoutMs(0);
    editor.setClipboardFn(
      (text, signal) =>
        new Promise<void>((_resolve, reject) => {
          attempts.push(text);
          const onAbort = () => {
            aborts.get(text)?.resolve();
            reject(createSpawnErrno("late spawn after timeout"));
          };

          if (signal?.aborted) {
            onAbort();
            return;
          }

          signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );

    for (const expectedRegister of expectedRegisters) {
      sendKeys(editor, ["d", "w"]);
      const abort = aborts.get(expectedRegister);
      assert.ok(abort, `abort deferred for ${expectedRegister}`);
      await withTimeout(
        abort.promise,
        100,
        `timed out waiting for clipboard timeout abort for ${expectedRegister}`,
      );
      assert.equal(editor.getRegister(), expectedRegister);
    }

    assert.equal(editor.getText(), "five");
    assert.deepEqual(attempts, expectedRegisters);
  });

  it("repeated spawn-classified clipboard failures stop mirroring while register writes continue", async () => {
    const { editor } = createEditorWithSpy("one two three four five");
    const attempts: string[] = [];

    try {
      editor.setClipboardFn(async (text) => {
        attempts.push(text);
        throw createSpawnErrno("spawn failed");
      });

      for (const expectedRegister of ["one ", "two ", "three "]) {
        sendKeys(editor, ["d", "w"]);
        await nextImmediate();
        assert.equal(editor.getRegister(), expectedRegister);
      }

      assert.deepEqual(attempts, ["one ", "two ", "three "]);

      sendKeys(editor, ["d", "w"]);
      await nextImmediate();

      assert.equal(editor.getText(), "five");
      assert.equal(editor.getRegister(), "four ");
      assert.deepEqual(attempts, ["one ", "two ", "three "]);
    } finally {
      editor.setClipboardFn(() => {});
    }
  });

  it("spawn-classified clipboard failures stop mirroring across editor instances", async () => {
    const first = createEditorWithSpy("one two three four five");
    const second = createEditorWithSpy("alpha beta");
    const attempts: string[] = [];
    const failSpawn = async (text: string) => {
      attempts.push(text);
      throw createSpawnErrno("spawn failed");
    };

    try {
      first.editor.setClipboardFn(failSpawn);
      second.editor.setClipboardFn(failSpawn);

      for (const expectedRegister of ["one ", "two ", "three "]) {
        sendKeys(first.editor, ["d", "w"]);
        await nextImmediate();
        assert.equal(first.editor.getRegister(), expectedRegister);
      }

      assert.deepEqual(attempts, ["one ", "two ", "three "]);

      sendKeys(second.editor, ["d", "w"]);
      await nextImmediate();

      assert.equal(second.editor.getText(), "beta");
      assert.equal(second.editor.getRegister(), "alpha ");
      assert.deepEqual(attempts, ["one ", "two ", "three "]);
    } finally {
      first.editor.setClipboardFn(() => {});
    }
  });

  it("repeated generic clipboard failures do not trip the spawn failure circuit breaker", async () => {
    const { editor } = createEditorWithSpy("one two three four five");
    const attempts: string[] = [];

    editor.setClipboardFn(async (text) => {
      attempts.push(text);
      throw new Error("clipboard backend failed");
    });

    for (const expectedRegister of ["one ", "two ", "three ", "four "]) {
      sendKeys(editor, ["d", "w"]);
      await nextImmediate();
      assert.equal(editor.getRegister(), expectedRegister);
    }

    assert.equal(editor.getText(), "five");
    assert.deepEqual(attempts, ["one ", "two ", "three ", "four "]);
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

describe("counted line-end operators — Nd$ / Nc$ / Nd0 / Nd^", () => {
  it("2d$ deletes charwise through the next line end", () => {
    const { editor } = createMultiLineEditor("hello world\nfoo bar\nbaz");
    setInternalCursor(editor, 6, 0);

    sendKeys(editor, ["2", "d", "$"]);

    assert.equal(editor.getText(), "hello \nbaz");
    assert.equal(editor.getRegister(), "world\nfoo bar");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("2d$ from column zero deletes whole lines (linewise register)", () => {
    const { editor } = createMultiLineEditor("hello world\nfoo bar\nbaz");
    setInternalCursor(editor, 0, 0);

    sendKeys(editor, ["2", "d", "$"]);

    assert.equal(editor.getText(), "baz");
    assert.equal(editor.getRegister(), "hello world\nfoo bar\n");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("2d$ on the last line is a no-op", () => {
    const { editor } = createMultiLineEditor("aa\nbbbb");
    setInternalCursor(editor, 1, 1);

    sendKeys(editor, ["2", "d", "$"]);

    assert.equal(editor.getText(), "aa\nbbbb");
    assert.equal(editor.getRegister(), "");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 1 });
  });

  it("d5$ uses the operator-side count and clamps to the last line", () => {
    const { editor } = createMultiLineEditor("aaa\nbbb\nccc");
    setInternalCursor(editor, 1, 0);

    sendKeys(editor, ["d", "5", "$"]);

    assert.equal(editor.getText(), "a");
    assert.equal(editor.getRegister(), "aa\nbbb\nccc");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("2c$ changes charwise through the next line end and enters insert", () => {
    const { editor } = createMultiLineEditor("hello world\nfoo bar\nbaz");
    setInternalCursor(editor, 6, 0);

    sendKeys(editor, ["2", "c", "$"]);
    assert.equal(editor.getMode(), "insert");
    sendKeys(editor, ["Z", "\x1b"]);

    assert.equal(editor.getText(), "hello Z\nbaz");
    assert.equal(editor.getRegister(), "world\nfoo bar");
  });

  it("2c$ from column zero stays charwise (never linewise)", () => {
    const { editor } = createMultiLineEditor("hello world\nfoo bar\nbaz");
    setInternalCursor(editor, 0, 0);

    sendKeys(editor, ["2", "c", "$", "Z", "\x1b"]);

    assert.equal(editor.getText(), "Z\nbaz");
    assert.equal(editor.getRegister(), "hello world\nfoo bar");
  });

  it("2d0 ignores the count and deletes back to line start", () => {
    const { editor } = createMultiLineEditor("  foo bar");
    setInternalCursor(editor, 6, 0);

    sendKeys(editor, ["2", "d", "0"]);

    assert.equal(editor.getText(), "bar");
    assert.equal(editor.getRegister(), "  foo ");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("2d^ ignores the count and deletes back to first non-blank", () => {
    const { editor } = createMultiLineEditor("  foo bar");
    setInternalCursor(editor, 6, 0);

    sendKeys(editor, ["2", "d", "^"]);

    assert.equal(editor.getText(), "  bar");
    assert.equal(editor.getRegister(), "foo ");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
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

  it("counted yank text objects cancel without mutation or register writes", () => {
    const scenarios = [
      { name: "y2aw", keys: ["y", "2", "a", "w"] },
      { name: "2yaw", keys: ["2", "y", "a", "w"] },
      { name: "y2aW", keys: ["y", "2", "a", "W"] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy("foo bar");
      const beforeCursor = editor.getCursor();
      editor.setRegister("seed");

      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), "foo bar", `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
    }
  });

  it("normal keys work after counted yank text-object cancellation", () => {
    const { editor } = createEditorWithSpy("foo bar");

    sendKeys(editor, ["y", "2", "a", "w", "x"]);

    assert.equal(editor.getText(), "oo bar");
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
    const editor = createEditorAtBufferEnd(`top\n${wrappedLine}\nbottom`);

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

describe("halfway motion — gM / {count}gM", () => {
  it("gM moves to halfway the text of the line", () => {
    const { editor } = createEditorWithSpy("0123456789");

    sendKeys(editor, ["g", "M"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("50gMx consumes the count and deletes exactly one character", () => {
    const { editor } = createEditorWithSpy("0123456789");

    sendKeys(editor, ["5", "0", "g", "M", "x"]);

    assert.equal(editor.getText(), "012346789");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
    assert.equal(editor.getRegister(), "5");
  });

  it("20gM moves to that percentage of the line text", () => {
    const { editor } = createEditorWithSpy("0123456789");

    sendKeys(editor, ["2", "0", "g", "M"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("100gM clamps to the final character", () => {
    const { editor } = createEditorWithSpy("0123456789");

    sendKeys(editor, ["1", "0", "0", "g", "M"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 9 });
  });

  it("150gM ignores counts above 100 and moves halfway", () => {
    const { editor } = createEditorWithSpy("0123456789");

    sendKeys(editor, ["1", "5", "0", "g", "M"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("gM stays put on an empty line", () => {
    const { editor } = createEditorWithSpy("");

    sendKeys(editor, ["g", "M"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("gM counts graphemes, not code units", () => {
    const { editor } = createEditorWithSpy("😀😀😀😀");

    sendKeys(editor, ["g", "M"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
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
  const paragraphFixture =
    "alpha one\nalpha two\n\n   \nbeta one\nbeta two\n\ngamma one\n\n   ";

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

describe("matching pair motion", () => {
  it("% on opening delimiter jumps to closing partner", () => {
    const { editor } = createEditorWithSpy("foo(bar)");

    sendKeys(editor, ["w", "%"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
  });

  it("% on closing delimiter jumps to opening partner", () => {
    const { editor } = createEditorWithSpy("foo(bar)");
    setInternalCursor(editor, 7);

    sendKeys(editor, ["%"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("% before a delimiter scans forward and jumps to the partner", () => {
    const { editor } = createEditorWithSpy("foo (bar)");

    sendKeys(editor, ["%"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 8 });
  });

  it("% with no source delimiter on the current line no-ops", () => {
    const { editor } = createMultiLineEditor("foo bar\n(baz)");

    sendKeys(editor, ["%"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("% with an unmatched source delimiter no-ops", () => {
    const { editor } = createEditorWithSpy("foo(bar");
    setInternalCursor(editor, 3);

    sendKeys(editor, ["%"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("% at visible EOL after a closing delimiter jumps to opening partner", () => {
    const { editor } = createEditorWithSpy("foo(bar)");
    setInternalCursor(editor, 8);

    sendKeys(editor, ["%"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("{count}% consumes count without affecting the next key", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["3", "%", "x"]);

    assert.equal(editor.getText(), "bcdef");
    assert.equal(editor.getRegister(), "a");
  });

  it("no-op % preserves buffer text and unnamed register", () => {
    const { editor } = createEditorWithSpy("foo bar");
    editor.setRegister("seed");

    sendKeys(editor, ["%"]);

    assert.equal(editor.getText(), "foo bar");
    assert.equal(editor.getRegister(), "seed");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("matching pair operator motion d% deletes forward inclusive range", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo(bar)baz");
    setInternalCursor(editor, 3);

    sendKeys(editor, ["d", "%"]);

    assert.equal(editor.getText(), "foobaz");
    assert.equal(editor.getRegister(), "(bar)");
    assert.deepEqual(clipboardWrites, ["(bar)"]);
  });

  it("matching pair operator motion d% deletes backward inclusive range", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo(bar)baz");
    setInternalCursor(editor, 7);

    sendKeys(editor, ["d", "%"]);

    assert.equal(editor.getText(), "foobaz");
    assert.equal(editor.getRegister(), "(bar)");
    assert.deepEqual(clipboardWrites, ["(bar)"]);
  });

  it("matching pair operator motion d% scan-forward anchors at original cursor", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("xx foo(bar) zz");
    setInternalCursor(editor, 3);

    sendKeys(editor, ["d", "%"]);

    assert.equal(editor.getText(), "xx  zz");
    assert.equal(editor.getRegister(), "foo(bar)");
    assert.deepEqual(clipboardWrites, ["foo(bar)"]);
  });

  it("matching pair operator motion y% yanks forward without mutation", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo(bar)baz");
    setInternalCursor(editor, 3);

    sendKeys(editor, ["y", "%"]);

    assert.equal(editor.getText(), "foo(bar)baz");
    assert.equal(editor.getRegister(), "(bar)");
    assert.deepEqual(clipboardWrites, ["(bar)"]);
  });

  it("matching pair operator motion y% yanks backward without mutation", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo(bar)baz");
    setInternalCursor(editor, 7);

    sendKeys(editor, ["y", "%"]);

    assert.equal(editor.getText(), "foo(bar)baz");
    assert.equal(editor.getRegister(), "(bar)");
    assert.deepEqual(clipboardWrites, ["(bar)"]);
  });

  it("matching pair operator motion c% deletes range and enters insert mode", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("foo(bar)baz");
    setInternalCursor(editor, 3);

    sendKeys(editor, ["c", "%"]);

    assert.equal(editor.getText(), "foobaz");
    assert.equal(editor.getRegister(), "(bar)");
    assert.equal(editor.getMode(), "insert");
    assert.deepEqual(clipboardWrites, ["(bar)"]);
  });

  it("matching pair operator motion follows clipboard mirror yank policy", () => {
    const deletion = createEditorWithSpy("foo(bar)baz");
    deletion.editor.setClipboardMirrorPolicy("yank");
    setInternalCursor(deletion.editor, 3);

    sendKeys(deletion.editor, ["d", "%"]);

    assert.equal(deletion.editor.getRegister(), "(bar)");
    assert.deepEqual(deletion.clipboardWrites, []);

    const yank = createEditorWithSpy("foo(bar)baz");
    yank.editor.setClipboardMirrorPolicy("yank");
    setInternalCursor(yank.editor, 3);

    sendKeys(yank.editor, ["y", "%"]);

    assert.equal(yank.editor.getRegister(), "(bar)");
    assert.deepEqual(yank.clipboardWrites, ["(bar)"]);

    const change = createEditorWithSpy("foo(bar)baz");
    change.editor.setClipboardMirrorPolicy("yank");
    setInternalCursor(change.editor, 3);

    sendKeys(change.editor, ["c", "%"]);

    assert.equal(change.editor.getRegister(), "(bar)");
    assert.deepEqual(change.clipboardWrites, []);
  });

  it("matching pair operator motion no-target cancellation preserves text and register", () => {
    for (const operator of ["d", "y", "c"] as const) {
      const { editor, clipboardWrites } = createEditorWithSpy("foo(bar");
      editor.setRegister("seed");
      setInternalCursor(editor, 3);

      sendKeys(editor, [operator, "%"]);

      assert.equal(editor.getText(), "foo(bar");
      assert.equal(editor.getRegister(), "seed");
      assert.equal(editor.getMode(), "normal");
      assert.deepEqual(clipboardWrites, []);

      sendKeys(editor, ["x"]);

      assert.equal(editor.getText(), "foobar");
      assert.equal(editor.getRegister(), "(");
      assert.deepEqual(clipboardWrites, ["("]);
    }
  });

  it("matching pair operator motion counted forms cancel and clear stale state", () => {
    const cases = [
      ["d", "2", "%"],
      ["2", "d", "%"],
      ["y", "2", "%"],
      ["2", "y", "%"],
      ["c", "2", "%"],
      ["2", "c", "%"],
    ];

    for (const keys of cases) {
      const { editor, clipboardWrites } = createEditorWithSpy("foo(bar)");
      editor.setRegister("seed");

      sendKeys(editor, keys);

      assert.equal(editor.getText(), "foo(bar)");
      assert.equal(editor.getRegister(), "seed");
      assert.equal(editor.getMode(), "normal");
      assert.deepEqual(clipboardWrites, []);

      sendKeys(editor, ["x"]);

      assert.equal(editor.getText(), "oo(bar)");
      assert.equal(editor.getRegister(), "f");
      assert.deepEqual(clipboardWrites, ["f"]);
    }
  });

  it("matching pair operator motion d% at visible EOL avoids the following newline", () => {
    const { editor, clipboardWrites } = createMultiLineEditor("foo(bar)\nnext");
    setInternalCursor(editor, 8);

    sendKeys(editor, ["d", "%"]);

    assert.equal(editor.getText(), "foo\nnext");
    assert.equal(editor.getRegister(), "(bar)");
    assert.deepEqual(clipboardWrites, ["(bar)"]);
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

  it("d2iw spans a word and the following whitespace run", () => {
    // nvim counts consecutive class runs: `2iw` on `foo` is `foo` + the space.
    chk("foo bar baz", ["d", "2", "i", "w"], "bar baz", "foo ");
  });

  it("d3iw spans word, whitespace, and the next word", () => {
    chk("foo bar baz", ["d", "3", "i", "w"], " baz", "foo bar");
  });

  it("daw deletes word + trailing spaces", () => {
    chk("foo bar", ["d", "a", "w"], "bar", "foo ");
  });

  it("daw from the final word includes leading whitespace", () => {
    const { editor } = createEditorWithSpy("foo bar");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "a", "w"]);

    assert.equal(editor.getText(), "foo");
    assert.equal(editor.getRegister(), " bar");
  });

  it("diw from whitespace selects the whitespace run", () => {
    // nvim: on whitespace, `iw` is the whitespace run itself, not the next word.
    const { editor } = createEditorWithSpy("foo   bar");

    setInternalCursor(editor, 3);
    sendKeys(editor, ["d", "i", "w"]);

    assert.equal(editor.getText(), "foobar");
    assert.equal(editor.getRegister(), "   ");
  });

  it("daw from whitespace adds the following word", () => {
    // nvim: on whitespace, `aw` is the whitespace run plus the following word.
    const { editor } = createEditorWithSpy("foo   bar baz");

    setInternalCursor(editor, 3);
    sendKeys(editor, ["d", "a", "w"]);

    assert.equal(editor.getText(), "foo baz");
    assert.equal(editor.getRegister(), "   bar");
  });

  it("diw on punctuation selects only the punctuation run", () => {
    // nvim: on `.`, `iw` deletes just the punctuation, not the next word.
    const { editor } = createEditorWithSpy("foo.bar");

    setInternalCursor(editor, 3);
    sendKeys(editor, ["d", "i", "w"]);

    assert.equal(editor.getText(), "foobar");
    assert.equal(editor.getRegister(), ".");
  });

  it("diw keeps accented and CJK letters in one word", () => {
    const accented = createEditorWithSpy("café au").editor;
    sendKeys(accented, ["d", "i", "w"]);
    assert.equal(accented.getText(), " au");
    assert.equal(accented.getRegister(), "café");

    const cjk = createEditorWithSpy("中文 test").editor;
    sendKeys(cjk, ["d", "i", "w"]);
    assert.equal(cjk.getText(), " test");
    assert.equal(cjk.getRegister(), "中文");
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
// WORD text objects — iW / aW with d/c/y
// ---------------------------------------------------------------------------

describe("WORD text objects — iW / aW", () => {
  it("ciW changes a punctuation-containing WORD and enters insert mode", () => {
    const { editor } = createEditorWithSpy("foo path/to-file bar");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["c", "i", "W"]);

    assert.equal(editor.getRegister(), "path/to-file");
    assert.equal(editor.getText(), "foo  bar");
    assert.equal(editor.getMode(), "insert");
  });

  it("diW deletes a flag WORD without surrounding whitespace", () => {
    const { editor } = createEditorWithSpy("foo --flag=value bar");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "i", "W"]);

    assert.equal(editor.getRegister(), "--flag=value");
    assert.equal(editor.getText(), "foo  bar");
  });

  it("yiW yanks a WORD without mutation", () => {
    const { editor } = createEditorWithSpy("foo path/to-file bar");
    const before = editor.getText();

    setInternalCursor(editor, 4);
    sendKeys(editor, ["y", "i", "W"]);

    assert.equal(editor.getRegister(), "path/to-file");
    assert.equal(editor.getText(), before);
  });

  it("daW includes trailing whitespace when present", () => {
    const { editor } = createEditorWithSpy("foo path/to-file bar");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "a", "W"]);

    assert.equal(editor.getRegister(), "path/to-file ");
    assert.equal(editor.getText(), "foo bar");
  });

  it("daW includes leading whitespace when no trailing whitespace exists", () => {
    const { editor } = createEditorWithSpy("foo path/to-file");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "a", "W"]);

    assert.equal(editor.getRegister(), " path/to-file");
    assert.equal(editor.getText(), "foo");
  });

  it("d2iW spans a WORD and the following whitespace run", () => {
    // nvim `2iW` counts consecutive runs: the WORD plus the trailing space.
    const { editor } = createEditorWithSpy("foo path/to-file --flag=value bar");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "2", "i", "W"]);

    assert.equal(editor.getRegister(), "path/to-file ");
    assert.equal(editor.getText(), "foo --flag=value bar");
  });

  it("d2aW spans two WORDs with their whitespace", () => {
    const { editor } = createEditorWithSpy("foo path/to-file --flag=value bar");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "2", "a", "W"]);

    assert.equal(editor.getRegister(), "path/to-file --flag=value ");
    assert.equal(editor.getText(), "foo bar");
  });

  it("diW on whitespace selects the whitespace run", () => {
    // nvim: on whitespace, `iW` is the whitespace run, not the next WORD.
    const { editor: next } = createEditorWithSpy("foo   path/to-file");
    const { editor: trailing } = createEditorWithSpy("foo/path   ");

    setInternalCursor(next, 3);
    sendKeys(next, ["d", "i", "W"]);

    assert.equal(next.getRegister(), "   ");
    assert.equal(next.getText(), "foopath/to-file");

    setInternalCursor(trailing, 8);
    sendKeys(trailing, ["d", "i", "W"]);

    assert.equal(trailing.getRegister(), "   ");
    assert.equal(trailing.getText(), "foo/path");
  });

  it("no-ops a counted WORD it cannot satisfy without crossing lines", () => {
    // pi-vim keeps word objects inside the logical line, so `2iW` on a line with
    // a single WORD has no second run to extend over. An unsatisfiable count is
    // a no-op (register preserved), not a partial delete; the cursor drops on
    // the last char of the line, matching nvim's failed-object cursor move.
    const { editor } = createMultiLineEditor("foo/path\nbar/baz");

    sendKeys(editor, ["d", "2", "i", "W"]);

    assert.equal(editor.getText(), "foo/path\nbar/baz");
    assert.equal(editor.getRegister(), "");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
  });
});

// ---------------------------------------------------------------------------
// Quote text objects — i\" / a\" / i' / a' / i` / a` with d/c/y
// ---------------------------------------------------------------------------

describe("quote text objects", () => {
  it("supports double-quote text objects on the current quoted string", () => {
    const scenarios = [
      {
        name: 'ci"',
        keys: ["c", "i", '"'],
        expectedText: 'say "" now',
        expectedRegister: "hello",
        expectedMode: "insert",
        expectedCursor: { line: 0, col: 5 },
      },
      {
        name: 'di"',
        keys: ["d", "i", '"'],
        expectedText: 'say "" now',
        expectedRegister: "hello",
        expectedMode: "normal",
        expectedCursor: { line: 0, col: 5 },
      },
      {
        name: 'yi"',
        keys: ["y", "i", '"'],
        expectedText: 'say "hello" now',
        expectedRegister: "hello",
        expectedMode: "normal",
        expectedCursor: { line: 0, col: 6 },
      },
      {
        name: 'ca"',
        keys: ["c", "a", '"'],
        expectedText: "say  now",
        expectedRegister: '"hello"',
        expectedMode: "insert",
        expectedCursor: { line: 0, col: 4 },
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy('say "hello" now');
      setInternalCursor(editor, 6);

      sendKeys(editor, scenario.keys);

      assert.equal(
        editor.getText(),
        scenario.expectedText,
        `${scenario.name} text`,
      );
      assert.equal(
        editor.getRegister(),
        scenario.expectedRegister,
        `${scenario.name} register`,
      );
      assert.equal(
        editor.getMode(),
        scenario.expectedMode,
        `${scenario.name} mode`,
      );
      assert.deepEqual(
        editor.getCursor(),
        scenario.expectedCursor,
        `${scenario.name} cursor`,
      );
    }
  });

  it("supports single quotes and backticks", () => {
    const scenarios = [
      {
        name: "single quotes",
        initial: "say 'hello' now",
        keys: ["d", "i", "'"],
        expectedText: "say '' now",
      },
      {
        name: "backticks",
        initial: "say `hello` now",
        keys: ["y", "i", "`"],
        expectedText: "say `hello` now",
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);
      setInternalCursor(editor, 6);

      sendKeys(editor, scenario.keys);

      assert.equal(
        editor.getText(),
        scenario.expectedText,
        `${scenario.name} text`,
      );
      assert.equal(editor.getRegister(), "hello", `${scenario.name} register`);
    }
  });

  it("ignores escaped quote delimiters", () => {
    const initial = String.raw`say \"not\" "yes" now`;
    const { editor } = createEditorWithSpy(initial);

    setInternalCursor(editor, 14);
    sendKeys(editor, ["d", "i", '"']);

    assert.equal(editor.getText(), String.raw`say \"not\" "" now`);
    assert.equal(editor.getRegister(), "yes");
  });

  it("does not pair quotes across logical lines", () => {
    const initial = 'say "hello\nworld" now';
    const { editor } = createMultiLineEditor(initial);
    const beforeCursor = { line: 0, col: 5 };
    editor.setRegister("seed");

    setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
    sendKeys(editor, ["d", "i", '"']);

    assert.equal(editor.getText(), initial);
    assert.equal(editor.getRegister(), "seed");
    assert.deepEqual(editor.getCursor(), beforeCursor);
  });

  it("empty inner quotes no-op for delete and yank", () => {
    const scenarios = [
      { name: "delete", keys: ["d", "i", '"'] },
      { name: "yank", keys: ["y", "i", '"'] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy('say "" now');
      const beforeCursor = { line: 0, col: 4 };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), 'say "" now', `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });

  it("empty inner quote change enters insert at the inner start", () => {
    const { editor } = createEditorWithSpy('say "" now');
    editor.setRegister("seed");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["c", "i", '"']);

    assert.equal(editor.getText(), 'say "" now');
    assert.equal(editor.getRegister(), "seed");
    assert.equal(editor.getMode(), "insert");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("counted quote text objects cancel without mutation or register writes", () => {
    const { editor } = createEditorWithSpy('say "hello" now');
    const beforeCursor = { line: 0, col: 6 };
    editor.setRegister("seed");

    setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
    sendKeys(editor, ["d", "2", "i", '"']);

    assert.equal(editor.getText(), 'say "hello" now');
    assert.equal(editor.getRegister(), "seed");
    assert.deepEqual(editor.getCursor(), beforeCursor);
    assert.equal(editor.getMode(), "normal");
  });
});

// ---------------------------------------------------------------------------
// Bracket text objects — i( / a( / i[ / a[ / i{ / a{ aliases
// ---------------------------------------------------------------------------

describe("bracket text objects", () => {
  it("supports representative change, delete, and yank bracket text objects", () => {
    const scenarios = [
      {
        name: "ci(",
        initial: "call(foo) now",
        cursorCol: 6,
        keys: ["c", "i", "("],
        expectedText: "call() now",
        expectedRegister: "foo",
        expectedMode: "insert",
        expectedCursor: { line: 0, col: 5 },
      },
      {
        name: "da(",
        initial: "call(foo) now",
        cursorCol: 6,
        keys: ["d", "a", "("],
        expectedText: "call now",
        expectedRegister: "(foo)",
        expectedMode: "normal",
        expectedCursor: { line: 0, col: 4 },
      },
      {
        name: "yi[",
        initial: "arr[foo] now",
        cursorCol: 5,
        keys: ["y", "i", "["],
        expectedText: "arr[foo] now",
        expectedRegister: "foo",
        expectedMode: "normal",
        expectedCursor: { line: 0, col: 5 },
      },
      {
        name: "ya{",
        initial: "obj {foo} now",
        cursorCol: 7,
        keys: ["y", "a", "{"],
        expectedText: "obj {foo} now",
        expectedRegister: "{foo}",
        expectedMode: "normal",
        expectedCursor: { line: 0, col: 7 },
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);

      setInternalCursor(editor, scenario.cursorCol);
      sendKeys(editor, scenario.keys);

      assert.equal(
        editor.getText(),
        scenario.expectedText,
        `${scenario.name} text`,
      );
      assert.equal(
        editor.getRegister(),
        scenario.expectedRegister,
        `${scenario.name} register`,
      );
      assert.equal(
        editor.getMode(),
        scenario.expectedMode,
        `${scenario.name} mode`,
      );
      assert.deepEqual(
        editor.getCursor(),
        scenario.expectedCursor,
        `${scenario.name} cursor`,
      );
    }
  });

  it("supports closing delimiter aliases and b/B aliases", () => {
    const scenarios = [
      {
        name: ") alias",
        initial: "call(foo)",
        cursorCol: 6,
        keys: ["d", "i", ")"],
        expectedText: "call()",
      },
      {
        name: "b alias",
        initial: "call(foo)",
        cursorCol: 6,
        keys: ["d", "i", "b"],
        expectedText: "call()",
      },
      {
        name: "] alias",
        initial: "arr[foo]",
        cursorCol: 5,
        keys: ["d", "i", "]"],
        expectedText: "arr[]",
      },
      {
        name: "} alias",
        initial: "obj{foo}",
        cursorCol: 5,
        keys: ["d", "i", "}"],
        expectedText: "obj{}",
      },
      {
        name: "B alias",
        initial: "obj{foo}",
        cursorCol: 5,
        keys: ["d", "i", "B"],
        expectedText: "obj{}",
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);

      setInternalCursor(editor, scenario.cursorCol);
      sendKeys(editor, scenario.keys);

      assert.equal(
        editor.getText(),
        scenario.expectedText,
        `${scenario.name} text`,
      );
      assert.equal(editor.getRegister(), "foo", `${scenario.name} register`);
    }
  });

  it("uses the smallest nested parenthesis pair", () => {
    const { editor } = createEditorWithSpy("a(b(c)d)e");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["d", "i", "("]);

    assert.equal(editor.getText(), "a(b()d)e");
    assert.equal(editor.getRegister(), "c");
  });

  it("yanks cross-line brace ranges", () => {
    const initial = "fn {\n  x\n}\nend";
    const { editor } = createMultiLineEditor(initial);

    setInternalCursor(editor, 2, 1);
    sendKeys(editor, ["y", "a", "{"]);

    assert.equal(editor.getText(), initial);
    assert.equal(editor.getRegister(), "{\n  x\n}");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
  });

  it("counts the cursor on either delimiter as inside", () => {
    const scenarios = [
      { name: "opening delimiter", cursorCol: 4 },
      { name: "closing delimiter", cursorCol: 8 },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy("call(foo)");

      setInternalCursor(editor, scenario.cursorCol);
      sendKeys(editor, ["d", "i", "("]);

      assert.equal(editor.getText(), "call()", `${scenario.name} text`);
      assert.equal(editor.getRegister(), "foo", `${scenario.name} register`);
    }
  });

  it("empty inner brackets no-op for delete and yank", () => {
    const scenarios = [
      { name: "delete", keys: ["d", "i", "("] },
      { name: "yank", keys: ["y", "i", "("] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy("call() now");
      const beforeCursor = { line: 0, col: 4 };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), "call() now", `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });

  it("empty inner bracket change enters insert at the inner start", () => {
    const { editor } = createEditorWithSpy("call() now");
    editor.setRegister("seed");

    setInternalCursor(editor, 4);
    sendKeys(editor, ["c", "i", "("]);

    assert.equal(editor.getText(), "call() now");
    assert.equal(editor.getRegister(), "seed");
    assert.equal(editor.getMode(), "insert");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("counted bracket text objects cancel without mutation or register writes", () => {
    const scenarios = [
      {
        name: "2ci(",
        initial: "call(foo)",
        cursorCol: 6,
        keys: ["2", "c", "i", "("],
      },
      {
        name: "y2a{",
        initial: "obj{foo}",
        cursorCol: 5,
        keys: ["y", "2", "a", "{"],
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);
      const beforeCursor = { line: 0, col: scenario.cursorCol };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), scenario.initial, `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });
});

describe("delimited text objects at end of line", () => {
  it("resolves bracket objects from $ on a non-final line", () => {
    const { editor } = createMultiLineEditor("call(foo)\nbar");

    sendKeys(editor, ["$", "d", "i", "("]);

    assert.equal(editor.getText(), "call()\nbar");
    assert.equal(editor.getRegister(), "foo");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("resolves quote objects from $ on a non-final line", () => {
    const { editor } = createMultiLineEditor('say "hi"\nnext');

    sendKeys(editor, ["$", "d", "i", '"']);

    assert.equal(editor.getText(), 'say ""\nnext');
    assert.equal(editor.getRegister(), "hi");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("resolves delimiter objects from $ on the final non-empty line", () => {
    const scenarios = [
      {
        name: "bracket",
        initial: "before\ncall(foo)",
        cursorLine: 1,
        keys: ["$", "d", "i", "("],
        expectedText: "before\ncall()",
        expectedRegister: "foo",
        expectedCursor: { line: 1, col: 5 },
      },
      {
        name: "quote",
        initial: 'before\nsay "hi"',
        cursorLine: 1,
        keys: ["$", "d", "i", '"'],
        expectedText: 'before\nsay ""',
        expectedRegister: "hi",
        expectedCursor: { line: 1, col: 5 },
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createMultiLineEditor(scenario.initial);

      setInternalCursor(editor, 0, scenario.cursorLine);
      sendKeys(editor, scenario.keys);

      assert.equal(
        editor.getText(),
        scenario.expectedText,
        `${scenario.name} text`,
      );
      assert.equal(
        editor.getRegister(),
        scenario.expectedRegister,
        `${scenario.name} register`,
      );
      assert.deepEqual(
        editor.getCursor(),
        scenario.expectedCursor,
        `${scenario.name} cursor`,
      );
    }
  });

  it("cancels delimiter objects from a final empty trailing-newline line", () => {
    const scenarios = [
      { name: "bracket", keys: ["d", "i", "("] },
      { name: "quote", keys: ["c", "i", '"'] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createMultiLineEditor("call(foo)\n");
      const beforeCursor = { line: 1, col: 0 };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), "call(foo)\n", `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });

  it("cancels delimiter objects in an empty buffer", () => {
    const scenarios = [
      { name: "delete quote", keys: ["d", "i", '"'] },
      { name: "change bracket", keys: ["c", "i", "("] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy("");
      const beforeCursor = { line: 0, col: 0 };
      editor.setRegister("seed");

      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), "", `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });
});

describe("text object cancellation hardening", () => {
  it("unsupported object keys after di, ci, and yi cancel before the next normal key", () => {
    const scenarios = [
      { name: "diq", keys: ["d", "i", "q"] },
      { name: "ciq", keys: ["c", "i", "q"] },
      { name: "yiq", keys: ["y", "i", "q"] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy("foo bar");
      const beforeCursor = editor.getCursor();
      editor.setRegister("seed");

      sendKeys(editor, scenario.keys);

      assert.equal(
        editor.getText(),
        "foo bar",
        `${scenario.name} cancellation text`,
      );
      assert.equal(
        editor.getRegister(),
        "seed",
        `${scenario.name} cancellation register`,
      );
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cancellation cursor`,
      );
      assert.equal(
        editor.getMode(),
        "normal",
        `${scenario.name} cancellation mode`,
      );

      sendKeys(editor, ["x"]);

      assert.equal(
        editor.getText(),
        "oo bar",
        `${scenario.name} next key text`,
      );
      assert.equal(
        editor.getRegister(),
        "f",
        `${scenario.name} next key register`,
      );
    }
  });

  it("unmatched delimiters cancel without mutation or register writes", () => {
    const scenarios = [
      {
        name: 'di"',
        initial: 'say "hello',
        cursorCol: 5,
        keys: ["d", "i", '"'],
      },
      {
        name: "ci(",
        initial: "call(foo",
        cursorCol: 6,
        keys: ["c", "i", "("],
      },
      {
        name: "yi{",
        initial: "obj {foo",
        cursorCol: 6,
        keys: ["y", "i", "{"],
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);
      const beforeCursor = { line: 0, col: scenario.cursorCol };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), scenario.initial, `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });

  it("unmatched delimiter cancellation is not sticky", () => {
    const initial = 'say "hello';
    const { editor } = createEditorWithSpy(initial);
    const beforeCursor = { line: 0, col: 5 };
    editor.setRegister("seed");

    setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
    sendKeys(editor, ["d", "i", '"']);

    assert.equal(editor.getText(), initial);
    assert.equal(editor.getRegister(), "seed");
    assert.deepEqual(editor.getCursor(), beforeCursor);

    sendKeys(editor, ["x"]);

    assert.equal(editor.getText(), 'say "ello');
    assert.equal(editor.getRegister(), "h");
  });

  it("counted delimited examples cancel without mutation or register writes", () => {
    const scenarios = [
      {
        name: 'd2i"',
        initial: 'say "hello" now',
        cursorCol: 6,
        keys: ["d", "2", "i", '"'],
      },
      {
        name: "2ci(",
        initial: "call(foo)",
        cursorCol: 6,
        keys: ["2", "c", "i", "("],
      },
      {
        name: "y2a{",
        initial: "obj {foo}",
        cursorCol: 6,
        keys: ["y", "2", "a", "{"],
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);
      const beforeCursor = { line: 0, col: scenario.cursorCol };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), scenario.initial, `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
  });

  it("counted yank word and WORD text objects remain unsupported", () => {
    const scenarios = [
      {
        name: "y2iw",
        initial: "foo bar",
        cursorCol: 0,
        keys: ["y", "2", "i", "w"],
      },
      {
        name: "2yiW",
        initial: "foo path/to-file bar",
        cursorCol: 4,
        keys: ["2", "y", "i", "W"],
      },
    ];

    for (const scenario of scenarios) {
      const { editor } = createEditorWithSpy(scenario.initial);
      const beforeCursor = { line: 0, col: scenario.cursorCol };
      editor.setRegister("seed");

      setInternalCursor(editor, beforeCursor.col, beforeCursor.line);
      sendKeys(editor, scenario.keys);

      assert.equal(editor.getText(), scenario.initial, `${scenario.name} text`);
      assert.equal(editor.getRegister(), "seed", `${scenario.name} register`);
      assert.deepEqual(
        editor.getCursor(),
        beforeCursor,
        `${scenario.name} cursor`,
      );
      assert.equal(editor.getMode(), "normal", `${scenario.name} mode`);
    }
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

  it("x keeps the cursor on the next character after deleting in the middle", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["l", "l", "x"]);

    assert.equal(editor.getText(), "abd");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("x moves back by one grapheme after deleting the last character", () => {
    const { editor } = createEditorWithSpy("a😀b");

    setInternalCursor(editor, 3);
    sendKeys(editor, ["x"]);

    assert.equal(editor.getText(), "a😀");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("X deletes the char before the cursor and lands where it began", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["l", "l", "X"]);

    assert.equal(editor.getText(), "acd");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("X at column 0 is a no-op", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["X"]);

    assert.equal(editor.getText(), "abc");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("X deletes a whole grapheme before the cursor", () => {
    const { editor } = createEditorWithSpy("a😀b");

    setInternalCursor(editor, 3);
    sendKeys(editor, ["X"]);

    assert.equal(editor.getText(), "ab");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("X: register written correctly", () => {
    const { editor, clipboardWrites } = createEditorWithSpy("hello");
    sendKeys(editor, ["l", "X"]);
    assert.deepEqual(clipboardWrites, ["h"]);
  });

  it("X is dot-repeatable", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["$", "X", "."]);

    assert.equal(editor.getText(), "abcf");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
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

describe("dot repeat — .", () => {
  it("repeats the last single-key normal-mode edit", () => {
    const { editor } = createEditorWithSpy("abcd");

    sendKeys(editor, ["x", "."]);

    assert.equal(editor.getText(), "cd");
    assert.equal(editor.getRegister(), "b");
  });

  it("replays the original command count when repeating a counted edit", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["2", "x", "."]);

    assert.equal(editor.getText(), "ef");
    assert.equal(editor.getRegister(), "cd");
  });

  it("uses a count before . to replace the stored command count", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["2", "x", "3", "."]);

    assert.equal(editor.getText(), "f");
    assert.equal(editor.getRegister(), "cde");
  });

  it("uses a count before . to replace operator counts", () => {
    const { editor } = createEditorWithSpy("one two three four five six seven");

    sendKeys(editor, ["2", "d", "w", "3", "."]);

    assert.equal(editor.getText(), "six seven");
    assert.equal(editor.getRegister(), "three four five ");
  });

  it("uses a count before . to replace motion counts after operators", () => {
    const { editor } = createEditorWithSpy("one two three four five six seven");

    sendKeys(editor, ["d", "2", "w", "3", "."]);

    assert.equal(editor.getText(), "six seven");
    assert.equal(editor.getRegister(), "three four five ");
  });

  it("repeats operator-pending changes including their motions", () => {
    const { editor } = createEditorWithSpy("one two three");

    sendKeys(editor, ["d", "w", "."]);

    assert.equal(editor.getText(), "three");
    assert.equal(editor.getRegister(), "two ");
  });

  it("repeats text-object deletes", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    // diw deletes `foo`, leaving the cursor on the following space; `.` repeats
    // diw on that whitespace run (a single space), matching nvim.
    sendKeys(editor, ["d", "i", "w", "."]);

    assert.equal(editor.getText(), "bar baz");
    assert.equal(editor.getRegister(), " ");
  });

  it("repeats text-object changes with captured insert text", () => {
    const { editor } = createEditorWithSpy("foo bar baz");

    sendKeys(editor, ["c", "i", "w", "X", "\x1b", "w", "."]);

    assert.equal(editor.getText(), "X X baz");
    assert.equal(editor.getMode(), "normal");
  });

  it("repeats put commands", () => {
    const p = createEditorWithSpy("abc").editor;
    p.setRegister("X");
    sendKeys(p, ["p", "."]);

    const P = createEditorWithSpy("abc").editor;
    P.setRegister("X");
    sendKeys(P, ["P", "."]);

    assert.equal(p.getText(), "aXXbc");
    assert.equal(P.getText(), "XXabc");
  });

  it("repeats line joins", () => {
    const join = createMultiLineEditor("a\nb\nc").editor;
    sendKeys(join, ["J", "."]);

    const rawJoin = createMultiLineEditor("a\nb\nc").editor;
    sendKeys(rawJoin, ["g", "J", "."]);

    assert.equal(join.getText(), "a b c");
    assert.equal(rawJoin.getText(), "abc");
  });

  it("uses a count before . to replace counted line joins", () => {
    const join = createMultiLineEditor("a\nb\nc\nd\ne").editor;

    sendKeys(join, ["2", "J", "3", "."]);

    assert.equal(join.getText(), "a b c d\ne");
  });

  it("repeats replace commands with their replacement character", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["r", "Z", "l", "."]);

    assert.equal(editor.getText(), "ZZc");
    assert.equal(editor.getMode(), "normal");
  });

  it("repeats insert text captured by an insert-mode change", () => {
    const { editor } = createEditorWithSpy("X");

    sendKeys(editor, ["i", "a", "b", "c", "\x1b", "0", "."]);

    assert.equal(editor.getText(), "abcabcX");
    assert.equal(editor.getMode(), "normal");
  });

  it("does not let non-mutating yanks replace the last repeatable change", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["x", "Y", "."]);

    assert.equal(editor.getText(), "c");
    assert.equal(editor.getRegister(), "b");
  });

  it("does not enter insert mode or replace repeat after failed c{char-motion}", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["x", "c", "f", "z", "X", "\x1b", "."]);

    assert.equal(editor.getText(), "c");
    assert.equal(editor.getMode(), "normal");
    assert.equal(editor.getRegister(), "b");
  });

  it("drops stale repeat recording when bracketed paste cancels pending input", () => {
    const { editor } = createEditorWithSpy("abc");

    sendKeys(editor, ["c", "\x1b[200~paste\x1b[201~", "x", "."]);

    assert.equal(editor.getText(), "c");
    assert.equal(editor.getMode(), "normal");
    assert.equal(editor.getRegister(), "b");
  });
});

describe("Universal Counts: Edits and Put", () => {
  it("3x deletes three chars under cursor", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["3", "x"]);

    assert.equal(editor.getText(), "def");
    assert.equal(editor.getRegister(), "abc");
  });

  it("2X deletes two chars before the cursor", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["l", "l", "l", "2", "X"]);

    assert.equal(editor.getText(), "adef");
    assert.equal(editor.getRegister(), "bc");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("9X clamps at the line start", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["l", "l", "9", "X"]);

    assert.equal(editor.getText(), "cdef");
    assert.equal(editor.getRegister(), "ab");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("2x near EOL deletes only available chars", () => {
    const { editor } = createEditorWithSpy("abcdef");

    sendKeys(editor, ["l", "l", "l", "l", "2", "x"]);

    assert.equal(editor.getText(), "abcd");
    assert.equal(editor.getRegister(), "ef");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
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
    setInternalCursor(editor, 5);

    sendKeys(editor, ["3", "h"]);

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
  it("$ moves to the last character instead of past EOL", () => {
    const { editor } = createEditorWithSpy("hello");

    sendKeys(editor, ["$"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
  });

  it("$ moves to the start of the last grapheme", () => {
    const { editor } = createEditorWithSpy("a😀");

    sendKeys(editor, ["$"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("$x deletes the last character and moves back", () => {
    const { editor } = createEditorWithSpy("hello");

    sendKeys(editor, ["$", "x"]);

    assert.equal(editor.getRegister(), "o");
    assert.equal(editor.getText(), "hell");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("D at past-EOL captures '\\n' in register when next line exists", () => {
    const { editor, clipboardWrites } = createMultiLineEditor("line1\nline2");
    setInternalCursor(editor, 5);

    sendKeys(editor, ["D"]);

    assert.equal(editor.getRegister(), "\n");
    assert.deepEqual(clipboardWrites, ["\n"]);
    assert.equal(editor.getText(), "line1line2");
  });

  it("d$ at past-EOL matches D behavior (captures newline and joins lines)", () => {
    const { editor, clipboardWrites } = createMultiLineEditor("line1\nline2");
    setInternalCursor(editor, 5);

    sendKeys(editor, ["d", "$"]);

    assert.equal(editor.getRegister(), "\n");
    assert.deepEqual(clipboardWrites, ["\n"]);
    assert.equal(editor.getText(), "line1line2");
  });

  it("D at past-EOL on last line is a no-op (register stays empty)", () => {
    const { editor } = createEditorWithSpy("hello");
    setInternalCursor(editor, 5);

    sendKeys(editor, ["D"]);

    assert.equal(editor.getRegister(), "");
    assert.equal(editor.getText(), "hello");
  });

  it("x at past-EOL position is a no-op (does not join next line)", () => {
    const { editor } = createMultiLineEditor("line1\nline2");
    setInternalCursor(editor, 5);
    const before = editor.getText();

    sendKeys(editor, ["x"]);

    assert.equal(editor.getText(), before);
    assert.equal(editor.getRegister(), "");
  });

  it("x on last char of line deletes only that char, does not join lines", () => {
    const { editor } = createMultiLineEditor("line1\nline2");
    // "e" motion: end of word in "line1" → col 4 ('1')
    sendKeys(editor, ["e", "x"]);
    assert.equal(editor.getRegister(), "1");
    assert.equal(editor.getText(), "line\nline2"); // only '1' gone, newline intact
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });
});

// ---------------------------------------------------------------------------
// Word motion path selection (line-local fast path vs canonical fallback)
// ---------------------------------------------------------------------------

describe("word motion path selection", () => {
  it("line-local w avoids canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["w"]);
    assert.equal(calls, 0);
  });

  it("line-local e avoids canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["e"]);
    assert.equal(calls, 0);
  });

  it("line-local b avoids canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");
    sendKeys(editor, ["w"]);

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
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
      const raw = getRawEditor(editor);
      const original = raw.wordBoundaryCache.tryFindTarget.bind(
        raw.wordBoundaryCache,
      );
      let seenSemanticClass: string | null = null;

      raw.wordBoundaryCache.tryFindTarget = (...args: TryFindTargetArgs) => {
        seenSemanticClass = String(args[4] ?? "");
        return original(...args);
      };

      if (scenario.setup) {
        sendKeys(editor, scenario.setup);
      }
      sendKeys(editor, [scenario.motion]);
      assert.equal(
        seenSemanticClass,
        "WORD",
        `${scenario.motion} should use WORD class`,
      );
    }
  });

  it("cache uncertainty falls back to canonical absolute scanner", () => {
    const { editor } = createEditorWithSpy("alpha beta");

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
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

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["w"]);
    assert.ok(calls > 0);
  });

  it("e at EOL falls back to canonical absolute scanner", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["$"]);

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["e"]);
    assert.ok(calls > 0);
  });

  it("b from BOL falls back to canonical absolute scanner", () => {
    const { editor } = createMultiLineEditor("foo\nbar");
    sendKeys(editor, ["j", "0"]);

    const raw = getRawEditor(editor);
    const original = raw.findWordTargetInText.bind(raw);
    let calls = 0;

    raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
      calls++;
      return original(...args);
    };

    sendKeys(editor, ["b"]);
    assert.ok(calls > 0);
  });

  it("W/E at EOL and B at BOL fall back to canonical absolute scanner", () => {
    const scenarios: Array<{
      name: string;
      initial: string;
      setup: string[];
      motion: string;
    }> = [
      { name: "W@EOL", initial: "foo\nbar", setup: ["$"], motion: "W" },
      { name: "E@EOL", initial: "foo\nbar", setup: ["$"], motion: "E" },
      { name: "B@BOL", initial: "foo\nbar", setup: ["j", "0"], motion: "B" },
    ];

    for (const scenario of scenarios) {
      const { editor } = createMultiLineEditor(scenario.initial);
      const raw = getRawEditor(editor);
      const original = raw.findWordTargetInText.bind(raw);
      let calls = 0;

      raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
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
    const scenarios: Array<{ name: string; initial: string; keys: string[] }> =
      [
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
      const raw = getRawEditor(editor);
      const original = raw.findWordTargetInText.bind(raw);
      let calls = 0;

      raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
        calls++;
        return original(...args);
      };

      sendKeys(editor, scenario.keys);
      assert.equal(calls, 0, `${scenario.name} should stay line-local`);
    }
  });

  it("cross-line operator word motions fall back to canonical scanner", () => {
    const scenarios: Array<{
      name: string;
      initial: string;
      keys: string[];
      cursor?: { line: number; col: number };
    }> = [
      {
        name: "dw@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["d", "w"],
      },
      {
        name: "cw@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["c", "w"],
      },
      {
        name: "yw@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["y", "w"],
      },
      { name: "db@BOL", initial: "foo\nbar", keys: ["j", "0", "d", "b"] },
      { name: "cb@BOL", initial: "foo\nbar", keys: ["j", "0", "c", "b"] },
      { name: "yb@BOL", initial: "foo\nbar", keys: ["j", "0", "y", "b"] },
      {
        name: "dW@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["d", "W"],
      },
      {
        name: "cW@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["c", "W"],
      },
      {
        name: "yW@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["y", "W"],
      },
      {
        name: "dE@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["d", "E"],
      },
      {
        name: "cE@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["c", "E"],
      },
      {
        name: "yE@EOL",
        initial: "foo\nbar",
        cursor: { line: 0, col: 3 },
        keys: ["y", "E"],
      },
      { name: "dB@BOL", initial: "foo\nbar", keys: ["j", "0", "d", "B"] },
      { name: "cB@BOL", initial: "foo\nbar", keys: ["j", "0", "c", "B"] },
      { name: "yB@BOL", initial: "foo\nbar", keys: ["j", "0", "y", "B"] },
    ];

    for (const scenario of scenarios) {
      const { editor } = createMultiLineEditor(scenario.initial);
      if (scenario.cursor) {
        setInternalCursor(editor, scenario.cursor.col, scenario.cursor.line);
      }
      const raw = getRawEditor(editor);
      const original = raw.findWordTargetInText.bind(raw);
      let calls = 0;

      raw.findWordTargetInText = (...args: FindWordTargetInTextArgs) => {
        calls++;
        return original(...args);
      };

      sendKeys(editor, scenario.keys);
      assert.ok(calls > 0, `${scenario.name} should fall back`);
    }
  });
});

describe("word-motion fast path differential", () => {
  const assertFastEqualsCanonical = (
    initial: string,
    keys: string[],
    label: string,
  ): void => {
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
    const scenarios: Array<{ name: string; initial: string; keys: string[] }> =
      [
        { name: "W@EOL", initial: "foo\nbar", keys: ["$", "W", "x"] },
        { name: "2W@EOL", initial: "foo\nbar baz", keys: ["$", "2", "W", "x"] },
        { name: "E@EOL", initial: "foo\nbar", keys: ["$", "E", "x"] },
        { name: "2E@EOL", initial: "foo\nbar baz", keys: ["$", "2", "E", "x"] },
        { name: "B@BOL", initial: "foo\nbar", keys: ["j", "0", "B", "x"] },
        {
          name: "2B@BOL",
          initial: "foo bar\nbaz",
          keys: ["j", "0", "2", "B", "x"],
        },
        { name: "dW@EOL", initial: "foo\nbar", keys: ["$", "d", "W"] },
        {
          name: "cW@EOL",
          initial: "foo\nbar",
          keys: ["$", "c", "W", "X", "\x1b"],
        },
        { name: "yW@EOL", initial: "foo\nbar", keys: ["$", "y", "W", "p"] },
        { name: "dE@EOL", initial: "foo\nbar", keys: ["$", "d", "E"] },
        {
          name: "cE@EOL",
          initial: "foo\nbar",
          keys: ["$", "c", "E", "X", "\x1b"],
        },
        { name: "yE@EOL", initial: "foo\nbar", keys: ["$", "y", "E", "p"] },
        { name: "dB@BOL", initial: "foo\nbar", keys: ["j", "0", "d", "B"] },
        {
          name: "cB@BOL",
          initial: "foo\nbar",
          keys: ["j", "0", "c", "B", "X", "\x1b"],
        },
        {
          name: "yB@BOL",
          initial: "foo\nbar",
          keys: ["j", "0", "y", "B", "p"],
        },
      ];

    for (const scenario of scenarios) {
      assertFastEqualsCanonical(scenario.initial, scenario.keys, scenario.name);
    }
  });
});

describe("word-motion guard boundary regressions", () => {
  const assertFastEqualsCanonical = (
    initial: string,
    keys: string[],
    label: string,
  ): void => {
    const fast = runScenario(initial, keys, "fast");
    const canonical = runScenario(initial, keys, "canonical");
    assert.deepEqual(fast, canonical, label);
  };

  it("matches canonical behavior at EOL/BOL + punctuation/whitespace/empty boundaries", () => {
    const cases: Array<{ label: string; initial: string; keys: string[] }> = [
      {
        label: "EOL cross-line dw",
        initial: "foo\nbar",
        keys: ["$", "d", "w"],
      },
      {
        label: "BOL cross-line yb",
        initial: "foo\nbar",
        keys: ["j", "0", "y", "b"],
      },
      {
        label: "EOL cross-line dW",
        initial: "foo\nbar",
        keys: ["$", "d", "W"],
      },
      {
        label: "EOL cross-line yE",
        initial: "foo\nbar",
        keys: ["$", "y", "E", "p"],
      },
      {
        label: "BOL cross-line cB",
        initial: "foo\nbar",
        keys: ["j", "0", "c", "B", "X", "\x1b"],
      },
      {
        label: "punctuation run (word)",
        initial: "foo---bar",
        keys: ["w", "x"],
      },
      {
        label: "punctuation run (WORD)",
        initial: "foo---bar",
        keys: ["W", "x"],
      },
      {
        label: "whitespace run (word)",
        initial: "foo     bar",
        keys: ["w", "x"],
      },
      {
        label: "whitespace run (WORD)",
        initial: "foo     bar",
        keys: ["W", "x"],
      },
      { label: "empty line (word)", initial: "", keys: ["w", "d", "w"] },
      { label: "empty line (WORD)", initial: "", keys: ["W", "d", "W"] },
      {
        label: "blank-middle-line W",
        initial: "foo\n\nbar",
        keys: ["$", "W", "x"],
      },
      {
        label: "blank-middle-line B",
        initial: "foo\n\nbar",
        keys: ["j", "j", "0", "B", "x"],
      },
      {
        label: "WORD punctuation + whitespace boundary",
        initial: "foo--bar   baz",
        keys: ["W", "E", "x"],
      },
    ];

    for (const testCase of cases) {
      assertFastEqualsCanonical(
        testCase.initial,
        testCase.keys,
        testCase.label,
      );
    }
  });

  it("keeps insert-mode behavior unaffected", () => {
    assertFastEqualsCanonical(
      "hello",
      ["i", "X", "Y", "\x1b", "x"],
      "insert mode",
    );
  });

  it("keeps non-word command behavior unaffected", () => {
    assertFastEqualsCanonical(
      "foo",
      ["x", "P", "f", "o", "x"],
      "non-word commands",
    );
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
  it("P uses the internal register while a local clipboard mirror is pending", async () => {
    const { editor } = createEditorWithSpy("foo bar");
    const activeWrite = deferred();
    const writes: string[] = [];

    editor.setClipboardFn(async (text) => {
      writes.push(text);
      await activeWrite.promise;
    });
    editor.setClipboardReadFn(() => "OLD");

    try {
      sendKeys(editor, ["d", "w", "P"]);

      assert.equal(editor.getText(), "foo bar");
      assert.equal(editor.getRegister(), "foo ");
      assert.deepEqual(writes, ["foo "]);
    } finally {
      activeWrite.resolve();
      await nextImmediate();
    }
  });

  it("P reads the OS clipboard again after a local mirror settles", async () => {
    const { editor } = createEditorWithSpy("foo bar");
    const writes: string[] = [];

    editor.setClipboardFn((text) => {
      writes.push(text);
    });
    editor.setClipboardReadFn(() => "OLD");

    sendKeys(editor, ["d", "w"]);
    await nextImmediate();

    editor.setClipboardReadFn(() => "SYS");
    sendKeys(editor, ["P"]);

    assert.equal(editor.getText(), "SYSbar");
    assert.equal(editor.getRegister(), "foo ");
    assert.deepEqual(writes, ["foo "]);
  });

  it("p reads OS clipboard text instead of stale internal register", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "SYS");

    sendKeys(editor, ["p"]);

    assert.equal(editor.getText(), "aSYSb");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("P reads OS clipboard text instead of stale internal register", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "SYS");

    sendKeys(editor, ["P"]);

    assert.equal(editor.getText(), "SYSab");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("p falls back to internal register when OS clipboard read returns null", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => null);

    sendKeys(editor, ["p"]);

    assert.equal(editor.getText(), "ashadowb");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
  });

  it("p falls back to internal register when OS clipboard read throws", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => {
      throw new Error("clipboard read failed");
    });

    sendKeys(editor, ["p"]);

    assert.equal(editor.getText(), "ashadowb");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
  });

  it("p treats empty OS clipboard as successful empty paste", () => {
    const { editor } = createEditorWithSpy("ab");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "");

    sendKeys(editor, ["p"]);

    assert.equal(editor.getText(), "ab");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("counted empty OS clipboard paste consumes the count", () => {
    const { editor } = createEditorWithSpy("abcd");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "");

    sendKeys(editor, ["3", "p", "l"]);

    assert.equal(editor.getText(), "abcd");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("3p repeats OS clipboard text instead of stale internal register", () => {
    const { editor } = createEditorWithSpy("X");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "ab");

    sendKeys(editor, ["3", "p"]);

    assert.equal(editor.getText(), "Xababab");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
  });

  it("3P repeats OS clipboard text instead of stale internal register", () => {
    const { editor } = createEditorWithSpy("X");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "ab");

    sendKeys(editor, ["3", "P"]);

    assert.equal(editor.getText(), "abababX");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
  });

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
  it("p treats OS clipboard text ending in newline as linewise", () => {
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "X\n");

    sendKeys(editor, ["p"]);

    assert.equal(editor.getText(), "a\nX\nb");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
  });

  it("P treats OS clipboard text ending in newline as linewise", () => {
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("shadow");
    editor.setClipboardReadFn(() => "X\n");

    sendKeys(editor, ["P"]);

    assert.equal(editor.getText(), "X\na\nb");
    assert.equal(editor.getRegister(), "shadow");
    assert.equal(editor.getMode(), "normal");
  });

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
    assert.deepStrictEqual(lines, [
      "aaa",
      "bbb",
      "ccc",
      "ddd",
      "aaa",
      "bbb",
      "ccc",
    ]);
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

  it("yyp leaves the cursor on the first non-blank of the pasted line below", () => {
    // Vim: line-wise `p` lands on the first inserted line, not the last typed
    // char. Regression for the yyp end-of-line cursor bug (issue #39).
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["y", "y", "p"]);
    assert.equal(editor.getText(), "hello\nhello");
    assert.equal(editor.getMode(), "normal");
    assert.equal(editor.getRegister(), "hello\n");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  });

  it("yyP leaves the cursor on the first non-blank of the pasted line above", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["y", "y", "P"]);
    assert.equal(editor.getText(), "hello\nhello");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("yyp cursor honors an indented line's first non-blank column", () => {
    const { editor } = createEditorWithSpy("  hello");
    sendKeys(editor, ["y", "y", "p"]);
    assert.equal(editor.getText(), "  hello\n  hello");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
  });

  it("counted line-wise p lands on the first pasted line", () => {
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("X\n");
    sendKeys(editor, ["3", "p"]);
    assert.equal(editor.getText(), "a\nX\nX\nX\nb");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  });

  it("counted line-wise P lands on the first pasted line", () => {
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("X\n");
    sendKeys(editor, ["j", "3", "P"]);
    assert.equal(editor.getText(), "a\nX\nX\nX\nb");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  });

  it("multi-line line-wise register lands on the first pasted line", () => {
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("X\nY\n");
    sendKeys(editor, ["p"]);
    assert.equal(editor.getText(), "a\nX\nY\nb");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  });

  it("line-wise put with a leading-whitespace first line lands on its first non-blank", () => {
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("  foo\n");
    sendKeys(editor, ["p"]);
    assert.equal(editor.getText(), "a\n  foo\nb");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
  });

  it("line-wise put with an all-whitespace first line lands at col 0 (^ divergence)", () => {
    // Documented divergence: Vim's `^` puts the cursor on the last char of an
    // all-whitespace line, but the shared first-non-blank helper returns col 0.
    const { editor } = createMultiLineEditor("a\nb");
    editor.setRegister("   \nyz\n");
    sendKeys(editor, ["p"]);
    assert.equal(editor.getText(), "a\n   \nyz\nb");
    assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  });
});

// ---------------------------------------------------------------------------
// Undo / redo — u / ctrl+r  (Task 6)
// ---------------------------------------------------------------------------

/**
 * Reset undo/redo history to a clean slate after fixture setup.
 *
 * The shared fixtures (`createEditorWithSpy` / `createMultiLineEditor`)
 * populate the buffer by typing in INSERT mode, which leaves fish-style
 * word-coalesced snapshots behind. For tests that assert undo behavior from
 * a known state (e.g. "second `u` is a no-op"), clear that setup history so
 * the seeded content behaves like a loaded buffer rather than typed text.
 */
function resetUndoHistory(editor: ModalEditor): void {
  const raw = editor as unknown as {
    undoStack?: { clear?: () => void; stack: unknown[] };
  };
  raw.undoStack?.clear?.();
  if (raw.undoStack?.stack) raw.undoStack.stack.length = 0;
}

describe("undo / redo — u / ctrl+r", () => {
  it("u in normal mode does not insert the letter 'u'", () => {
    // u must not be treated as a printable char — it must forward ctrl+_ to super
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["u"]);
    assert.ok(
      !editor.getText().includes("uhello") &&
        editor.getText().length <= before.length,
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
    assert.deepEqual(afterPutCursor, { line: 0, col: 2 });

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
      expectedCursor: { line: 0, col: 1 },
      expectedRegister: "X",
      before: (editor) => editor.setRegister("X"),
    });
  });

  it("redo parity: P restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "ab",
      keys: ["P"],
      expectedText: "Xab",
      expectedCursor: { line: 0, col: 0 },
      expectedRegister: "X",
      before: (editor) => editor.setRegister("X"),
    });
  });

  it("redo parity: cw restores text, cursor, and register", () => {
    assertRedoRoundTrip({
      initial: "hello world",
      keys: ["c", "w", "Z", "\x1b"],
      expectedText: "Zworld",
      expectedCursor: { line: 0, col: 0 },
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
    function seedStaleRedo(options: { initial: string; multiLine?: boolean }): {
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
      assert.equal(
        editor.getText(),
        initial,
        "redo setup should restore initial text",
      );

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
        assert.equal(
          editor.getText(),
          scenario.expectedText,
          `${scenario.name} mutates text`,
        );

        sendKeys(editor, ["\x12"]);
        assert.equal(
          editor.getText(),
          scenario.expectedText,
          `${scenario.name} clears redo`,
        );
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
            assert.equal(
              editor.getText(),
              "abcd",
              "undo transition keeps redo stack",
            );

            sendKeys(editor, ["\x12", "\x12"]);
            assert.equal(
              editor.getText(),
              "cd",
              "undo transition keeps both redo entries",
            );
          },
        },
        {
          name: "redo transition",
          run: (editor) => {
            sendKeys(editor, ["x", "x", "x"]);
            sendKeys(editor, ["u", "u", "u"]);
            assert.equal(editor.getText(), "abcd", "redo transition setup");

            sendKeys(editor, ["2", "\x12"]);
            assert.equal(
              editor.getText(),
              "cd",
              "redo transition keeps stepwise redo",
            );

            sendKeys(editor, ["u"]);
            assert.equal(
              editor.getText(),
              "bcd",
              "redo transition keeps undo boundaries",
            );
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
            assert.equal(
              editor.getText(),
              staleRedoText,
              "navigation preserves redo",
            );
          },
        },
        {
          name: "yank",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["y", "y", "\x12"]);
            assert.equal(
              editor.getText(),
              staleRedoText,
              "yank preserves redo",
            );
          },
        },
        {
          name: "failed motion",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["f", "z", "\x12"]);
            assert.equal(
              editor.getText(),
              staleRedoText,
              "failed motion preserves redo",
            );
          },
        },
        {
          name: "mode toggle",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["i", "\x1b", "\x12"]);
            assert.equal(
              editor.getText(),
              staleRedoText,
              "mode toggle preserves redo",
            );
          },
        },
        {
          name: "no-op redo",
          run: (editor, staleRedoText) => {
            sendKeys(editor, ["\x12"]);
            assert.equal(
              editor.getText(),
              staleRedoText,
              "redo setup should replay once",
            );

            sendKeys(editor, ["\x12"]);
            assert.equal(
              editor.getText(),
              staleRedoText,
              "no-op redo does not mutate",
            );

            sendKeys(editor, ["u", "\x12"]);
            assert.equal(
              editor.getText(),
              staleRedoText,
              "no-op redo keeps history intact",
            );
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
    assert.ok(
      editor.getText().includes("u"),
      "u in insert mode must insert character",
    );
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

      const raw = getRawEditor(editor);
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

      const raw = getRawEditor(editor);
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

      const raw = getRawEditor(editor);
      const saved = raw.pushUndoSnapshot;
      raw.pushUndoSnapshot = undefined;

      try {
        assert.throws(() => sendKeys(editor, ["\x12"]), /pushUndoSnapshot/i);
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

  // -------------------------------------------------------------------------
  // Insert-session undo scope — an entire insert session (enter insert → <Esc>)
  // and a whole change command (cw/cc/s/o…) collapse to a single undo unit.
  //
  // Oracle-gap note: undo *scope* cannot be verified against the existing nvim
  // oracle, which seeds via a whole-buffer set and feeds one batched key stream:
  // the seed merges with the first change and multi-change / dot-repeat runs
  // collapse into a single undo block. These cases therefore stay behavioral,
  // asserting observable state (text, cursor, mode). A faithful gate is a live
  // nvim server driven per-keystroke, reading undotree() block counts — a
  // follow-up driver, not built here.
  // -------------------------------------------------------------------------
  describe("insert-session undo scope", () => {
    it("initial insert session (editor starts in INSERT) undoes as one unit", () => {
      // Real-world primary case (issue #41): the editor boots in INSERT mode,
      // so the user types a message directly (no `i`) and expects a single `u`
      // to revert the whole typed sentence rather than one word at a time.
      const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
      editor.setClipboardFn(() => undefined);
      editor.setClipboardReadFn(() => null);
      assert.equal(editor.getMode(), "insert");
      for (const ch of "hello world foo") editor.handleInput(ch);
      editor.handleInput("\x1b");
      assert.equal(editor.getText(), "hello world foo");

      editor.handleInput("u");
      assert.equal(editor.getText(), "", "first u reverts the whole session");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
      editor.handleInput("u");
      assert.equal(editor.getText(), "", "second u is a no-op");
      editor.handleInput("\x12"); // <C-r> restores the whole session
      assert.equal(editor.getText(), "hello world foo");
    });

    it("pure insert: i hello world foo<Esc> then u reverts in one press", () => {
      const { editor } = createEditorWithSpy("");
      sendKeys(editor, ["i", ..."hello world foo", "\x1b"]);
      assert.equal(editor.getText(), "hello world foo");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "", "first u reverts whole session");
      assert.deepEqual(
        editor.getCursor(),
        { line: 0, col: 0 },
        "cursor lands at change start",
      );

      // second u is a no-op (history exhausted, clamp)
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "", "second u is a no-op");
    });

    it("pure insert + redo: u then <C-r> restores the whole session", () => {
      const { editor } = createEditorWithSpy("");
      sendKeys(editor, ["i", ..."hello world", "\x1b"]);
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "");
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "hello world");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });
    });

    it("change-with-insert: cw bar baz<Esc> then u reverts delete+insert in one press", () => {
      const { editor } = createEditorWithSpy("foo");
      resetUndoHistory(editor);
      sendKeys(editor, ["c", "w", ..."bar baz", "\x1b"]);
      assert.equal(editor.getText(), "bar baz");

      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "foo",
        "u reverts word-delete and typed text",
      );
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "foo", "second u is a no-op");
    });

    it("o session: o typed<Esc> then u removes the opened line in one press", () => {
      const { editor } = createMultiLineEditor("x");
      resetUndoHistory(editor);
      sendKeys(editor, ["o", ..."typed", "\x1b"]);
      assert.equal(editor.getText(), "x\ntyped");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "x", "u removes opened line and its text");
      // cursor returns to the line where `o` was invoked
      assert.equal(editor.getCursor().line, 0);
    });

    it("O session: O typed<Esc> then u removes the opened line in one press", () => {
      const { editor } = createMultiLineEditor("x");
      resetUndoHistory(editor);
      sendKeys(editor, ["O", ..."typed", "\x1b"]);
      assert.equal(editor.getText(), "typed\nx");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "x", "u removes opened line and its text");
    });

    it("no-op i<Esc> preserves history: a following u reverts a prior real change", () => {
      const { editor } = createEditorWithSpy("");
      sendKeys(editor, ["i", "X", "\x1b"]); // one real change
      // a no-op insert session must not consume a history slot
      sendKeys(editor, ["i", "\x1b"]);
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "", "no-op insert did not add a change");
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "X");
    });

    it("redo clears on real edit: after u, a new insert clears the redo path", () => {
      const { editor } = createEditorWithSpy("");
      sendKeys(editor, ["i", "a", "b", "c", "\x1b", "u"]); // undo → redo path holds "abc"
      assert.equal(editor.getText(), "");
      sendKeys(editor, ["i", "Z", "\x1b"]); // new edit clears redo
      sendKeys(editor, ["\x12"]);
      assert.equal(
        editor.getText(),
        "Z",
        "<C-r> no longer restores the cleared redo path",
      );
    });

    it("exhausted-history clamp: u at empty history is a no-op", () => {
      const { editor } = createEditorWithSpy("");
      const before = editor.getText();
      const beforeCursor = editor.getCursor();
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), before);
      assert.deepEqual(editor.getCursor(), beforeCursor);
    });

    it("AC-8 counted insert entry is one undo unit (count-repeat is a non-goal)", () => {
      // Count-insert *repeat* (`3i…<Esc>` → `hihihi`) is a documented non-goal.
      // Whatever `3i…<Esc>` produces today, the guarantee under test is that it
      // is ONE undo unit and the count does not leak into the following command.
      const { editor } = createEditorWithSpy("abc");
      sendKeys(editor, ["3", "i", "Z", "\x1b"]); // inserts one "Z"
      assert.equal(editor.getText(), "Zabc");

      sendKeys(editor, ["u"]); // must revert only this one insert, not leak count
      assert.equal(editor.getText(), "abc");
    });

    it("no count leak: <count>u consumes only its count", () => {
      const { editor } = createEditorWithSpy("");
      // build three separate insert sessions
      sendKeys(editor, ["i", "a", "\x1b"]);
      sendKeys(editor, ["a", "b", "\x1b"]);
      sendKeys(editor, ["a", "c", "\x1b"]);
      assert.equal(editor.getText(), "abc");

      sendKeys(editor, ["2", "u"]); // undo exactly two changes
      assert.equal(editor.getText(), "a");
      // count must not leak: another `u` undoes exactly one more
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "");
    });

    it("no regression: dd / x / dw / p / r still undo as one unit each", () => {
      // Each atomic normal-mode edit remains a single undo unit. Use a fresh
      // editor per command so cursor/register coupling between commands does
      // not muddy the assertions.
      const dd = createMultiLineEditor("foo\nbar");
      resetUndoHistory(dd.editor);
      sendKeys(dd.editor, ["d", "d"]);
      assert.equal(dd.editor.getText(), "bar");
      sendKeys(dd.editor, ["u"]);
      assert.equal(dd.editor.getText(), "foo\nbar", "dd undoes as one unit");

      const x = createEditorWithSpy("foo");
      resetUndoHistory(x.editor);
      sendKeys(x.editor, ["x"]);
      assert.equal(x.editor.getText(), "oo");
      sendKeys(x.editor, ["u"]);
      assert.equal(x.editor.getText(), "foo", "x undoes as one unit");

      const dw = createEditorWithSpy("foo bar");
      resetUndoHistory(dw.editor);
      sendKeys(dw.editor, ["d", "w"]);
      assert.equal(dw.editor.getText(), "bar");
      sendKeys(dw.editor, ["u"]);
      assert.equal(dw.editor.getText(), "foo bar", "dw undoes as one unit");

      const p = createEditorWithSpy("ab");
      resetUndoHistory(p.editor);
      p.editor.setRegister("Z");
      sendKeys(p.editor, ["p"]);
      assert.equal(p.editor.getText(), "aZb");
      sendKeys(p.editor, ["u"]);
      assert.equal(p.editor.getText(), "ab", "p undoes as one unit");

      const r = createEditorWithSpy("foo");
      resetUndoHistory(r.editor);
      sendKeys(r.editor, ["r", "Q"]);
      assert.equal(r.editor.getText(), "Qoo");
      sendKeys(r.editor, ["u"]);
      assert.equal(r.editor.getText(), "foo", "r undoes as one unit");
    });

    it("grapheme-safe: insert with a surrogate-pair emoji reverts whole session", () => {
      const { editor } = createEditorWithSpy("");
      const graphemes = [..."😀 hello world"];
      sendKeys(editor, ["i", ...graphemes, "\x1b"]);
      assert.equal(editor.getText(), "😀 hello world");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "", "u reverts the whole session");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
    });

    it("cursor placement: after u cursor sits at the change start", () => {
      // cw on the second word: the change starts at that word, and undo must
      // land the cursor on the first column of the undone region.
      const { editor } = createEditorWithSpy("foo bar");
      resetUndoHistory(editor);
      // move to start of "bar" (col 4)
      sendKeys(editor, ["w"]);
      assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
      sendKeys(editor, ["c", "w", "X", "Y", "\x1b"]);
      assert.equal(editor.getText(), "foo XY");
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "foo bar");
      assert.deepEqual(
        editor.getCursor(),
        { line: 0, col: 4 },
        "cursor at change start after undo",
      );
    });

    it("change-with-insert + redo: u then <C-r> restores delete+insert", () => {
      const { editor } = createEditorWithSpy("foo bar");
      resetUndoHistory(editor);
      sendKeys(editor, ["c", "w", "Z", "\x1b"]);
      // pi-vim's cw includes the trailing whitespace (documented behavior),
      // so the whole "foo " is replaced.
      assert.equal(editor.getText(), "Zbar");
      const afterChangeCursor = editor.getCursor();
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "foo bar");
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "Zbar");
      assert.deepEqual(editor.getCursor(), afterChangeCursor);
    });
  });

  // -------------------------------------------------------------------------
  // Acceptance cases (AC-1..AC-12) from the vim-change-scoped-undo design.
  // AC-1/3/8/9/11/12 are covered by the insert-session describe above; these
  // add the remaining cases. Same oracle-gap caveat: behavioral, observable
  // state only (see note above).
  // -------------------------------------------------------------------------
  describe("vim-change undo scope — acceptance (AC-1..AC-12)", () => {
    it("AC-2 multi-line insert collapses to one undo unit", () => {
      // In pi-vim's prompt editor Enter (\r) submits; a newline inside an
      // insert session is the "\n" key (the same key `o`/multi-line fixtures
      // use). The window holds across the newlines until <Esc>.
      const { editor } = createEditorWithSpy("");
      sendKeys(editor, [
        "i",
        ..."line one",
        "\n",
        ..."line two",
        "\n",
        ..."line three",
        "\x1b",
      ]);
      assert.equal(editor.getText(), "line one\nline two\nline three");

      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "",
        "one u reverts the whole multi-line session",
      );
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "", "second u is a no-op");
    });

    it("AC-4 counted change 3dw reverts all three words in one u", () => {
      const { editor } = createEditorWithSpy("alpha beta gamma delta");
      resetUndoHistory(editor);
      sendKeys(editor, ["3", "d", "w"]);
      assert.equal(editor.getText(), "delta");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "alpha beta gamma delta");
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "alpha beta gamma delta",
        "second u is a no-op",
      );
    });

    it("AC-5 dot-repeat is its own unit, separate from the change it repeats", () => {
      const { editor } = createEditorWithSpy("foo foo foo");
      resetUndoHistory(editor);
      sendKeys(editor, ["c", "w", "X", "\x1b"]);
      const afterFirst = editor.getText(); // pi-vim cw eats the trailing space
      sendKeys(editor, ["w", "."]);
      assert.notEqual(
        editor.getText(),
        afterFirst,
        "the . replay mutated again",
      );

      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        afterFirst,
        "first u undoes only the . replay; the first change stays",
      );
      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "foo foo foo",
        "second u undoes the first change",
      );
    });

    it("AC-6 visual delete (ved) is one undo unit", () => {
      // A visual mutating operator bypasses the recorder but is still one undo
      // unit (design D4). `ve` selects to the end of the word; `d` deletes it.
      const { editor } = createEditorWithSpy("hello world");
      resetUndoHistory(editor);
      sendKeys(editor, ["v", "e", "d"]);
      assert.equal(editor.getText(), " world");

      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "hello world",
        "one u restores the visual selection",
      );
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "hello world", "second u is a no-op");
    });

    it("AC-6 visual change (vec) is one undo unit", () => {
      const { editor } = createEditorWithSpy("hello world");
      resetUndoHistory(editor);
      sendKeys(editor, ["v", "e", "c", "X", "\x1b"]);
      assert.equal(editor.getText(), "X world");

      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "hello world",
        "one u restores delete+insert of the visual change",
      );
    });

    it("AC-7 linewise put (yyp) is one undo unit", () => {
      const { editor } = createMultiLineEditor("abc");
      resetUndoHistory(editor);
      sendKeys(editor, ["y", "y", "p"]);
      assert.equal(editor.getText(), "abc\nabc");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "abc", "one u removes the whole put");
      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "abc", "second u is a no-op");
    });

    it("AC-7 charwise put of multi-char text is one undo unit", () => {
      // `p` emits one host edit per character; the undo window collapses them so
      // a single u removes the whole paste, not one character at a time. (This
      // is the case PR #42's insert-only bracket did not cover.)
      const { editor } = createEditorWithSpy("ab");
      resetUndoHistory(editor);
      editor.setRegister("hello");
      sendKeys(editor, ["p"]);
      assert.equal(editor.getText(), "ahellob");

      sendKeys(editor, ["u"]);
      assert.equal(
        editor.getText(),
        "ab",
        "one u removes the whole multi-char paste",
      );
    });

    it("AC-10 redo symmetry: r then u then <C-r> round-trips the change", () => {
      const { editor } = createEditorWithSpy("abc");
      resetUndoHistory(editor);
      sendKeys(editor, ["r", "x"]);
      assert.equal(editor.getText(), "xbc");

      sendKeys(editor, ["u"]);
      assert.equal(editor.getText(), "abc", "u restores the original");
      sendKeys(editor, ["\x12"]);
      assert.equal(editor.getText(), "xbc", "<C-r> redoes the whole change");
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
    setInternalCursor(editor, 3);

    sendKeys(editor, ["T", "c"]);

    assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
  });

  it("T{char} after an emoji target at EOL lands safely", () => {
    const { editor } = createEditorWithSpy("ab😀");
    setInternalCursor(editor, 4);

    sendKeys(editor, ["T", "😀"]);

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
    sendKeys(editor, ["d"]); // pendingOperator = 'd'
    sendKeys(editor, ["\x1b"]); // cancel
    assert.equal(editor.getText(), before);
    assert.equal(editor.getMode(), "normal");
  });

  it("Escape cancels pending motion without mutation", () => {
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["f"]); // pendingMotion = 'f'
    sendKeys(editor, ["\x1b"]); // cancel
    assert.equal(editor.getText(), before);
  });

  it("unrecognised key after d operator cancels cleanly", () => {
    const { editor } = createEditorWithSpy("hello");
    const before = editor.getText();
    sendKeys(editor, ["d", "z"]); // 'z' is not a valid motion
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

    const customEditorProto = Object.getPrototypeOf(
      Object.getPrototypeOf(editor),
    );
    const originalHandleInput = customEditorProto.handleInput;
    let forwardedEscapeCount = 0;

    customEditorProto.handleInput = function (
      this: unknown,
      data: string,
    ): unknown {
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
    (
      editor as unknown as {
        state: { lines: string[]; cursorLine: number; cursorCol: number };
      }
    ).state = {
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
    (
      editor as unknown as {
        state: { lines: string[]; cursorLine: number; cursorCol: number };
      }
    ).state = {
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

// ---------------------------------------------------------------------------
// Dot-repeat: `.` as a char-find / replace argument, not a repeat request.
//
// When f/F/t/T (incl. as an operator motion like df.) or r is awaiting its
// argument, `.` is the target/replacement char and must reach the pending
// handler, not trigger dot-repeat. The dispatch handles this by ordering
// (pending state is consumed before the normal-mode `.` interception); these
// tests pin that ordering so a future dispatch refactor cannot silently
// reintroduce the `f.`/`r.`-triggers-repeat regression that sank the first
// dot-repeat attempt. Char-argument battery adapted from PR #37 by dabstractor
// (https://github.com/lajarre/pi-vim/pull/37).
// ---------------------------------------------------------------------------

describe("char-argument commands accept '.' (not dot-repeat)", () => {
  it("f. moves to the next period", () => {
    const { editor } = createEditorWithSpy("ab.cd.ef");
    sendKeys(editor, ["f", "."]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
    assert.equal(editor.getText(), "ab.cd.ef");
  });

  it("F. moves to the previous period", () => {
    const { editor } = createEditorWithSpy("ab.cd.ef");
    setInternalCursor(editor, 5);
    sendKeys(editor, ["F", "."]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  });

  it("t. moves to before the next period", () => {
    const { editor } = createEditorWithSpy("ab.cd.ef");
    sendKeys(editor, ["t", "."]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  });

  it("r. replaces the char under the cursor with a period", () => {
    const { editor } = createEditorWithSpy("abcde");
    setInternalCursor(editor, 1);
    sendKeys(editor, ["r", "."]);
    assert.equal(editor.getText(), "a.cde");
    assert.equal(editor.getMode(), "normal");
  });

  it("df. deletes up to and including the next period", () => {
    const { editor } = createEditorWithSpy("ab.cd.ef");
    sendKeys(editor, ["d", "f", "."]);
    assert.equal(editor.getText(), "cd.ef");
  });

  it("3f. respects a count with '.' as the target", () => {
    const { editor } = createEditorWithSpy("a.b.c.d");
    sendKeys(editor, ["3", "f", "."]);
    assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  });

  it("2r. replaces two chars with periods", () => {
    const { editor } = createEditorWithSpy("abcde");
    sendKeys(editor, ["2", "r", "."]);
    assert.equal(editor.getText(), "..cde");
  });

  it("f. is a pure motion; a following '.' repeats the prior change", () => {
    const { editor } = createEditorWithSpy("ab.c");
    // x records a change; f. is a motion (must not overwrite it); the final '.'
    // repeats x at the new cursor, deleting the period -> "bc".
    sendKeys(editor, ["x", "f", ".", "."]);
    assert.equal(editor.getText(), "bc");
    assert.equal(editor.getMode(), "normal");
  });

  it("dot-repeat still fires when no char-argument command is pending", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x", "."]);
    assert.equal(editor.getText(), "llo");
  });

  it("'.' while an operator is pending cancels and does not repeat (d .)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x", "d", "."]); // d pending; '.' cancels d; x stays last change
    assert.equal(editor.getText(), "ello");
  });

  it("'.' while 'g' is pending cancels and does not repeat (g .)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x", "g", "."]);
    assert.equal(editor.getText(), "ello");
  });
});

// ---------------------------------------------------------------------------
// Dot-repeat: undo/redo interactions.
//
// Undo/redo mutate the buffer but are not repeatable changes, so `.` still
// repeats the change that preceded them, and a repeat is itself an ordinary
// undoable edit. The nvim parity oracle cannot cover these (its `u` prints a
// message that pollutes the result line), so they are pinned as unit tests.
// ---------------------------------------------------------------------------

describe("dot repeat — undo/redo interactions", () => {
  it("does not record undo; '.' repeats the change before the undo (x u .)", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["x"]); // "ello world"
    sendKeys(editor, ["u"]); // undo -> "hello world"
    assert.equal(editor.getText(), "hello world");
    sendKeys(editor, ["."]); // repeats x -> "ello world"
    assert.equal(editor.getText(), "ello world");
  });

  it("produces an undoable edit; u reverts one repeat step (x . u)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x", "."]); // "llo"
    assert.equal(editor.getText(), "llo");
    sendKeys(editor, ["u"]); // undo the `.` only
    assert.equal(editor.getText(), "ello");
  });

  it("u after '.' then ctrl+r redoes the repeat step", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x", "."]); // "llo"
    sendKeys(editor, ["u"]); // "ello"
    sendKeys(editor, ["\x12"]); // redo -> "llo"
    assert.equal(editor.getText(), "llo");
  });
});

// ---------------------------------------------------------------------------
// Visual mode. The nvim parity suite (test/nvim-parity-visual.ts) covers the
// selection semantics against real nvim. These unit cases pin the behaviours
// the oracle cannot reach: keys that are deliberately inert while a selection
// is live, the footer label, escape not reaching the agent, and the fact that
// visual edits take themselves out of the dot-repeat register.
// ---------------------------------------------------------------------------

describe("visual mode — entering and leaving", () => {
  it("v and V report their modes and Escape returns to normal", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v"]);
    assert.equal(editor.getMode(), "visual");
    sendKeys(editor, ["\x1b"]);
    assert.equal(editor.getMode(), "normal");

    sendKeys(editor, ["V"]);
    assert.equal(editor.getMode(), "visual-line");
    sendKeys(editor, ["\x1b"]);
    assert.equal(editor.getMode(), "normal");
  });

  it("a pending count is dropped when visual mode starts (2v acts as v)", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["2", "v", "d"]);
    assert.equal(editor.getText(), "ello");
    assert.equal(editor.getRegister(), "h");
  });

  it("a count before a swallowed visual key does not leak into the next motion", () => {
    // `p` is inert in visual mode (pi swallows it), so the pending count must
    // be dropped: `v2pld` must behave exactly like `vld` — extend by one and
    // delete two chars — not carry the 2 into `l` and over-delete.
    const leaked = createEditorWithSpy("hello");
    sendKeys(leaked.editor, ["v", "2", "p", "l", "d"]);

    const baseline = createEditorWithSpy("hello");
    sendKeys(baseline.editor, ["v", "l", "d"]);

    assert.equal(leaked.editor.getText(), baseline.editor.getText());
    assert.equal(leaked.editor.getText(), "llo");
    assert.equal(leaked.editor.getRegister(), "he");
  });

  it("a count before a swallowed ctrl+r in visual mode does not leak", () => {
    const CTRL_R = "\x12";
    const leaked = createEditorWithSpy("hello");
    sendKeys(leaked.editor, ["v", "2", CTRL_R, "l", "d"]);
    assert.equal(leaked.editor.getText(), "llo");
    assert.equal(leaked.editor.getRegister(), "he");
  });

  it("Escape cancels a pending char motion but stays in visual mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v", "f", "\x1b"]);
    assert.equal(editor.getMode(), "visual");
  });

  it("Escape from visual mode is not forwarded to the agent", () => {
    // `super.handleInput("\x1b")` only reaches onEscape when the keybindings
    // manager claims the key as app.interrupt, so the stub must say so for
    // this assertion to mean anything.
    const interruptKeybindings = {
      matches: (data: string, action: string) =>
        data === "\x1b" && action === "app.interrupt",
    } as unknown as ConstructorParameters<typeof ModalEditor>[2];
    const create = () => {
      const editor = new ModalEditor(stubTui, stubTheme, interruptKeybindings);
      editor.setClipboardFn(() => undefined);
      editor.setClipboardReadFn(() => null);
      const seen: string[] = [];
      editor.onEscape = () => seen.push("escape");
      editor.handleInput("\x1b"); // insert -> normal (handled by the vim layer)
      return { editor, seen };
    };

    const forwarded = create();
    forwarded.editor.handleInput("\x1b"); // idle normal mode aborts the agent
    assert.deepEqual(forwarded.seen, ["escape"]);

    const swallowed = create();
    sendKeys(swallowed.editor, ["v", "\x1b"]);
    assert.equal(swallowed.editor.getMode(), "normal");
    assert.deepEqual(swallowed.seen, []);
  });

  it("reports a block cursor shape while a selection is live", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v"]);
    const shape = (
      editor as unknown as { getDesiredCursorShapeSequence(): string }
    ).getDesiredCursorShapeSequence();
    assert.equal(shape, BLOCK_CURSOR_SHAPE);
  });
});

describe("visual mode — footer label", () => {
  it("shows VISUAL and V-LINE", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v"]);
    assert.ok(editor.render(80).at(-1)?.endsWith(" VISUAL "));
    sendKeys(editor, ["V"]);
    assert.ok(editor.render(80).at(-1)?.endsWith(" V-LINE "));
  });

  it("echoes a pending count and a pending char motion", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v", "2"]);
    assert.ok(editor.render(80).at(-1)?.endsWith(" VISUAL 2_ "));
    sendKeys(editor, ["l", "f"]);
    assert.ok(editor.render(80).at(-1)?.endsWith(" VISUAL f_ "));
  });
});

describe("visual mode — inert normal-mode commands", () => {
  const stays = (keys: string[]) => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v", ...keys]);
    return editor;
  };

  it("u does not undo and does not leave visual mode", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x"]); // "ello"
    sendKeys(editor, ["v", "u"]);
    assert.equal(editor.getText(), "ello");
    assert.equal(editor.getMode(), "visual");
  });

  it("ctrl+r does not redo while a selection is live", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x", "u"]); // back to "hello"
    sendKeys(editor, ["v", "\x12"]);
    assert.equal(editor.getText(), "hello");
    assert.equal(editor.getMode(), "visual");
  });

  it("p and P do not put the register", () => {
    const { editor } = createEditorWithSpy("hello");
    editor.setRegister("XY");
    sendKeys(editor, ["v", "p", "P"]);
    assert.equal(editor.getText(), "hello");
    assert.equal(editor.getMode(), "visual");
  });

  it("i, a, A and I do not open insert mode", () => {
    for (const key of ["i", "a", "A", "I"]) {
      const editor = stays([key]);
      assert.equal(editor.getMode(), "visual", `${key} left visual mode`);
      assert.equal(editor.getText(), "hello");
    }
  });

  it("r does not start a pending replace", () => {
    const editor = stays(["r", "Z"]);
    assert.equal(editor.getText(), "hello");
    assert.equal(editor.getMode(), "visual");
  });

  it("J does not join lines, with or without a g prefix", () => {
    const { editor } = createMultiLineEditor("abc\ndef");
    sendKeys(editor, ["v", "J"]);
    assert.equal(editor.getText(), "abc\ndef");
    sendKeys(editor, ["g", "J"]);
    assert.equal(editor.getText(), "abc\ndef");
    assert.equal(editor.getMode(), "visual");
  });

  it(": does not open the EX mini-mode", () => {
    const editor = stays([":"]);
    assert.equal(editor.getMode(), "visual");
    assert.ok(editor.render(80).at(-1)?.endsWith(" VISUAL "));
  });

  it("printable keys are swallowed rather than typed into the buffer", () => {
    const editor = stays(["Z", "q"]);
    assert.equal(editor.getText(), "hello");
    assert.equal(editor.getMode(), "visual");
  });
});

describe("visual mode — dot-repeat interaction", () => {
  it("does not record a visual edit as the repeatable command", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["v", "l", "d"]); // "llo world"
    assert.equal(editor.getText(), "llo world");
    sendKeys(editor, ["."]);
    assert.equal(editor.getText(), "llo world");
  });

  it("clears an older repeatable command so '.' cannot replay it", () => {
    const { editor } = createEditorWithSpy("hello world");
    sendKeys(editor, ["x"]); // records `x` -> "ello world"
    sendKeys(editor, ["v", "l", "d"]); // "lo world"
    assert.equal(editor.getText(), "lo world");
    sendKeys(editor, ["."]);
    assert.equal(editor.getText(), "lo world");
  });

  it("keeps the last change repeatable when visual mode is only entered", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["x"]); // "ello"
    sendKeys(editor, ["v", "\x1b"]);
    sendKeys(editor, ["."]);
    assert.equal(editor.getText(), "llo");
  });
});

describe("visual mode — undo", () => {
  it("a character-wise delete is a single undo step", () => {
    const { editor } = createEditorWithSpy("hello");
    sendKeys(editor, ["v", "l", "l", "d"]);
    assert.equal(editor.getText(), "lo");
    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "hello");
  });

  it("a line-wise change is a single undo step", () => {
    const { editor } = createMultiLineEditor("abc\ndef");
    sendKeys(editor, ["V", "c", "\x1b"]);
    assert.equal(editor.getText(), "\ndef");
    sendKeys(editor, ["u"]);
    assert.equal(editor.getText(), "abc\ndef");
  });
});
