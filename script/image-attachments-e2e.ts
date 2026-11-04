import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import installPiVim from "../index.js";
import type { stubKeybindings } from "../test/harness.js";
import {
  createExtensionApiHarness,
  stubTheme,
  stubTui,
} from "../test/harness.js";
import {
  findPackageRoot,
  formatUnknownError,
  hasPackageName,
  isRecord,
  packLocalPackage,
  projectRoot,
  runNpmInstall,
} from "./consumer-workspace.js";

type RuntimeEditorFactory = (
  tui: typeof stubTui,
  theme: typeof stubTheme,
  keybindings: typeof stubKeybindings,
) => unknown;

type WidgetCall = {
  key: string;
  content: string[] | undefined;
  options: { placement?: string } | undefined;
};

type NotificationCall = {
  message: string;
  type: string;
};

type SentUserMessage = {
  content: unknown;
  options: unknown;
};

type RuntimeContext = {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  ui: {
    theme: typeof stubTheme;
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: string },
    ): void;
    setEditorComponent(factory: RuntimeEditorFactory | undefined): void;
    getEditorComponent(): RuntimeEditorFactory | undefined;
    notify(message: string, type: string): void;
  };
  shutdown(): void;
};

type RuntimeHarness = {
  ctx: RuntimeContext;
  pi: ReturnType<typeof createPiHarness>;
  widgetCalls: WidgetCall[];
  notifications: NotificationCall[];
  sentUserMessages: SentUserMessage[];
  getEditorFactory(): RuntimeEditorFactory;
};

type EditorSurface = {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  insertTextAtCursor(text: string): void;
  getExpandedText(): string;
  addToHistory(text: string): void;
  setAutocompleteProvider(provider: unknown): void;
  setPaddingX(padding: number): void;
  setAutocompleteMaxVisible(maxVisible: number): void;
  getLines(): string[];
  getCursor(): { line: number; col: number };
  getMode(): string;
  onAction(action: string, handler: () => void): void;
};

type PiExtension = (pi: unknown) => void;

type TransformInputResult = {
  action: "transform";
  text: string;
  images?: unknown[];
};

type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

const IMAGE_PACKAGE_NAME = "@jordyvd/pi-image-attachments";
const IMAGE_PACKAGE_REGISTRY_RANGE = "0.1.1";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const SUBMIT_INPUT = "\r";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

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
] as const;

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
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function crossPackageBlocker(message: string): never {
  throw new Error(`cross-package blocker: ${message}`);
}

function resolveImageAttachmentsDependency(workspace: string): string {
  const explicitCandidate = process.env.PI_IMAGE_ATTACHMENTS_PACKAGE_DIR;
  if (explicitCandidate) {
    const packageDir = resolve(explicitCandidate);
    if (!hasPackageName(packageDir, IMAGE_PACKAGE_NAME)) {
      throw new Error(
        `FAIL-INFRA: PI_IMAGE_ATTACHMENTS_PACKAGE_DIR does not point to ${IMAGE_PACKAGE_NAME}: ${packageDir}`,
      );
    }
    return packLocalPackage(packageDir, workspace, IMAGE_PACKAGE_NAME);
  }

  const candidates = new Set<string>();
  let dir = projectRoot;

  while (true) {
    candidates.add(resolve(dir, "../pi-image-attachments"));
    candidates.add(resolve(dir, "pi-image-attachments"));

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const candidate of candidates) {
    if (hasPackageName(candidate, IMAGE_PACKAGE_NAME)) {
      return packLocalPackage(candidate, workspace, IMAGE_PACKAGE_NAME);
    }
  }

  return IMAGE_PACKAGE_REGISTRY_RANGE;
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(
    join(tmpdir(), "pi-vim-image-attachments-e2e-"),
  );
  const packageJson = {
    private: true,
    type: "module",
    dependencies: {
      [IMAGE_PACKAGE_NAME]: resolveImageAttachmentsDependency(workspace),
      "@earendil-works/pi-ai": `file:${findPackageRoot("@earendil-works/pi-ai")}`,
      "@earendil-works/pi-coding-agent": `file:${findPackageRoot("@earendil-works/pi-coding-agent")}`,
      "@earendil-works/pi-tui": `file:${findPackageRoot("@earendil-works/pi-tui")}`,
    },
  };

  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  runNpmInstall(workspace);
  await writeFile(join(workspace, "fixture.png"), PNG_BYTES);
  return workspace;
}

async function importImageAttachmentsExtension(
  workspace: string,
): Promise<PiExtension> {
  try {
    const workspaceRequire = createRequire(join(workspace, "package.json"));
    const entry = workspaceRequire.resolve(`${IMAGE_PACKAGE_NAME}/index.ts`);
    const module = (await import(pathToFileURL(entry).href)) as unknown;

    if (!isRecord(module) || typeof module.default !== "function") {
      throw new Error(`${IMAGE_PACKAGE_NAME} default export is not a function`);
    }

    return module.default as PiExtension;
  } catch (error) {
    throw new Error(
      `FAIL-INFRA: unable to import ${IMAGE_PACKAGE_NAME}: ${formatUnknownError(error)}`,
    );
  }
}

function createPiHarness() {
  const sentUserMessages: SentUserMessage[] = [];
  const pi = Object.assign(createExtensionApiHarness(), {
    sentUserMessages,
    sendUserMessage(content: unknown, options?: unknown): void {
      sentUserMessages.push({ content, options });
    },
  });

  return pi;
}

function createRuntimeHarness(
  cwd: string,
  pi: ReturnType<typeof createPiHarness>,
): RuntimeHarness {
  let editorFactory: RuntimeEditorFactory | undefined;
  const widgetCalls: WidgetCall[] = [];
  const notifications: NotificationCall[] = [];

  const ctx: RuntimeContext = {
    cwd,
    hasUI: true,
    isIdle() {
      return true;
    },
    ui: {
      theme: stubTheme,
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: { placement?: string },
      ) {
        widgetCalls.push({ key, content, options });
      },
      setEditorComponent(factory: RuntimeEditorFactory | undefined) {
        editorFactory = factory;
      },
      getEditorComponent() {
        return editorFactory;
      },
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
    shutdown() {},
  };

  return {
    ctx,
    pi,
    widgetCalls,
    notifications,
    sentUserMessages: pi.sentUserMessages,
    getEditorFactory() {
      if (!editorFactory)
        throw new Error("expected an installed editor factory");
      return editorFactory;
    },
  };
}

function createE2eKeybindings(): typeof stubKeybindings {
  return {
    getKeys: () => [],
    matches(data: string, action: string): boolean {
      return data === SUBMIT_INPUT && action === "tui.input.submit";
    },
  } as unknown as typeof stubKeybindings;
}

async function installSupportedOrder(
  workspace: string,
  imageExtension: PiExtension,
): Promise<RuntimeHarness> {
  const pi = createPiHarness();
  const harness = createRuntimeHarness(workspace, pi);

  installPiVim(pi);
  imageExtension(pi);

  await pi.emit("session_start", { reason: "startup" }, harness.ctx);
  return harness;
}

function assertEditorSurface(
  editor: unknown,
  label: string,
): asserts editor is EditorSurface {
  if (!isRecord(editor)) fail(`${label} is not an object`);

  for (const method of WRAPPER_FACING_METHODS) {
    if (typeof editor[method] !== "function") {
      fail(`${label} is missing method ${method}`);
    }
  }

  for (const field of WRAPPER_FACING_FIELDS) {
    if (!(field in editor)) {
      fail(`${label} is missing field ${field}`);
    }
  }

  if (!(editor.actionHandlers instanceof Map))
    fail(`${label} actionHandlers is not a Map`);
  if (typeof editor.focused !== "boolean")
    fail(`${label} focused is not a boolean`);
  if (typeof editor.disableSubmit !== "boolean")
    fail(`${label} disableSubmit is not a boolean`);
  if (typeof editor.borderColor !== "function")
    fail(`${label} borderColor is not a function`);
  if (typeof editor.getMode !== "function")
    fail(`${label} getMode is not a function`);
}

function assertPiVimSurfaceForLaterDecorator(
  editor: unknown,
): asserts editor is EditorSurface {
  try {
    assertEditorSurface(editor, "later image-attachments editor");
  } catch (error) {
    crossPackageBlocker(formatUnknownError(error));
  }
}

function disableClipboardWrites(editor: EditorSurface): void {
  const candidate = editor as EditorSurface & {
    setClipboardFn?: (fn: (text: string) => unknown) => void;
    setClipboardReadFn?: (fn: () => string | null) => void;
  };

  candidate.setClipboardFn?.(() => {});
  candidate.setClipboardReadFn?.(() => null);
}

function mountEditor(harness: RuntimeHarness): EditorSurface {
  const editor = harness.getEditorFactory()(
    stubTui,
    stubTheme,
    createE2eKeybindings(),
  );
  assertPiVimSurfaceForLaterDecorator(editor);
  disableClipboardWrites(editor);
  return editor;
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    fail(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(
  haystack: string,
  needle: string,
  message: string,
): void {
  if (!haystack.includes(needle)) {
    fail(
      `${message}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`,
    );
  }
}

function assertArrayLength(
  value: unknown,
  expectedLength: number,
  message: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(`${message}: expected an array`);
  assertEqual(value.length, expectedLength, message);
}

function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function typeText(editor: EditorSurface, text: string): void {
  for (const char of text) editor.handleInput(char);
}

function latestWidget(
  harness: RuntimeHarness,
  messagePrefix: string,
): WidgetCall {
  const widget = harness.widgetCalls.at(-1);
  if (!widget) fail(`${messagePrefix} should publish a widget update`);
  return widget;
}

function assertWidgetHasAttachment(
  harness: RuntimeHarness,
  messagePrefix: string,
): void {
  const widget = latestWidget(harness, messagePrefix);
  if (!widget.content)
    fail(`${messagePrefix} should publish an attachments widget`);
  assertIncludes(
    widget.content.join("\n"),
    "[Image #1]",
    `${messagePrefix} attachments widget should include the placeholder`,
  );
}

function assertWidgetCleared(
  harness: RuntimeHarness,
  messagePrefix: string,
): void {
  const widget = latestWidget(harness, messagePrefix);
  assertEqual(
    widget.content,
    undefined,
    `${messagePrefix} should clear the attachments widget`,
  );
}

function assertImageContent(
  value: unknown,
  message: string,
): asserts value is ImageContent {
  if (!isRecord(value)) fail(`${message}: expected image content object`);
  assertEqual(value.type, "image", `${message} type`);
  assertEqual(value.mimeType, "image/png", `${message} mimeType`);
  if (typeof value.data !== "string" || value.data.length === 0) {
    fail(`${message}: expected non-empty base64 data`);
  }
}

function assertTransformResult(
  value: unknown,
  message: string,
): asserts value is TransformInputResult {
  if (!isRecord(value)) fail(`${message}: expected object result`);
  assertEqual(value.action, "transform", `${message} action`);
  if (typeof value.text !== "string") fail(`${message}: expected string text`);
  if (value.images !== undefined && !Array.isArray(value.images)) {
    fail(`${message}: expected images array when images are present`);
  }
}

function assertImageAttachmentState(
  editor: EditorSurface,
  harness: RuntimeHarness,
  messagePrefix: string,
): void {
  assertEqual(
    editor.getText(),
    "[Image #1] ",
    `${messagePrefix} should insert an attachment placeholder`,
  );
  assertWidgetHasAttachment(harness, messagePrefix);
}

function assertImageAttachmentInsertedByDirectInsert(
  editor: EditorSurface,
  harness: RuntimeHarness,
  imagePath: string,
): void {
  editor.insertTextAtCursor(imagePath);
  assertImageAttachmentState(editor, harness, "direct image path insert");
}

function assertImageAttachmentInsertedByBracketedPaste(
  editor: EditorSurface,
  harness: RuntimeHarness,
  imagePath: string,
): void {
  editor.handleInput(bracketedPaste(imagePath));
  assertImageAttachmentState(editor, harness, "bracketed image paste");
}

function assertPiVimModalBehavior(editor: EditorSurface): void {
  assertEqual(editor.getMode(), "insert", "editor should start in INSERT mode");

  typeText(editor, "abc");
  assertEqual(
    editor.getText(),
    "abc",
    "INSERT input should update editor text",
  );

  editor.handleInput("\x1b");
  assertEqual(editor.getMode(), "normal", "escape should enter NORMAL mode");

  editor.handleInput("0");
  editor.handleInput("x");
  assertEqual(
    editor.getText(),
    "bc",
    "NORMAL printable input should be handled by pi-vim instead of inserted as raw text",
  );
}

async function assertTextAndImageSubmit(
  harness: RuntimeHarness,
  editor: EditorSurface,
  imagePath: string,
): Promise<void> {
  typeText(editor, "Look ");
  editor.insertTextAtCursor(imagePath);
  assertEqual(
    editor.getText(),
    "Look [Image #1] ",
    "text plus image draft text",
  );
  assertWidgetHasAttachment(harness, "text plus image submit");

  const submittedText = editor.getExpandedText().trim();
  editor.handleInput(SUBMIT_INPUT);
  const results = await harness.pi.emit(
    "input",
    { text: submittedText, images: [] },
    harness.ctx,
  );
  assertArrayLength(results, 1, "text plus image input hook result count");

  const result = results[0];
  assertTransformResult(result, "text plus image input hook result");
  assertEqual(
    result.text,
    "Look",
    "text plus image submit should strip placeholder",
  );
  assertArrayLength(
    result.images,
    1,
    "text plus image submit should include one image content item",
  );
  assertImageContent(result.images[0], "text plus image submit image");
  assertWidgetCleared(harness, "text plus image submit");
}

function assertImageOnlySubmit(
  harness: RuntimeHarness,
  editor: EditorSurface,
  imagePath: string,
): void {
  editor.insertTextAtCursor(imagePath);
  assertImageAttachmentState(editor, harness, "image-only submit");

  editor.handleInput(SUBMIT_INPUT);
  assertArrayLength(
    harness.sentUserMessages,
    1,
    "image-only submit should send one message",
  );

  const message = harness.sentUserMessages[0];
  if (!message) fail("image-only submit should capture a message");
  assertArrayLength(
    message.content,
    1,
    "image-only submit should send one image block",
  );
  assertImageContent(message.content[0], "image-only submit image");
  assertEqual(
    editor.getText(),
    "",
    "image-only submit should clear editor text",
  );
  assertWidgetCleared(harness, "image-only submit");
}

function assertNormalDeletionClearsDraft(
  harness: RuntimeHarness,
  editor: EditorSurface,
  imagePath: string,
): void {
  editor.insertTextAtCursor(imagePath);
  assertImageAttachmentState(editor, harness, "normal deletion");

  for (const key of ["\x1b", "0", "1", "1", "x"]) {
    editor.handleInput(key);
  }

  assertEqual(
    editor.getMode(),
    "normal",
    "normal deletion should leave editor in NORMAL mode",
  );
  assertEqual(
    editor.getText(),
    "",
    "normal deletion should remove the placeholder text",
  );
  assertWidgetCleared(harness, "normal deletion");
}

async function verifySupportedOrder(
  workspace: string,
  imageExtension: PiExtension,
): Promise<void> {
  const imagePath = join(workspace, "fixture.png");

  try {
    const surfaceHarness = await installSupportedOrder(
      workspace,
      imageExtension,
    );
    assertPiVimSurfaceForLaterDecorator(mountEditor(surfaceHarness));

    const modalHarness = await installSupportedOrder(workspace, imageExtension);
    assertPiVimModalBehavior(mountEditor(modalHarness));

    const directImageHarness = await installSupportedOrder(
      workspace,
      imageExtension,
    );
    assertImageAttachmentInsertedByDirectInsert(
      mountEditor(directImageHarness),
      directImageHarness,
      imagePath,
    );

    const bracketedImageHarness = await installSupportedOrder(
      workspace,
      imageExtension,
    );
    assertImageAttachmentInsertedByBracketedPaste(
      mountEditor(bracketedImageHarness),
      bracketedImageHarness,
      imagePath,
    );

    const textAndImageHarness = await installSupportedOrder(
      workspace,
      imageExtension,
    );
    await assertTextAndImageSubmit(
      textAndImageHarness,
      mountEditor(textAndImageHarness),
      imagePath,
    );

    const imageOnlyHarness = await installSupportedOrder(
      workspace,
      imageExtension,
    );
    assertImageOnlySubmit(
      imageOnlyHarness,
      mountEditor(imageOnlyHarness),
      imagePath,
    );

    const deletionHarness = await installSupportedOrder(
      workspace,
      imageExtension,
    );
    assertNormalDeletionClearsDraft(
      deletionHarness,
      mountEditor(deletionHarness),
      imagePath,
    );
  } catch (error) {
    const message = formatUnknownError(error);
    if (message.startsWith("cross-package blocker:")) throw error;
    crossPackageBlocker(message);
  }
}

async function main(): Promise<void> {
  const workspace = await createWorkspace();
  console.log("image-attachments-e2e: npm install --ignore-scripts completed");

  const imageExtension = await importImageAttachmentsExtension(workspace);
  await verifySupportedOrder(workspace, imageExtension);

  console.log("PASS pi-vim then image-attachments");
  console.log("PASS image-attachments-e2e");
}

void main().catch((error: unknown) => {
  console.error(formatUnknownError(error));
  process.exitCode = 1;
});
