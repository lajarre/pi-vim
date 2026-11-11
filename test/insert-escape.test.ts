import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vim, { ModalEditor } from "../index.js";
import {
  type InsertEscapeSettings,
  setPiVimSettingsReaderForTests,
} from "../settings.js";
import {
  createExtensionApiHarness,
  sendKeys,
  stubKeybindings,
  stubTheme,
  stubTui,
} from "./harness.js";

const ESC = "\x1b";

// No sequence ships by default; these tests opt in to `jk`.
const JK: InsertEscapeSettings = {
  enabled: true,
  sequence: "jk",
  timeoutMs: 300,
};

type Clocked = {
  editor: ModalEditor;
  type(keys: string[], gap?: number): void;
};

/** Each key lands `gap` ms after the previous one on an injected clock. */
function createEditor(
  settings: Partial<InsertEscapeSettings> = {},
  text = "",
): Clocked {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setInsertEscapeSettings({ ...JK, ...settings });
  let now = 1_000;
  editor.setInsertEscapeClock(() => now);
  if (text) {
    editor.setText(text);
    sendKeys(editor, [ESC, "0"]);
  }
  return {
    editor,
    type(keys, gap = 10) {
      for (const key of keys) {
        now += gap;
        editor.handleInput(key);
      }
    },
  };
}

type HostState = {
  undoStack: { stack: unknown[] };
  redoStack: unknown[];
  historyIndex: number;
  historyDraft: unknown;
};

function snapshot(editor: ModalEditor) {
  const host = editor as unknown as HostState;
  return {
    text: editor.getText(),
    cursor: editor.getCursor(),
    mode: editor.getMode(),
    register: editor.getRegister(),
    undoDepth: host.undoStack.stack.length,
    redoLength: host.redoStack.length,
    historyIndex: host.historyIndex,
    hasHistoryDraft: host.historyDraft != null,
  };
}

const UP = "\x1b[A";

/** Two prompt-history entries and history navigation on, like a Pi session. */
function withHistory(clocked: Clocked): Clocked {
  clocked.editor.setHistoryNavigation(true);
  clocked.editor.addToHistory("older one");
  clocked.editor.addToHistory("newer one");
  return clocked;
}

/**
 * Runs `before + sequence + after` on an escape-enabled editor and
 * `before + Esc + after` on an identical twin, then compares full state.
 */
function assertEscTwin(
  keys: { before: string[]; after?: string[] },
  options: {
    settings?: Partial<InsertEscapeSettings>;
    text?: string;
    setup?: (clocked: Clocked) => Clocked;
  } = {},
) {
  const setup = options.setup ?? ((clocked: Clocked) => clocked);
  const settings = { ...JK, ...options.settings };
  const viaSequence = setup(createEditor(settings, options.text));
  const viaEscape = setup(createEditor(settings, options.text));
  viaSequence.type([...keys.before, ...settings.sequence]);
  viaEscape.type([...keys.before, ESC]);
  assert.deepEqual(snapshot(viaSequence.editor), snapshot(viaEscape.editor));
  viaSequence.type(keys.after ?? []);
  viaEscape.type(keys.after ?? []);
  assert.deepEqual(snapshot(viaSequence.editor), snapshot(viaEscape.editor));
  return { viaSequence, viaEscape };
}

describe("insert escape sequence", () => {
  it("jk inside the window lands exactly where Esc would", () => {
    for (const prefix of [[], ["a", "b", "c"], ["a", "\r", "b"]]) {
      const viaSequence = createEditor({}, "hello world");
      const viaEscape = createEditor({}, "hello world");
      for (const e of [viaSequence.editor, viaEscape.editor])
        e.setRegister("keep");
      viaSequence.type(["w", "i", ...prefix, "j", "k"]);
      viaEscape.type(["w", "i", ...prefix, ESC]);
      assert.deepEqual(
        snapshot(viaSequence.editor),
        snapshot(viaEscape.editor),
      );
      assert.equal(viaSequence.editor.getMode(), "normal");
    }
  });

  it("escapes from an empty prompt at column 0", () => {
    const { editor, type } = createEditor();
    type(["j", "k"]);
    const { text, cursor, mode, register } = snapshot(editor);
    assert.deepEqual(
      { text, cursor, mode, register },
      { text: "", cursor: { line: 0, col: 0 }, mode: "normal", register: "" },
    );
  });

  it("keeps jk as text after the per-key timeout", () => {
    const { editor, type } = createEditor();
    type(["j"]);
    type(["k"], 301);
    assert.equal(editor.getText(), "jk");
    assert.equal(editor.getMode(), "insert");
  });

  it("escapes when the gap equals the timeout", () => {
    const { editor, type } = createEditor({ timeoutMs: 120 });
    type(["x", "j"]);
    type(["k"], 120);
    assert.equal(editor.getText(), "x");
    assert.equal(editor.getMode(), "normal");
  });

  it("measures the timeout per gap, not over the whole sequence", () => {
    const { editor, type } = createEditor({ sequence: "asdf", timeoutMs: 300 });
    type(["a", "s", "d", "f"], 250);
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "normal");
  });

  it("jjk escapes and leaves one j", () => {
    const { editor, type } = createEditor();
    type(["j", "j", "k"]);
    assert.equal(editor.getText(), "j");
    assert.equal(editor.getMode(), "normal");
    assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  });

  it("restarts after a timed-out first key", () => {
    const { editor, type } = createEditor();
    type(["j"]);
    type(["j"], 500);
    type(["k"]);
    assert.equal(editor.getText(), "j");
    assert.equal(editor.getMode(), "normal");
  });

  it("an interrupted sequence stays text", () => {
    const { editor, type } = createEditor();
    type(["j", "x", "k"]);
    assert.equal(editor.getText(), "jxk");
    assert.equal(editor.getMode(), "insert");
  });

  it("is case-sensitive", () => {
    const { editor, type } = createEditor();
    type(["j", "K", "J", "k"]);
    assert.equal(editor.getText(), "jKJk");
    assert.equal(editor.getMode(), "insert");
  });

  it("supports jj as the configured sequence", () => {
    const { editor, type } = createEditor({ sequence: "jj" });
    type(["a", "j", "j"]);
    assert.equal(editor.getText(), "a");
    assert.equal(editor.getMode(), "normal");
    // `jk` is plain text once the sequence is `jj`.
    const other = createEditor({ sequence: "jj" });
    other.type(["j", "k"]);
    assert.equal(other.editor.getText(), "jk");
    assert.equal(other.editor.getMode(), "insert");
  });

  it("jjj with jj escapes after the first pair and leaves no text", () => {
    const { editor, type } = createEditor({ sequence: "jj" });
    type(["j", "j", "j"]);
    // The third `j` is a Normal-mode `j` motion on a one-line buffer.
    assert.equal(editor.getText(), "");
    assert.equal(editor.getMode(), "normal");
  });

  it("supports a 3-key sequence", () => {
    const { editor, type } = createEditor({ sequence: "jkl" });
    type(["a", "j", "k", "l"]);
    assert.equal(editor.getText(), "a");
    assert.equal(editor.getMode(), "normal");
    const partial = createEditor({ sequence: "jkl" });
    partial.type(["j", "k", "x"]);
    assert.equal(partial.editor.getText(), "jkx");
    assert.equal(partial.editor.getMode(), "insert");
  });

  it("matches overlapping prefixes of a repeated-letter sequence", () => {
    const { editor, type } = createEditor({ sequence: "aab" });
    type(["a", "a", "a", "b"]);
    assert.equal(editor.getText(), "a");
    assert.equal(editor.getMode(), "normal");
  });

  it("never escapes on a pasted chunk", () => {
    const { editor, type } = createEditor();
    type(["jk"]);
    type(["\x1b[200~jk\x1b[201~"]);
    assert.equal(editor.getText(), "jkjk");
    assert.equal(editor.getMode(), "insert");
  });

  it("never escapes while the host paste is active", () => {
    const { editor, type } = createEditor();
    type(["\x1b[200~", "j", "k", "\x1b[201~"]);
    assert.equal(editor.getText(), "jk");
    assert.equal(editor.getMode(), "insert");
  });

  it("does nothing when disabled", () => {
    const { editor, type } = createEditor({ enabled: false });
    type(["j", "k"]);
    assert.equal(editor.getText(), "jk");
    assert.equal(editor.getMode(), "insert");
  });

  it("is off on an editor nobody configured", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    sendKeys(editor, ["j", "k"]);
    assert.equal(editor.getText(), "jk");
    assert.equal(editor.getMode(), "insert");
  });

  it("keeps the unnamed register", () => {
    const { editor, type } = createEditor();
    editor.setRegister("keep");
    type(["a", "j", "k"]);
    assert.equal(editor.getRegister(), "keep");
  });

  it("u after the escape never brings the letters back", () => {
    const { editor, type } = createEditor({}, "start");
    type(["A", " ", "f", "o", "o", "j", "k"]);
    assert.equal(editor.getText(), "start foo");
    type(["u"]);
    assert.equal(editor.getText(), "start");
    type(["\x12"]);
    assert.equal(editor.getText(), "start foo");
    for (let i = 0; i < 4; i++) {
      type(["u"]);
      assert.doesNotMatch(editor.getText(), /[jk]/);
    }
  });

  it("an escape-only insert is no change, like i<Esc>", () => {
    const viaSequence = createEditor({}, "abc");
    const viaEscape = createEditor({}, "abc");
    viaSequence.type(["x", "i", "j", "k", "u"]);
    viaEscape.type(["x", "i", ESC, "u"]);
    assert.deepEqual(snapshot(viaSequence.editor), snapshot(viaEscape.editor));
    assert.equal(viaSequence.editor.getText(), "abc");
    viaSequence.type(["x", "i", "j", "k", "."]);
    viaEscape.type(["x", "i", ESC, "."]);
    assert.deepEqual(snapshot(viaSequence.editor), snapshot(viaEscape.editor));
  });

  it("an escape-only insert keeps redo, like i<Esc>", () => {
    const viaSequence = createEditor({}, "abc");
    const viaEscape = createEditor({}, "abc");
    viaSequence.type(["x", "u", "i", "j", "k", "\x12"]);
    viaEscape.type(["x", "u", "i", ESC, "\x12"]);
    assert.equal(viaSequence.editor.getText(), "bc");
    assert.deepEqual(snapshot(viaSequence.editor), snapshot(viaEscape.editor));
  });

  it("u never resurrects the letters in a host-tainted session", () => {
    const { editor, type } = createEditor();
    type(["a"]);
    editor.insertTextAtCursor("host");
    type(["b", "j", "k"]);
    assert.equal(editor.getText(), "ahostb");
    for (let i = 0; i < 5; i++) {
      type(["u"]);
      assert.doesNotMatch(editor.getText(), /[jk]/);
    }
  });

  it(". replays the inserted text without the sequence", () => {
    const viaSequence = createEditor({}, "x");
    const viaEscape = createEditor({}, "x");
    viaSequence.type(["A", "a", "b", "j", "k", "."]);
    viaEscape.type(["A", "a", "b", ESC, "."]);
    assert.equal(viaSequence.editor.getText(), "xabab");
    assert.deepEqual(snapshot(viaSequence.editor), snapshot(viaEscape.editor));
  });

  it(". replays an implicit insert without the sequence", () => {
    const { editor, type } = createEditor();
    type(["a", "b", "j", "k", "."]);
    assert.equal(editor.getText(), "aabb");
  });

  it("a replayed . never triggers the escape", () => {
    const { editor, type } = createEditor({}, "x");
    type(["A", "j"]);
    type(["k"], 1_000);
    type([ESC]);
    assert.equal(editor.getText(), "xjk");
    type(["."]);
    assert.equal(editor.getText(), "xjkjk");
    assert.equal(editor.getMode(), "normal");
  });

  it("resets on Esc and mode changes", () => {
    const { editor, type } = createEditor();
    type(["j", ESC, "a", "k"]);
    assert.equal(editor.getText(), "jk");
    assert.equal(editor.getMode(), "insert");
  });

  it("resets on a non-printable key", () => {
    const { editor, type } = createEditor();
    type(["j", "\x7f", "k"]);
    assert.equal(editor.getText(), "k");
    assert.equal(editor.getMode(), "insert");
    const arrow = createEditor();
    arrow.type(["x", "j", "\x1b[D", "\x1b[C", "k"]);
    assert.equal(arrow.editor.getText(), "xjk");
    assert.equal(arrow.editor.getMode(), "insert");
  });

  it("stays in insert when the buffer before the cursor is no longer the sequence", () => {
    const { editor, type } = createEditor();
    type(["j"]);
    // Another extension rewrote the buffer without going through the editor.
    const state = (
      editor as unknown as { state: { lines: string[]; cursorCol: number } }
    ).state;
    state.lines = ["xy"];
    state.cursorCol = 2;
    type(["k"]);
    assert.equal(editor.getText(), "xyk");
    assert.equal(editor.getMode(), "insert");
  });
});

describe("insert escape matches its Esc twin", () => {
  it("a no-op Backspace before the sequence leaves no phantom undo step", () => {
    const { viaSequence } = assertEscTwin({
      before: ["a", "b", "c", ESC, "0", "i", "\x7f"],
      after: ["u"],
    });
    assert.equal(viaSequence.editor.getText(), "");
    assertEscTwin({
      before: ["a", "b", "c", ESC, "0", "i", "\x7f"],
      after: ["u", "x", "u", "u"],
    });
  });

  it("a no-op Ctrl+U on an empty prompt leaves no phantom undo step", () => {
    assertEscTwin({ before: ["\x15"], after: ["u"] });
    assertEscTwin({
      before: ["a", "b", "c", ESC, "o", "\x15"],
      after: ["u", "x", "u", "u"],
    });
  });

  it("Up recall then the sequence keeps the draft reachable with j", () => {
    const { viaSequence } = assertEscTwin(
      { before: ["d", "r", "a", "f", "t", UP, UP], after: ["j"] },
      { setup: withHistory },
    );
    assert.equal(viaSequence.editor.getText(), "draft");
  });

  it("a two-deep recall then the sequence browses back like Esc", () => {
    const { viaSequence } = assertEscTwin(
      { before: ["d", "r", "a", "f", "t", UP, UP, UP], after: ["j", "j"] },
      { setup: withHistory },
    );
    assert.equal(viaSequence.editor.getText(), "draft");
  });

  it("Normal k recall, i, then the sequence keeps browsing", () => {
    const { viaSequence } = assertEscTwin(
      { before: ["d", "r", "a", "f", "t", ESC, "k", "i"], after: ["j"] },
      { setup: withHistory },
    );
    assert.equal(viaSequence.editor.getText(), "draft");
  });

  it("a real edit after a recall still ends history browsing", () => {
    const timedOut = withHistory(createEditor());
    timedOut.type(["d", "r", "a", "f", "t", UP, UP, "j"]);
    timedOut.type(["k"], 301);
    const timedOutHost = timedOut.editor as unknown as HostState;
    assert.equal(timedOut.editor.getText(), "jknewer one");
    assert.equal(timedOutHost.historyIndex, -1);
    assert.equal(timedOutHost.historyDraft, null);
    // With `jk`, a fast `jjk` keeps the first `j` as real text.
    const { viaSequence } = assertEscTwin(
      { before: ["d", "r", "a", "f", "t", UP, UP, "j"], after: ["j"] },
      { setup: withHistory },
    );
    assert.equal(viaSequence.editor.getText(), "jnewer one");
    const sequenceHost = viaSequence.editor as unknown as HostState;
    assert.equal(sequenceHost.historyIndex, -1);
  });

  it("a key consumed by jump-to-char never deletes existing text", () => {
    // Pi-only (Ctrl+] jump-to-char): `j` is the jump target, so only `k` is
    // typed and the `jk` before the cursor is not what these keys inserted.
    const { editor, type } = createEditor({}, "ajj b");
    type(["l", "i", "\x1d", "j", "k"]);
    assert.equal(editor.getText(), "ajkj b");
    assert.equal(editor.getMode(), "insert");
  });

  it("a backwards clock step between the keys counts as expired", () => {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    editor.setInsertEscapeSettings(JK);
    let now = 10_000;
    editor.setInsertEscapeClock(() => now);
    editor.handleInput("j");
    now -= 5_000;
    editor.handleInput("k");
    assert.equal(editor.getText(), "jk");
    assert.equal(editor.getMode(), "insert");
  });

  it("a counted insert matches Esc", () => {
    assertEscTwin({ before: ["3", "i", "x"] }, { text: "abc" });
  });

  it("cw plus text, then . elsewhere, matches Esc", () => {
    assertEscTwin(
      { before: ["c", "w", "n", "e", "w"], after: ["w", "."] },
      { text: "one two three" },
    );
  });

  it("A plus text, then 3., matches Esc", () => {
    assertEscTwin(
      { before: ["A", "a", "b"], after: ["3", "."] },
      { text: "x" },
    );
  });

  it("lands on a whole grapheme before the cursor like Esc", () => {
    for (const grapheme of ["👍🏽", "e\u0301"]) {
      const { viaSequence } = assertEscTwin(
        { before: ["A", grapheme] },
        { text: "x" },
      );
      assert.deepEqual(viaSequence.editor.getCursor(), { line: 0, col: 1 });
    }
  });

  it("at column 0 of a second line matches Esc", () => {
    assertEscTwin({ before: ["j", "0", "i"] }, { text: "one\ntwo" });
  });
});

describe("insert escape equivalence property", () => {
  const TIMEOUT = 300;

  /** Deterministic LCG so every run replays the same streams. */
  function lcg(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  function twinEditor(sequence: string | null) {
    const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
    editor.setClipboardFn(() => undefined);
    editor.setClipboardReadFn(() => null);
    editor.setHistoryNavigation(true);
    if (sequence)
      editor.setInsertEscapeSettings({
        enabled: true,
        sequence,
        timeoutMs: TIMEOUT,
      });
    editor.addToHistory("older one");
    editor.addToHistory("old jj prompt");
    return editor;
  }

  function fullState(editor: ModalEditor) {
    const internals = editor as unknown as {
      lastRepeatableCommand: unknown;
    };
    return {
      ...snapshot(editor),
      lastRepeatable: internals.lastRepeatableCommand,
    };
  }

  type Step = { key: string; gap: number };

  /**
   * Feeds the escape-enabled editor raw keys and a disabled twin the same
   * keys through an independent lazy Vim-style matcher (held keys flush as
   * text, a full match sends Esc); compares whenever nothing is held. The
   * key after Insert-mode Ctrl+] is a jump target the host consumes, so it
   * never counts toward the sequence.
   */
  function firstMismatch(sequence: string, steps: Step[]): string | null {
    const withEscape = twinEditor(sequence);
    const twin = twinEditor(null);
    let now = 1_000;
    withEscape.setInsertEscapeClock(() => now);
    let held = "",
      lastAt = 0,
      jumpTarget = false;
    const flush = () => {
      for (const key of held) twin.handleInput(key);
      held = "";
    };
    for (const [i, { key, gap }] of steps.entries()) {
      now += gap;
      withEscape.handleInput(key);
      const printable =
        key.length === 1 && key.charCodeAt(0) >= 32 && key !== "\x7f";
      const inInsert = twin.getMode() === "insert";
      if (inInsert && printable && !jumpTarget) {
        if (held && now - lastAt > TIMEOUT) flush();
        const typed = held + key;
        let k = Math.min(typed.length, sequence.length);
        while (k > 0 && !typed.endsWith(sequence.slice(0, k))) k--;
        for (const c of typed.slice(0, typed.length - k)) twin.handleInput(c);
        held = sequence.slice(0, k);
        lastAt = now;
        if (k === sequence.length) {
          held = "";
          twin.handleInput(ESC);
        }
      } else {
        flush();
        twin.handleInput(key);
      }
      jumpTarget = inInsert && key === "\x1d";
      if (held !== "") continue;
      const a = JSON.stringify(fullState(withEscape));
      const b = JSON.stringify(fullState(twin));
      if (a !== b) return `step ${i}:\n  escape=${a}\n  twin=${b}`;
    }
    return null;
  }

  it("matches a lazy matcher feeding Esc to a disabled twin", () => {
    const random = lcg(20261111);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    for (const sequence of ["jk", "jj", "aab", "kjk"]) {
      const letters = [...new Set(sequence)];
      const pool = [
        ...letters,
        ...letters,
        ...letters,
        "x",
        " ",
        ESC,
        "\x7f",
        "\x7f",
        "\x15",
        "\x1d",
        UP,
        "\x1b[B",
        "\x1b[D",
        "\r",
        "i",
        "A",
        "o",
        "c",
        "w",
        "0",
        "3",
        "u",
        "u",
        "\x12",
        ".",
        "é",
      ];
      for (let stream = 0; stream < 100; stream++) {
        const steps: Step[] = Array.from({ length: 24 }, () => ({
          key: pick(pool),
          gap: random() < 0.12 ? TIMEOUT + 100 : 10,
        }));
        const mismatch = firstMismatch(sequence, steps);
        if (mismatch === null) continue;
        assert.fail(
          `sequence ${sequence}, keys ${JSON.stringify(
            steps.map(({ key, gap }) => (gap > TIMEOUT ? "~" : "") + key),
          )}\n${mismatch}`,
        );
      }
    }
  });
});

describe("insert escape session wiring", () => {
  type Factory = (
    ...args: ConstructorParameters<typeof ModalEditor>
  ) => ModalEditor;

  async function startSession(insertEscape: unknown, hasUI = true) {
    const restore = setPiVimSettingsReaderForTests(() => ({ insertEscape }));
    const pi = createExtensionApiHarness();
    const warnings: [string, string][] = [];
    let factory: Factory | undefined;
    vim(pi);
    await pi.emit(
      "session_start",
      {},
      {
        cwd: ".",
        hasUI,
        ui: {
          theme: stubTheme,
          notify: (text: string, level: string) => warnings.push([text, level]),
          setEditorComponent: (next: Factory) => {
            factory = next;
          },
        },
      },
    );
    assert.ok(factory);
    const create = factory;
    return {
      warnings,
      create() {
        const editor = create(stubTui, stubTheme, stubKeybindings);
        editor.setInsertEscapeClock(() => 0);
        return editor;
      },
      async stop() {
        await pi.emit("session_shutdown");
        restore();
      },
    };
  }

  it("is off by default", async () => {
    for (const setting of [undefined, {}, { timeoutMs: 200 }]) {
      const session = await startSession(setting);
      try {
        const editor = session.create();
        sendKeys(editor, ["a", "j", "k"]);
        assert.equal(editor.getText(), "ajk");
        assert.equal(editor.getMode(), "insert");
        assert.deepEqual(session.warnings, []);
      } finally {
        await session.stop();
      }
    }
  });

  it("arms a configured jk sequence", async () => {
    const session = await startSession({ sequence: "jk" });
    try {
      const editor = session.create();
      sendKeys(editor, ["a", "j", "k"]);
      assert.equal(editor.getText(), "a");
      assert.equal(editor.getMode(), "normal");
      assert.deepEqual(session.warnings, []);
    } finally {
      await session.stop();
    }
  });

  it("falls back to defaults for invalid fields and warns once per session", async () => {
    for (const hasUI of [true, false]) {
      const session = await startSession(
        { sequence: "j", timeoutMs: 50 },
        hasUI,
      );
      try {
        for (let i = 0; i < 2; i++) {
          const editor = session.create();
          sendKeys(editor, ["j", "k"]);
          assert.equal(editor.getText(), "jk");
          assert.equal(editor.getMode(), "insert");
        }
        assert.equal(session.warnings.length, hasUI ? 1 : 0);
        if (hasUI) {
          assert.match(session.warnings[0][0], /insertEscape sequence/);
          assert.equal(session.warnings[0][1], "warning");
        }
      } finally {
        await session.stop();
      }
    }
  });
});
