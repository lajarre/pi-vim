/**
 * The oracle defaults to nvim_feedkeys(..., 'x'): mapped input. Its undo
 * grouping can differ from typed input around dot-repeat (2P.u can retain
 * four copies instead of two). Opt into 'xt' with typedInput for checkpoints
 * that must observe each typed undo boundary; do not silently change all
 * existing cases. Always compare text, cursor, mode and the unnamed register.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ModalEditor } from "../index.js";
import { stubKeybindings, stubTheme, stubTui } from "./harness.js";

export type NvimParityMode = "normal" | "insert" | "visual" | "visual-line";

/** The lua driver can only seed the buffer in one of these two modes. */
export type NvimParityInitialMode = "normal" | "insert";

export type NvimParityCursor = {
  line: number;
  col: number;
};

export type NvimParityInitialState = {
  text: string;
  cursor: NvimParityCursor;
  mode?: NvimParityInitialMode;
  register?: string;
};

export type NvimParityCase = {
  name: string;
  initial: NvimParityInitialState;
  keys: string[];
  /** Preserve typed-key undo boundaries for scenarios that include dot. */
  typedInput?: boolean;
  /** Exercise paint between inputs; the oracle still compares semantic state. */
  renderWidths?: readonly number[];
};

export type NvimParitySnapshot = {
  text: string;
  cursor: NvimParityCursor;
  mode: NvimParityMode;
  register: string;
};

type ModalEditorMutable = {
  state?: {
    lines?: string[];
    cursorLine?: number;
    cursorCol?: number;
  };
  preferredVisualCol?: number | null;
  tui?: {
    requestRender?: () => void;
  };
};

type RawNvimSnapshot = {
  text: string;
  cursor: NvimParityCursor;
  mode: string;
  register: string;
};

const NVIM_RESULT_PREFIX = "PI_VIM_NVIM_RESULT:";

const NVIM_MODE_MAP: Record<string, NvimParityMode> = {
  n: "normal",
  no: "normal",
  niI: "normal",
  niR: "normal",
  niV: "normal",
  nt: "normal",
  i: "insert",
  ic: "insert",
  ix: "insert",
  R: "insert",
  Rc: "insert",
  Rv: "insert",
  v: "visual",
  V: "visual-line",
};

const NVIM_DRIVER_LUA = [
  "local input = vim.json.decode(vim.env.PI_VIM_NVIM_SCENARIO)",
  "local lines = vim.split(input.text, '\\n', { plain = true })",
  "if #lines == 0 then lines = { '' } end",
  "local undo_levels = vim.bo.undolevels",
  "vim.bo.undolevels = -1",
  "vim.api.nvim_buf_set_lines(0, 0, -1, true, lines)",
  "vim.bo.undolevels = undo_levels",
  "vim.fn.setreg('\"', input.register or '')",
  "vim.api.nvim_win_set_cursor(0, { input.cursor.line + 1, input.cursor.col })",
  "if input.mode == 'insert' then vim.cmd('startinsert') else vim.cmd('stopinsert') end",
  "vim.api.nvim_win_set_cursor(0, { input.cursor.line + 1, input.cursor.col })",
  "local keys = table.concat(input.keys, '')",
  "local term = vim.api.nvim_replace_termcodes(keys, true, false, true)",
  "vim.api.nvim_feedkeys(term, input.typedInput and 'xt' or 'x', false)",
  "local out_lines = vim.api.nvim_buf_get_lines(0, 0, -1, true)",
  "local cursor = vim.api.nvim_win_get_cursor(0)",
  "local snapshot = { text = table.concat(out_lines, '\\n'), cursor = { line = cursor[1] - 1, col = cursor[2] }, mode = vim.api.nvim_get_mode().mode, register = vim.fn.getreg('\"') }",
  `print('${NVIM_RESULT_PREFIX}' .. vim.json.encode(snapshot))`,
  "vim.cmd('qa!')",
].join("; ");

function toNvimKey(key: string): string {
  switch (key) {
    case "\x1b":
      return "<Esc>";
    case "\n":
      return "<CR>";
    case "\r":
      return "<CR>";
    case "\t":
      return "<Tab>";
    default:
      return key;
  }
}

function normalizeNvimMode(mode: string): NvimParityMode {
  const normalized = NVIM_MODE_MAP[mode];
  if (!normalized) {
    throw new Error(`unsupported nvim mode in parity snapshot: ${mode}`);
  }
  return normalized;
}

function assertSnapshot(value: unknown): asserts value is RawNvimSnapshot {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);

  const snapshot = value as Record<string, unknown>;
  assert.equal(typeof snapshot.text, "string");
  assert.equal(typeof snapshot.mode, "string");
  assert.equal(typeof snapshot.register, "string");
  assert.equal(typeof snapshot.cursor, "object");
  assert.notEqual(snapshot.cursor, null);

  const cursor = snapshot.cursor as Record<string, unknown>;
  assert.equal(typeof cursor.line, "number");
  assert.equal(typeof cursor.col, "number");
}

function setPiCursor(editor: ModalEditor, cursor: NvimParityCursor): void {
  const mutable = editor as unknown as ModalEditorMutable;
  const state = mutable.state;
  if (!state || !Array.isArray(state.lines)) {
    throw new Error("ModalEditor state is unavailable");
  }

  const maxLine = Math.max(0, state.lines.length - 1);
  const line = Math.max(0, Math.min(cursor.line, maxLine));
  const lineText = state.lines[line] ?? "";
  const col = Math.max(0, Math.min(cursor.col, lineText.length));

  state.cursorLine = line;
  state.cursorCol = col;
  mutable.preferredVisualCol = col;
  mutable.tui?.requestRender?.();
}

function takePiSnapshot(editor: ModalEditor): NvimParitySnapshot {
  const cursor = editor.getCursor();
  return {
    text: editor.getText(),
    cursor: { line: cursor.line, col: cursor.col },
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

export function runPiParityCase(testCase: NvimParityCase): NvimParitySnapshot {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setText(testCase.initial.text);
  editor.setRegister(testCase.initial.register ?? "");

  if ((testCase.initial.mode ?? "normal") === "normal") {
    editor.handleInput("\x1b");
  }

  setPiCursor(editor, testCase.initial.cursor);
  // Match nvim's undo-disabled fixture load: exhausted undo must stop at the
  // initial text, not undo the harness's programmatic setText back to empty.
  const { undoStack } = editor as unknown as { undoStack: { clear(): void } };
  undoStack.clear();

  for (const key of testCase.keys) {
    editor.handleInput(key);
    for (const width of testCase.renderWidths ?? []) editor.render(width);
  }

  return takePiSnapshot(editor);
}

export async function runNvimParityCase(
  testCase: NvimParityCase,
): Promise<NvimParitySnapshot> {
  const scenario = {
    text: testCase.initial.text,
    cursor: {
      line: testCase.initial.cursor.line,
      col: Buffer.byteLength(
        (
          testCase.initial.text.split("\n")[testCase.initial.cursor.line] ?? ""
        ).slice(0, testCase.initial.cursor.col),
      ),
    },
    mode: testCase.initial.mode ?? "normal",
    register: testCase.initial.register ?? "",
    keys: testCase.keys.map(toNvimKey),
    typedInput: testCase.typedInput ?? false,
  };

  const child = spawn(
    "nvim",
    [
      "--clean",
      "--headless",
      "-n",
      "-i",
      "NONE",
      "-u",
      "NONE",
      "-c",
      `lua ${NVIM_DRIVER_LUA}`,
    ],
    {
      env: {
        ...process.env,
        PI_VIM_NVIM_SCENARIO: JSON.stringify(scenario),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (exit.code !== 0) {
    throw new Error(
      `nvim parity oracle failed for ${testCase.name} (code=${exit.code}, signal=${String(exit.signal)}, stderr=${JSON.stringify(stderr.trim())})`,
    );
  }

  const combinedOutput = `${stdout}\n${stderr}`;
  const resultLine = combinedOutput
    .split(/\r?\n/)
    .find((line) => line.includes(NVIM_RESULT_PREFIX));

  if (!resultLine) {
    throw new Error(
      `nvim parity oracle produced no result for ${testCase.name} (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    );
  }

  const parsed = JSON.parse(
    resultLine.slice(
      resultLine.indexOf(NVIM_RESULT_PREFIX) + NVIM_RESULT_PREFIX.length,
    ),
  ) as unknown;
  assertSnapshot(parsed);

  return {
    text: parsed.text,
    cursor: {
      line: parsed.cursor.line,
      col: Buffer.from(parsed.text.split("\n")[parsed.cursor.line] ?? "")
        .subarray(0, parsed.cursor.col)
        .toString().length,
    },
    mode: normalizeNvimMode(parsed.mode),
    register: parsed.register,
  };
}

export async function assertMatchesNvim(
  testCase: NvimParityCase,
): Promise<void> {
  const [pi, nvim] = await Promise.all([
    Promise.resolve(runPiParityCase(testCase)),
    runNvimParityCase(testCase),
  ]);

  assert.deepEqual(pi, nvim);
}
