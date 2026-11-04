/**
 * Demo buffer-state helper for the pi-vim demo-gif storyboard
 * (`doc/dev/demo-storyboard.md`).
 *
 * The storyboard is recorded by hand in a live Pi session; this script exists
 * so the person recording can (a) copy an exact seed buffer into the prompt
 * before each shot and (b) confirm the showcased keystrokes land the buffer,
 * cursor, mode, and ex-bridge dispatch the storyboard promises — deterministic
 * ground truth, no live Pi runtime needed. It drives `ModalEditor` through its
 * public surface only, the same way the test harness does.
 *
 *   node --import tsx/esm script/demo-buffers.ts          # human-readable report
 *   node --import tsx/esm script/demo-buffers.ts --json    # machine-readable
 *
 * Each shot runs on a fresh editor: `setup` keys establish the seed buffer
 * (printed as "seed"), then `action` keys perform the showcased gesture
 * (printed as "after"). Keys are atomic input bytes — `Esc` is `\x1b`, a typed
 * Enter/submit is `\r`, and a literal newline in the buffer is `\n`.
 */
import { ModalEditor } from "../index.js";

type ModalEditorConstructorArgs = ConstructorParameters<typeof ModalEditor>;

const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
} as unknown as ModalEditorConstructorArgs[0];

const stubTheme = {
  borderColor: (s: string) => s,
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as ModalEditorConstructorArgs[1];

const stubKeybindings = {
  matches: () => false,
  getKeys: () => [],
} as unknown as ModalEditorConstructorArgs[2];

const ESC = "\x1b";
const ENTER = "\r";

/** Turn atomic input bytes into the notation the storyboard prints. */
function describeKeys(keys: string[]): string {
  return keys
    .map((key) => {
      if (key === ESC) return "<Esc>";
      if (key === ENTER) return "<Enter>";
      if (key === "\n") return "<newline>";
      if (key === " ") return "<Space>";
      return key;
    })
    .join(" ");
}

interface CapturedSession {
  editor: ModalEditor;
  dispatched: string[];
  notifications: string[];
  clipboard: string[];
  quitCount: () => number;
}

function createSession(knownCommands: readonly string[]): CapturedSession {
  const dispatched: string[] = [];
  const notifications: string[] = [];
  const clipboard: string[] = [];
  let quitCount = 0;

  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn((text) => clipboard.push(text));
  editor.setClipboardReadFn(() => null);
  editor.setQuitFn(() => {
    quitCount++;
  });
  editor.setNotifyFn((message) => {
    notifications.push(message);
  });
  // Capture the dispatched command line instead of driving a live submit path.
  editor.setRunCommandFn((commandLine) => {
    dispatched.push(commandLine);
    return undefined;
  });
  editor.setCommandNamesFn(() => new Set(knownCommands));

  return {
    editor,
    dispatched,
    notifications,
    clipboard,
    quitCount: () => quitCount,
  };
}

interface BufferView {
  text: string;
  cursor: { line: number; col: number };
  mode: string;
  /** The cursor line with a caret marker inserted at the cursor column. */
  marked: string;
}

function viewBuffer(editor: ModalEditor): BufferView {
  const text = editor.getText();
  const cursor = editor.getCursor();
  const lines = text.split("\n");
  const line = lines[cursor.line] ?? "";
  const marked = `${line.slice(0, cursor.col)}‸${line.slice(cursor.col)}`;
  return {
    text,
    cursor: { line: cursor.line, col: cursor.col },
    mode: editor.getMode(),
    marked,
  };
}

interface Shot {
  id: string;
  feature: "dot-repeat" | "visual" | "ex-bridge";
  title: string;
  /** One-line caption for the gif. */
  caption: string;
  /** Commands the ex bridge should treat as known (for `:name` dispatch). */
  knownCommands?: readonly string[];
  /** Keys that establish the seed buffer (printed as "seed"). */
  setup: string[];
  /** The showcased gesture (printed as "after"). */
  action: string[];
}

/** Type `text` in the startup insert session, Esc to normal, `0` to col 0. */
function seedNormal(text: string): string[] {
  return [...text.split(""), ESC, "0"];
}

const SHOTS: Shot[] = [
  {
    id: "D1",
    feature: "dot-repeat",
    title: "repeat a word change across a list",
    caption: "ciwX<Esc> once, then w. down the line — one edit, replayed.",
    setup: seedNormal("one two three four"),
    action: ["c", "i", "w", "X", ESC, "w", ".", "w", ".", "w", "."],
  },
  {
    id: "D2",
    feature: "dot-repeat",
    title: "counted repeat overrides the stored count",
    caption: "dw deletes one word; 2. replays it as 2dw.",
    setup: seedNormal("a b c d e f"),
    action: ["d", "w", "2", "."],
  },
  {
    id: "D3",
    feature: "dot-repeat",
    title: "implicit-insert typing is repeatable",
    caption:
      "Type at the startup prompt (no i pressed), <Esc>, then . re-types it.",
    // The seed IS the implicit-insert typing: the prompt opens in insert mode,
    // so `deploy` is recorded as an `i deploy <Esc>` change with no `i` keyed.
    setup: seedNormal("deploy"),
    action: ["."],
  },
  {
    id: "V1",
    feature: "visual",
    title: "characterwise selection + delete",
    caption: "v2l selects three chars; d deletes them. Footer reads VISUAL.",
    setup: seedNormal("hello world"),
    action: ["v", "2", "l", "d"],
  },
  {
    id: "V2",
    feature: "visual",
    title: "linewise selection + delete",
    caption: "Vj selects two lines; d deletes both. Footer reads V-LINE.",
    setup: [..."first\nsecond\nthird".split(""), ESC, "g", "g"],
    action: ["V", "j", "d"],
  },
  {
    id: "V3",
    feature: "visual",
    title: "visual yank then put",
    caption:
      "vey yanks a word (cursor snaps to its start); $p pastes it at line end.",
    setup: seedNormal("copyme rest"),
    action: ["v", "e", "y", "$", "p"],
  },
  {
    id: "V4",
    feature: "visual",
    title: "visual edits are deliberately not dot-repeatable",
    caption:
      "x is repeatable; a visual delete clears it, so the next . is a no-op.",
    setup: seedNormal("aa bb cc"),
    action: ["x", "v", "l", "d", "."],
  },
  {
    id: "E1",
    feature: "ex-bridge",
    title: "quit form on an empty prompt",
    caption: ":q quits when the prompt is empty.",
    // Esc to normal mode first — `:` only opens the ex line from normal mode.
    setup: [ESC],
    action: [":", "q", ENTER],
  },
  {
    id: "E2",
    feature: "ex-bridge",
    title: "shell dispatch through the ex bridge",
    caption:
      ":!ls submits !ls to Pi's bash mode; the composed prompt is restored.",
    setup: seedNormal("draft prompt"),
    action: [":", "!", "l", "s", ENTER],
  },
  {
    id: "E3",
    feature: "ex-bridge",
    title: "pi-command dispatch through the ex bridge",
    caption:
      ":tree dispatches /tree — exactly typing /tree and pressing Enter.",
    knownCommands: ["tree"],
    setup: seedNormal("draft prompt"),
    action: [":", "t", "r", "e", "e", ENTER],
  },
  {
    id: "E4",
    feature: "ex-bridge",
    title: "quit precedence keeps :q! a force quit",
    caption:
      "A leading ! never dispatches to the shell when the name is a quit form.",
    setup: seedNormal("unsaved text"),
    action: [":", "q", "!", ENTER],
  },
];

interface ShotResult {
  id: string;
  feature: string;
  title: string;
  caption: string;
  seed: BufferView;
  after: BufferView;
  keys: string;
  dispatched: string[];
  notifications: string[];
  clipboard: string[];
  quitCount: number;
}

function runShot(shot: Shot): ShotResult {
  const session = createSession(shot.knownCommands ?? []);
  for (const key of shot.setup) session.editor.handleInput(key);
  const seed = viewBuffer(session.editor);
  for (const key of shot.action) session.editor.handleInput(key);
  const after = viewBuffer(session.editor);
  return {
    id: shot.id,
    feature: shot.feature,
    title: shot.title,
    caption: shot.caption,
    seed,
    after,
    keys: describeKeys(shot.action),
    dispatched: session.dispatched,
    notifications: session.notifications,
    clipboard: session.clipboard,
    quitCount: session.quitCount(),
  };
}

function printReport(results: ShotResult[]): void {
  const out: string[] = [];
  let lastFeature = "";
  for (const r of results) {
    if (r.feature !== lastFeature) {
      out.push("");
      out.push(`## ${r.feature}`);
      lastFeature = r.feature;
    }
    out.push("");
    out.push(`### ${r.id} — ${r.title}`);
    out.push(`caption : ${r.caption}`);
    out.push(`keys    : ${r.keys}`);
    out.push(`seed    : ${JSON.stringify(r.seed.text)}  [${r.seed.mode}]`);
    out.push(`          ${r.seed.marked}`);
    out.push(
      `after   : ${JSON.stringify(r.after.text)}  [${r.after.mode}]  cursor ${r.after.cursor.line}:${r.after.cursor.col}`,
    );
    out.push(`          ${r.after.marked}`);
    if (r.dispatched.length > 0)
      out.push(`dispatch: ${JSON.stringify(r.dispatched)}`);
    if (r.quitCount > 0) out.push(`quit    : ${r.quitCount}`);
    if (r.notifications.length > 0)
      out.push(`notify  : ${JSON.stringify(r.notifications)}`);
    if (r.clipboard.length > 0)
      out.push(`clip    : ${JSON.stringify(r.clipboard)}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

function main(): void {
  const results = SHOTS.map(runShot);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  process.stdout.write("# pi-vim demo storyboard — verified buffer states\n");
  process.stdout.write(
    "# ‸ marks the cursor. Regenerate: node --import tsx/esm script/demo-buffers.ts\n",
  );
  printReport(results);
}

main();
