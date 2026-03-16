/**
 * Modal Editor - vim-like modal editing extension
 *
 * Usage: pi --extension ./index.ts
 *
 * - Escape / ctrl+[: insert → normal mode (in normal mode, aborts agent)
 * - i: normal → insert mode (at cursor)
 * - a: insert after cursor
 * - A: insert at end of line
 * - I: insert at start of line
 * - o: open new line below (insert mode)
 * - O: open new line above (insert mode)
 * - hjkl: navigation in normal mode
 * - 0/$: line start/end
 * - ^: first non-whitespace char of line
 * - x: delete char under cursor
 * - D: delete to end of line
 * - S: substitute line (delete line content + insert mode)
 * - s: substitute char (delete char + insert mode)
 * - d{motion}: delete with motion (`w/b/e` + `W/B/E`, `$`, `0`, `^`, `dd`, `f/t/F/T{char}`)
 * - c{motion}: change with same motion set as `d` (then enter insert mode)
 * - y{motion}: yank with same motion set as `d` (no text mutation)
 * - f{char}: jump to next {char} on line
 * - F{char}: jump to previous {char} on line
 * - t{char}: jump to just before next {char} on line
 * - T{char}: jump to just after previous {char} on line
 * - ;: repeat last f/F/t/T motion (same direction)
 * - ,: repeat last f/F/t/T motion (reverse direction)
 * - w/b/e: `word` motions (keyword/punctuation aware)
 * - W/B/E: `WORD` motions (whitespace-delimited non-space runs)
 * - {/}: paragraph motions to previous/next paragraph start (line start col 0)
 * - `{count}` prefixes supported for navigation, paragraph motions, and `d/c` word/WORD motions
 * - operator forms with braces (`d{`, `d}`, `c{`, `c}`, `y{`, `y}`) are out of scope
 * - counted yank caveat: `y2w`, `2yw`, `y2W`, `2yW` cancel (linewise counts still supported)
 * - Shift+Alt+A: go to end of line (insert mode shortcut)
 * - Shift+Alt+I: go to start of line (insert mode shortcut)
 * - Alt+o: open new line below (insert mode shortcut)
 * - Alt+Shift+o: open new line above (insert mode shortcut)
 * - u: undo (normal mode, sends ctrl+_ to underlying readline editor)
 * - ctrl+c, ctrl+d, etc. work in both modes
 *
 * Inspired by original repo:
 * - https://github.com/badlogic/pi-mono
 *   (packages/coding-agent/examples/extensions/modal-editor.ts)
 *
 * Additional ideas adapted from:
 * - https://github.com/l-lin/dotfiles
 *   (home-manager/modules/share/ai/pi/.pi/agent/extensions/vim-mode)
 */

import {
  copyToClipboard,
  CustomEditor,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

import type {
  Mode,
  CharMotion,
  PendingMotion,
  PendingOperator,
  LastCharMotion,
} from "./types.js";
import {
  NORMAL_KEYS,
  CHAR_MOTION_KEYS,
  ESC_LEFT,
  ESC_RIGHT,
  ESC_DELETE,
  ESC_UP,
  CTRL_A,
  CTRL_E,
  CTRL_K,
  CTRL_R,
  CTRL_UNDERSCORE,
  NEWLINE,
  ESC_DOWN,
} from "./types.js";
import {
  reverseCharMotion,
  findCharMotionTarget,
  findParagraphMotionTarget,
  findFirstNonWhitespaceColumn,
  type WordMotionClass,
} from "./motions.js";
import {
  WordBoundaryCache,
  type WordMotionDirection,
  type WordMotionTarget,
} from "./word-boundary-cache.js";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_PASTE_END_TAIL = BRACKETED_PASTE_END.slice(1);
const MAX_COUNT = 9999;

type EditorSnapshot = {
  text: string;
  cursor: { line: number; col: number };
};

type ModalEditorInternals = {
  state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
  preferredVisualCol?: number | null;
  lastAction?: string | null;
  historyIndex?: number;
  onChange?: (text: string) => void;
  tui?: { requestRender?: () => void };
  pushUndoSnapshot?: () => void;
  setCursorCol?: (col: number) => void;
};

export class ModalEditor extends CustomEditor {
  private mode: Mode = "insert";
  private pendingMotion: PendingMotion = null;
  private pendingTextObject: "i" | "a" | null = null;
  private pendingOperator: PendingOperator = null;
  private prefixCount: string = "";
  private operatorCount: string = "";
  private pendingG: boolean = false;
  private pendingGCount: string = "";
  private lastCharMotion: LastCharMotion | null = null;
  private discardingBracketedPasteInNormalMode: boolean = false;
  private pendingEscWhileDiscardingBracketedPasteInNormalMode: boolean = false;
  private wordBoundaryCache = new WordBoundaryCache();
  private readonly redoStack: EditorSnapshot[] = [];
  private isApplyingRedo: boolean = false;
  private isApplyingUndo: boolean = false;
  private onChangeHooked: boolean = false;

  // Unnamed register
  private unnamedRegister: string = "";
  private clipboardFn: (text: string) => void = (text: string) => {
    try { copyToClipboard(text); } catch { /* best effort */ }
  };

  // Test seams
  setClipboardFn(fn: (text: string) => void): void { this.clipboardFn = fn; }
  getRegister(): string { return this.unnamedRegister; }
  setRegister(text: string): void { this.unnamedRegister = text; }
  getMode(): Mode { return this.mode; }
  getText(): string { return this.getLines().join("\n"); }

  override setText(text: string): void {
    this.clearRedoStack();
    super.setText(text);
  }

  private captureSnapshot(): EditorSnapshot {
    const cursor = this.getCursor();
    return {
      text: this.getText(),
      cursor: { line: cursor.line, col: cursor.col },
    };
  }

  private requireRedoRestoreState(
    editor: ModalEditorInternals,
  ): { lines: string[]; cursorLine?: number; cursorCol?: number } {
    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) {
      throw new Error("Redo restore prerequisite: editor state unavailable");
    }
    return state;
  }

  private restoreSnapshot(snapshot: EditorSnapshot): void {
    const editor = this as unknown as ModalEditorInternals;
    const state = this.requireRedoRestoreState(editor);

    const lines = snapshot.text.split("\n");
    state.lines = lines.length > 0 ? lines : [""];

    const maxLine = Math.max(0, state.lines.length - 1);
    const cursorLine = Math.max(0, Math.min(snapshot.cursor.line, maxLine));
    const line = state.lines[cursorLine] ?? "";
    const cursorCol = Math.max(0, Math.min(snapshot.cursor.col, line.length));

    state.cursorLine = cursorLine;
    if (typeof editor.setCursorCol === "function") {
      editor.setCursorCol(cursorCol);
    } else {
      state.cursorCol = cursorCol;
      editor.preferredVisualCol = null;
    }

    this.invalidateWordBoundaryCache();

    editor.historyIndex = -1;
    editor.lastAction = null;
    editor.onChange?.(this.getText());
    editor.tui?.requestRender?.();
  }

  private snapshotChanged(a: EditorSnapshot, b: EditorSnapshot): boolean {
    return a.text !== b.text
      || a.cursor.line !== b.cursor.line
      || a.cursor.col !== b.cursor.col;
  }

  private performUndo(): void {
    this.isApplyingUndo = true;
    try {
      const beforeUndo = this.captureSnapshot();
      super.handleInput(CTRL_UNDERSCORE);
      const afterUndo = this.captureSnapshot();

      if (this.snapshotChanged(beforeUndo, afterUndo)) {
        this.redoStack.push(beforeUndo);
      }
    } finally {
      this.isApplyingUndo = false;
    }
  }

  private performRedo(count: number = this.takeTotalCount(1)): void {
    const maxSteps = Math.max(1, Math.min(MAX_COUNT, count));
    const editor = this as unknown as ModalEditorInternals;

    for (let i = 0; i < maxSteps; i++) {
      const snapshot = this.redoStack[this.redoStack.length - 1];
      if (!snapshot) break;

      this.isApplyingRedo = true;
      try {
        this.requireRedoRestoreState(editor);
        editor.pushUndoSnapshot?.();
        this.restoreSnapshot(snapshot);
        this.redoStack.pop();
      } finally {
        this.isApplyingRedo = false;
      }
    }
  }

  private clearRedoStack(): void {
    this.redoStack.length = 0;
  }

  private invalidateWordBoundaryCache(): void {
    this.wordBoundaryCache = new WordBoundaryCache();
  }

  private ensureOnChangeHook(): void {
    if (this.onChangeHooked) return;

    const editor = this as unknown as ModalEditorInternals;
    const originalOnChange = editor.onChange;

    editor.onChange = (text: string) => {
      originalOnChange?.(text);
      this.centralInvalidationCheck();
    };

    this.onChangeHooked = true;
  }

  private centralInvalidationCheck(): void {
    if (this.redoStack.length === 0) return;
    if (this.isApplyingUndo || this.isApplyingRedo) return;
    this.clearRedoStack();
  }

  private trackFreshMutation<T>(action: () => T): T {
    return action();
  }

  private applySyntheticEdit(mutation: () => void): void {
    const editor = this as unknown as ModalEditorInternals;
    if (!editor.state || !Array.isArray(editor.state.lines)) {
      throw new Error(
        "Synthetic edit prerequisite: editor state unavailable",
      );
    }

    if (typeof editor.pushUndoSnapshot !== "function") {
      throw new Error(
        "Synthetic edit prerequisite: pushUndoSnapshot unavailable",
      );
    }

    editor.pushUndoSnapshot();
    mutation();
    editor.onChange?.(this.getText());
    editor.tui?.requestRender?.();
  }

  private clearPendingState(): void {
    this.pendingMotion = null;
    this.pendingTextObject = null;
    this.pendingOperator = null;
    this.prefixCount = "";
    this.operatorCount = "";
    this.pendingG = false;
    this.pendingGCount = "";
  }

  private isEscapeLikeInput(data: string): boolean {
    return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
  }

  private stripBracketedPasteInNormalMode(data: string): { filtered: string | null; stripped: boolean } {
    let chunk = data;
    let stripped = false;

    while (true) {
      if (this.discardingBracketedPasteInNormalMode) {
        stripped = true;
        const end = chunk.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
          return { filtered: null, stripped };
        }
        this.discardingBracketedPasteInNormalMode = false;
        this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
        chunk = chunk.slice(end + BRACKETED_PASTE_END.length);
        if (!chunk) return { filtered: null, stripped };
      }

      const start = chunk.indexOf(BRACKETED_PASTE_START);
      if (start === -1) {
        return { filtered: chunk, stripped };
      }

      stripped = true;
      const end = chunk.indexOf(BRACKETED_PASTE_END, start + BRACKETED_PASTE_START.length);
      if (end === -1) {
        this.discardingBracketedPasteInNormalMode = true;
        const leading = chunk.slice(0, start);
        return { filtered: leading.length > 0 ? leading : null, stripped };
      }

      chunk = chunk.slice(0, start) + chunk.slice(end + BRACKETED_PASTE_END.length);
      if (!chunk) return { filtered: null, stripped };
    }
  }

  handleInput(data: string): void {
    this.ensureOnChangeHook();

    if (this.mode !== "insert") {
      if (this.discardingBracketedPasteInNormalMode) {
        if (this.isEscapeLikeInput(data)) {
          if (this.pendingEscWhileDiscardingBracketedPasteInNormalMode) {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
            this.discardingBracketedPasteInNormalMode = false;
            this.clearPendingState();
            return;
          } else {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = true;
            this.clearPendingState();
            return;
          }
        } else if (this.pendingEscWhileDiscardingBracketedPasteInNormalMode) {
          if (data.startsWith(BRACKETED_PASTE_END_TAIL)) {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
            this.discardingBracketedPasteInNormalMode = false;
            data = data.slice(BRACKETED_PASTE_END_TAIL.length);
            if (data.length === 0) {
              this.clearPendingState();
              return;
            }
          } else {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
          }
        }
      }

      const { filtered, stripped } = this.stripBracketedPasteInNormalMode(data);
      if (stripped) {
        this.clearPendingState();
      }
      if (filtered === null) return;
      data = filtered;
    }

    if (this.isEscapeLikeInput(data)) {
      return this.handleEscape();
    }

    if (this.mode === "insert") {
      // Shift+Alt+A: go to end of line (like Esc -> A but stay in insert)
      if (matchesKey(data, Key.shiftAlt("a")) || data === "\x1bA") {
        return super.handleInput(CTRL_E);
      }
      // Shift+Alt+I: go to start of line (like Esc -> I but stay in insert)
      if (matchesKey(data, Key.shiftAlt("i")) || data === "\x1bI") {
        return super.handleInput(CTRL_A);
      }
      // Alt+o: open new line below (stay in insert mode)
      if (matchesKey(data, Key.alt("o")) || data === "\x1bo") {
        this.openLineBelow();
        return;
      }
      // Alt+Shift+o: open new line above (stay in insert mode)
      // \x1bO is the legacy sequence for Alt+Shift+O (VT100 SS3 prefix in non-Kitty terminals)
      if (matchesKey(data, Key.shiftAlt("o")) || data === "\x1bO") {
        this.openLineAbove();
        return;
      }
      super.handleInput(data);
      return;
    }

    if (this.pendingTextObject) {
      return this.handlePendingTextObject(data);
    }

    if (this.pendingMotion) {
      return this.handlePendingMotion(data);
    }

    if (this.pendingOperator === "d") {
      return this.handlePendingDelete(data);
    }

    if (this.pendingOperator === "c") {
      return this.handlePendingChange(data);
    }

    if (this.pendingOperator === "y") {
      return this.handlePendingYank(data);
    }

    this.handleNormalMode(data);
  }

  private clearUnderlyingPasteStateIfActive(): void {
    const editor = this as unknown as {
      isInPaste?: boolean;
      pasteBuffer?: string;
      pasteCounter?: number;
    };

    if (!editor.isInPaste) return;

    editor.isInPaste = false;
    if (typeof editor.pasteBuffer === "string") {
      editor.pasteBuffer = "";
    }
    if (typeof editor.pasteCounter === "number") {
      editor.pasteCounter = 0;
    }
  }

  private handleEscape(): void {
    if (
      this.pendingMotion
      || this.pendingTextObject
      || this.pendingOperator
      || this.prefixCount
      || this.operatorCount
      || this.pendingG
      || this.pendingGCount
    ) {
      this.clearPendingState();
      return;
    }
    if (this.mode === "insert") {
      this.clearUnderlyingPasteStateIfActive();
      this.mode = "normal";
    } else {
      super.handleInput("\x1b"); // pass escape to abort agent
    }
  }

  private isPrintableChunk(data: string): boolean {
    if (data.length === 0) return false;
    for (const char of data) {
      const codePoint = char.codePointAt(0)!;
      if (codePoint < 32 || codePoint === 127) return false;
    }
    return true;
  }

  private isPrintableInput(data: string): boolean {
    return this.isPrintableChunk(data) && Array.from(data).length === 1;
  }

  private isDigit(data: string): boolean {
    return data.length === 1 && data >= "0" && data <= "9";
  }

  private isCountStarter(data: string): boolean {
    return data.length === 1 && data >= "1" && data <= "9";
  }

  private takeTotalCount(defaultValue: number = 1): number {
    const prefixRaw = this.prefixCount;
    const operatorRaw = this.operatorCount;
    this.prefixCount = "";
    this.operatorCount = "";

    if (!prefixRaw && !operatorRaw) return defaultValue;

    const parse = (raw: string): number | null => {
      if (!raw) return null;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return parsed;
    };

    const prefix = parse(prefixRaw);
    const operator = parse(operatorRaw);

    if (prefix === null && operator === null) return defaultValue;

    const total = prefix !== null && operator !== null
      ? prefix * operator
      : prefix ?? operator ?? defaultValue;

    if (!Number.isFinite(total) || total <= 0) return defaultValue;
    return Math.min(MAX_COUNT, total);
  }

  private cancelPendingOperator(data: string): void {
    this.pendingOperator = null;
    this.prefixCount = "";
    this.operatorCount = "";
    if (!this.isPrintableChunk(data)) {
      super.handleInput(data);
    }
  }

  private handlePendingMotion(data: string): void {
    if (!this.isPrintableInput(data)) {
      this.pendingMotion = null;
      this.cancelPendingOperator(data);
      return;
    }

    if (this.pendingOperator === "d") {
      this.deleteWithCharMotion(this.pendingMotion!, data);
      this.pendingOperator = null;
    } else if (this.pendingOperator === "c") {
      this.deleteWithCharMotion(this.pendingMotion!, data);
      this.pendingOperator = null;
      this.mode = "insert";
    } else if (this.pendingOperator === "y") {
      this.yankWithCharMotion(this.pendingMotion!, data);
      this.pendingOperator = null;
    } else {
      this.executeCharMotion(this.pendingMotion!, data);
    }

    this.pendingMotion = null;
  }

  private handlePendingTextObject(data: string): void {
    if (data !== "w") {
      this.pendingTextObject = null;
      this.cancelPendingOperator(data);
      return;
    }

    const count = this.takeTotalCount(1);
    const range = this.getWordObjectRange(this.pendingTextObject!, count);
    this.pendingTextObject = null;
    if (!range || !this.pendingOperator) {
      this.pendingOperator = null;
      return;
    }

    const { startAbs, endAbs } = range;
    if (this.pendingOperator === "d") {
      this.deleteRangeByAbsolute(startAbs, endAbs);
      this.pendingOperator = null;
      return;
    }

    if (this.pendingOperator === "c") {
      this.deleteRangeByAbsolute(startAbs, endAbs);
      this.pendingOperator = null;
      this.mode = "insert";
      return;
    }

    if (this.pendingOperator === "y") {
      this.yankRangeByAbsolute(startAbs, endAbs);
      this.pendingOperator = null;
      return;
    }

    this.pendingOperator = null;
  }

  private handlePendingDelete(data: string): void {
    if (this.isDigit(data)) {
      if (this.operatorCount.length === 0) {
        if (data !== "0") {
          this.operatorCount = data;
          return;
        }
      } else {
        this.operatorCount += data;
        return;
      }
    }

    if (data === "d") {
      const count = this.takeTotalCount(1);
      this.deleteLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      const hasDualCount = this.prefixCount.length > 0 && this.operatorCount.length > 0;
      const count = this.takeTotalCount(1);
      const delta = hasDualCount ? Math.max(0, count - 1) : count;
      this.deleteLinewiseByDelta(data === "j" ? delta : -delta);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.deleteToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    const hasCount = this.prefixCount.length > 0 || this.operatorCount.length > 0;
    const supportsCountedWordMotion = (
      data === "w"
      || data === "e"
      || data === "b"
      || data === "W"
      || data === "E"
      || data === "B"
    );
    const supportsCountedTextObject = data === "i" || data === "a";

    if (hasCount && !supportsCountedWordMotion && !supportsCountedTextObject) {
      // Counted forms beyond dd, d{count}j/k, d{count}{f/F/t/T}, and
      // d{count}{w/e/b/W/E/B}/{i/a}w are out of scope.
      this.cancelPendingOperator(data);
      return;
    }

    if (supportsCountedTextObject) {
      this.pendingTextObject = data;
      return;
    }

    const motionCount = supportsCountedWordMotion ? this.takeTotalCount(1) : 1;
    if (this.deleteWithMotion(data, motionCount)) {
      this.pendingOperator = null;
      return;
    }

    // Invalid motion: cancel operator to avoid sticky surprising deletes.
    this.cancelPendingOperator(data);
  }

  private handlePendingChange(data: string): void {
    if (this.isDigit(data)) {
      if (this.operatorCount.length === 0) {
        if (data !== "0") {
          this.operatorCount = data;
          return;
        }
      } else {
        this.operatorCount += data;
        return;
      }
    }

    if (data === "c") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.cutLine();
      this.pendingOperator = null;
      this.mode = "insert";
      return;
    }
    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    const hasCount = this.prefixCount.length > 0 || this.operatorCount.length > 0;
    const supportsCountedWordMotion = (
      data === "w"
      || data === "e"
      || data === "b"
      || data === "W"
      || data === "E"
      || data === "B"
    );
    const supportsCountedTextObject = data === "i" || data === "a";

    if (hasCount && !supportsCountedWordMotion && !supportsCountedTextObject) {
      this.cancelPendingOperator(data);
      return;
    }

    if (supportsCountedTextObject) {
      this.pendingTextObject = data;
      return;
    }

    const motionCount = supportsCountedWordMotion ? this.takeTotalCount(1) : 1;
    const effectiveMotion = data === "W" && this.isCursorOnNonWhitespace()
      ? "E"
      : data;
    if (this.deleteWithMotion(effectiveMotion, motionCount)) {
      this.pendingOperator = null;
      this.mode = "insert";
      return;
    }

    // Invalid motion: cancel operator to avoid sticky surprising changes.
    this.cancelPendingOperator(data);
  }

  private handleNormalMode(data: string): void {
    if (this.pendingG) {
      if (this.isDigit(data)) {
        this.pendingGCount += data;
        return;
      }

      this.pendingG = false;
      const hadGCount = this.pendingGCount.length > 0;
      this.pendingGCount = "";

      if (!hadGCount) {
        if (data === "g") {
          const count = this.takeTotalCount(1);
          this.moveCursorToLineStart(count - 1);
          return;
        }

        if (data === "J") {
          this.joinLines(false);
          return;
        }
      }

      this.clearPendingState();
      return;
    }

    if (this.prefixCount.length > 0) {
      if (this.isDigit(data)) {
        this.prefixCount += data;
        return;
      }

      if (data === "d" || data === "y") {
        this.pendingOperator = data;
        return;
      }

      if (data === "c") {
        this.pendingOperator = "c";
        return;
      }

      if (data === "g") {
        this.pendingGCount = "";
        this.pendingG = true;
        return;
      }

      if (data === "G") {
        const count = this.takeTotalCount(1);
        this.moveCursorToLineStart(count - 1);
        return;
      }

      const supportsCountedStandaloneEdit = (
        data === "x"
        || data === "s"
        || data === "S"
        || data === "D"
        || data === "C"
        || data === "p"
        || data === "P"
        || data === "J"
        || data === CTRL_R
      );
      const supportsCountedCharMotion = (
        CHAR_MOTION_KEYS.has(data)
        || data === ";"
        || data === ","
      );
      const supportsCountedWordMotion = (
        data === "w"
        || data === "e"
        || data === "b"
        || data === "W"
        || data === "E"
        || data === "B"
      );
      const supportsCountedParagraphMotion = data === "{" || data === "}";
      const supportsCountedNav = (
        data === "h"
        || data === "j"
        || data === "k"
        || data === "l"
      );

      if (supportsCountedNav) {
        const count = this.takeTotalCount(1);
        const clamped = Math.min(count, MAX_COUNT);
        if (data === "h") {
          this.moveCursorBy(-clamped);
        } else if (data === "l") {
          this.moveCursorBy(clamped);
        } else {
          // j/k: clamp vertical nav to buffer size to prevent TUI stalls
          const lines = this.getLines();
          const cursorLine = this.getCursor().line;
          const safeCount = data === "j"
            ? Math.min(clamped, lines.length - 1 - cursorLine)
            : Math.min(clamped, cursorLine);
          const seq = data === "j" ? ESC_DOWN : ESC_UP;
          for (let i = 0; i < safeCount; i++) {
            super.handleInput(seq);
          }
        }
        return;
      }

      if (supportsCountedParagraphMotion) {
        this.executeParagraphMotion(data === "}" ? "forward" : "backward");
        return;
      }

      if (
        !supportsCountedStandaloneEdit
        && !supportsCountedCharMotion
        && !supportsCountedWordMotion
        && !supportsCountedParagraphMotion
      ) {
        // Unsupported prefixed forms: drop count and keep processing this key.
        this.prefixCount = "";
        this.operatorCount = "";
      }
    } else if (this.isCountStarter(data)) {
      this.prefixCount = data;
      return;
    }

    if (data === "J") {
      this.joinLines(true);
      return;
    }

    if (data === "g") {
      this.pendingGCount = "";
      this.pendingG = true;
      return;
    }

    if (data === "G") {
      this.moveCursorToBufferEnd();
      return;
    }

    if (data === "d") {
      this.pendingOperator = "d";
      return;
    }

    if (data === "c") {
      this.pendingOperator = "c";
      return;
    }

    if (data === "y") {
      this.pendingOperator = "y";
      return;
    }

    if (data === "p") {
      this.putAfter();
      return;
    }

    if (data === "P") {
      this.putBefore();
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (data === ";" && this.lastCharMotion) {
      this.executeCharMotion(this.lastCharMotion.motion, this.lastCharMotion.char, false);
      return;
    }
    if (data === "," && this.lastCharMotion) {
      this.executeCharMotion(
        reverseCharMotion(this.lastCharMotion.motion),
        this.lastCharMotion.char,
        false,
      );
      return;
    }

    if (data === "u" || data === CTRL_UNDERSCORE) {
      this.performUndo();
      return;
    }

    if (data === CTRL_R) {
      this.performRedo();
      return;
    }

    if (data === "}" || data === "{") {
      this.executeParagraphMotion(data === "}" ? "forward" : "backward");
      return;
    }

    if (data === "^") {
      this.moveCursorToFirstNonWhitespace();
      return;
    }

    if (data === "w") {
      const count = this.takeTotalCount(1);
      return this.moveWord("forward", "start", count, "word");
    }
    if (data === "b") return this.moveWord("backward", "start", this.takeTotalCount(1), "word");
    if (data === "e") return this.moveWord("forward", "end", this.takeTotalCount(1), "word");
    if (data === "W") return this.moveWord("forward", "start", this.takeTotalCount(1), "WORD");
    if (data === "B") return this.moveWord("backward", "start", this.takeTotalCount(1), "WORD");
    if (data === "E") return this.moveWord("forward", "end", this.takeTotalCount(1), "WORD");

    if (Object.hasOwn(NORMAL_KEYS, data)) {
      return this.handleMappedKey(data);
    }

    // Pass control sequences (ctrl+c, etc.) to super, ignore printable chars
    if (this.isPrintableChunk(data)) return;
    super.handleInput(data);
  }

  private openLineBelow(): void {
    super.handleInput(CTRL_E);
    super.handleInput(NEWLINE);
  }

  private openLineAbove(): void {
    super.handleInput(CTRL_A);
    super.handleInput(NEWLINE);
    super.handleInput(ESC_UP);
  }

  private handleMappedKey(key: string): void {
    const seq = NORMAL_KEYS[key];
    switch (key) {
      case "i":
        this.mode = "insert";
        break;
      case "a":
        this.mode = "insert";
        if (!this.isCursorAtOrPastEol()) {
          super.handleInput(ESC_RIGHT);
        }
        break;
      case "A":
        this.mode = "insert";
        super.handleInput(CTRL_E);
        break;
      case "I":
        this.mode = "insert";
        super.handleInput(CTRL_A);
        break;
      case "o":
        this.openLineBelow();
        this.mode = "insert";
        break;
      case "O":
        this.openLineAbove();
        this.mode = "insert";
        break;
      case "D":
        this.takeTotalCount(1);
        this.cutToEndOfLine();
        break;
      case "C":
        this.takeTotalCount(1);
        this.cutToEndOfLine();
        this.mode = "insert";
        break;
      case "S":
        this.takeTotalCount(1);
        this.cutCurrentLineContent();
        this.mode = "insert";
        break;
      case "s":
        this.cutCharUnderCursor();
        this.mode = "insert";
        break;
      case "x":
        this.cutCharUnderCursor();
        break;
      default:
        if (seq) super.handleInput(seq);
    }
  }

  private executeCharMotion(motion: CharMotion, targetChar: string, saveMotion: boolean = true): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(line, col, motion, targetChar, !saveMotion, count);

    if (targetCol !== null && saveMotion) {
      this.lastCharMotion = { motion, char: targetChar };
    }

    if (targetCol !== null && targetCol !== col) {
      this.moveCursorBy(targetCol - col);
    }
  }

  private executeParagraphMotion(direction: "forward" | "backward"): void {
    const lines = this.getLines();
    const fromLine = this.getCursor().line;
    const count = this.takeTotalCount(1);
    const targetLine = findParagraphMotionTarget(lines, fromLine, direction, count);
    this.moveCursorToLineStart(targetLine);
  }

  private tryMoveCursorByState(delta: number): boolean {
    if (delta === 0) return true;

    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) return false;
    if (!Number.isInteger(state.cursorLine) || !Number.isInteger(state.cursorCol)) return false;

    const cursorLine = state.cursorLine as number;
    const cursorCol = state.cursorCol as number;
    const line = state.lines[cursorLine] ?? "";
    const target = cursorCol + delta;

    // Only short-circuit line-local movement; preserve canonical key replay for
    // any potential cross-line traversal semantics.
    if (target < 0 || target > line.length) return false;

    state.cursorCol = target;
    editor.preferredVisualCol = target;
    editor.tui?.requestRender?.();
    return true;
  }

  private moveCursorBy(delta: number): void {
    if (delta === 0) return;

    if (this.tryMoveCursorByState(delta)) return;

    const seq = delta > 0 ? ESC_RIGHT : ESC_LEFT;
    for (let i = 0; i < Math.abs(delta); i++) {
      super.handleInput(seq);
    }
  }

  private moveCursorToLineStart(lineIndex: number): void {
    const lines = this.getLines();
    if (lines.length === 0) {
      super.handleInput(CTRL_A);
      return;
    }

    const targetLine = Math.max(0, Math.min(lineIndex, lines.length - 1));
    const currentLine = this.getCursor().line;
    const delta = targetLine - currentLine;

    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        super.handleInput(ESC_DOWN);
      }
    } else if (delta < 0) {
      for (let i = 0; i < Math.abs(delta); i++) {
        super.handleInput(ESC_UP);
      }
    }

    super.handleInput(CTRL_A);
  }

  private moveCursorToFirstNonWhitespace(): void {
    const { line, col } = this.getCurrentLineAndCol();
    const targetCol = findFirstNonWhitespaceColumn(line);
    this.moveCursorBy(targetCol - col);
  }

  private moveCursorToBufferStart(): void {
    this.moveCursorToLineStart(0);
  }

  private moveCursorToBufferEnd(): void {
    const lines = this.getLines();
    this.moveCursorToLineStart(Math.max(0, lines.length - 1));
  }

  private joinLines(normalize: boolean): void {
    const count = this.takeTotalCount(2);
    const steps = Math.max(0, count - 1);
    if (steps === 0) return;

    this.applySyntheticEdit(() => {
      const editor = this as unknown as ModalEditorInternals;
      const state = editor.state;
      if (!state || !Array.isArray(state.lines)) return;

      const currentLine = state.cursorLine ?? 0;
      let joinPoint = state.cursorCol ?? 0;

      for (let i = 0; i < steps; i++) {
        if (currentLine >= state.lines.length - 1) break;

        const left = state.lines[currentLine]!;
        const right = state.lines[currentLine + 1]!;
        let joined: string;

        if (normalize) {
          const trimmedRight = right.trimStart();
          const leftEndsWithSpace = left.length > 0 && /\s/.test(left[left.length - 1]!);
          const needsSeparator = !leftEndsWithSpace && trimmedRight.length > 0;
          joined = needsSeparator ? `${left} ${trimmedRight}` : left + trimmedRight;
          joinPoint = left.length;
        } else {
          joined = left + right;
          joinPoint = left.length;
        }

        state.lines.splice(currentLine, 2, joined);
      }

      state.cursorLine = currentLine;
      state.cursorCol = joinPoint;
      editor.preferredVisualCol = joinPoint;
    });
  }

  private isWordChar(ch: string): boolean {
    return /\w/.test(ch);
  }

  private charType(
    ch: string | undefined,
    semanticClass: WordMotionClass = "word",
  ): "space" | "word" | "other" {
    if (!ch || /\s/.test(ch)) return "space";
    if (semanticClass === "WORD") return "word";
    if (this.isWordChar(ch)) return "word";
    return "other";
  }

  private resolveWordMotion(
    motion: string,
  ): { motion: "w" | "e" | "b"; semanticClass: WordMotionClass } | null {
    if (motion === "w" || motion === "e" || motion === "b") {
      return { motion, semanticClass: "word" };
    }

    if (motion === "W" || motion === "E" || motion === "B") {
      const normalizedMotion = motion.toLowerCase() as "w" | "e" | "b";
      return { motion: normalizedMotion, semanticClass: "WORD" };
    }

    return null;
  }

  private getAbsoluteIndex(line: number, col: number): number {
    const lines = this.getLines();
    let idx = 0;
    for (let i = 0; i < line; i++) {
      idx += (lines[i] ?? "").length + 1;
    }
    return idx + col;
  }

  private getAbsoluteIndexFromCursor(): number {
    const cursor = this.getCursor();
    return this.getAbsoluteIndex(cursor.line, cursor.col);
  }

  private findWordTargetInText(
    text: string,
    abs: number,
    direction: "forward" | "backward",
    target: "start" | "end",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): number {
    const len = text.length;
    if (len === 0) return 0;

    const steps = Math.max(1, Math.min(MAX_COUNT, count));
    let i = Math.max(0, Math.min(abs, len));

    for (let step = 0; step < steps; step++) {
      let next = i;

      if (direction === "forward") {
        if (next >= len) {
          next = len;
        } else if (target === "start") {
          const startType = this.charType(text[next], semanticClass);
          if (startType !== "space") {
            while (next < len && this.charType(text[next], semanticClass) === startType) next++;
          }
          while (next < len && this.charType(text[next], semanticClass) === "space") next++;
        } else {
          if (next < len - 1) next++;
          while (next < len && this.charType(text[next], semanticClass) === "space") next++;
          if (next >= len) {
            next = len;
          } else {
            const t = this.charType(text[next], semanticClass);
            while (next < len - 1 && this.charType(text[next + 1], semanticClass) === t) next++;
          }
        }
      } else {
        if (next >= len) next = len - 1;
        if (next > 0) next--;
        while (next > 0 && this.charType(text[next], semanticClass) === "space") next--;
        const t = this.charType(text[next], semanticClass);
        while (next > 0 && this.charType(text[next - 1], semanticClass) === t) next--;
      }

      if (next === i) break;
      i = next;
    }

    return i;
  }

  private tryFindWordTargetInLine(
    line: string,
    col: number,
    direction: WordMotionDirection,
    target: WordMotionTarget,
    allowSameColumn: boolean = false,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    if (line.length === 0) return null;
    if (col < 0 || col > line.length) return null;

    if (direction === "forward") {
      if (col >= line.length) return null;
    } else {
      if (col <= 0) return null;
      if (!/\S/.test(line.slice(0, col))) return null;
    }

    const targetCol = this.wordBoundaryCache.tryFindTarget(
      line,
      col,
      direction,
      target,
      semanticClass,
    );
    if (targetCol === null) return null;

    if (direction === "forward") {
      if (targetCol >= line.length) return null;
      if (allowSameColumn) {
        if (targetCol < col) return null;
      } else if (targetCol <= col) {
        return null;
      }
      return targetCol;
    }

    if (allowSameColumn) {
      if (targetCol > col) return null;
    } else if (targetCol >= col) {
      return null;
    }

    return targetCol;
  }

  private tryFindWordTargetLineLocal(
    direction: WordMotionDirection,
    target: WordMotionTarget,
    allowSameColumn: boolean = false,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";

    const targetCol = this.tryFindWordTargetInLine(
      lineSnapshot,
      col,
      direction,
      target,
      allowSameColumn,
      semanticClass,
    );
    if (targetCol === null) return null;

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    return targetCol;
  }

  private tryMoveWordLineLocal(
    direction: "forward" | "backward",
    target: "start" | "end",
    semanticClass: WordMotionClass = "word",
  ): boolean {
    const col = this.getCursor().col;
    const targetCol = this.tryFindWordTargetLineLocal(direction, target, false, semanticClass);
    if (targetCol === null || targetCol === col) return false;

    this.moveCursorBy(targetCol - col);
    return true;
  }

  private tryWordMotionLineLocalRange(
    motion: "w" | "e" | "b",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): { col: number; targetCol: number; inclusive: boolean } | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";
    const direction: WordMotionDirection = motion === "b" ? "backward" : "forward";
    const target: WordMotionTarget = motion === "e" ? "end" : "start";
    const steps = Math.max(1, Math.min(MAX_COUNT, count));

    let currentCol = col;
    for (let step = 0; step < steps; step++) {
      const nextCol = this.tryFindWordTargetInLine(
        lineSnapshot,
        currentCol,
        direction,
        target,
        motion === "e",
        semanticClass,
      );
      if (nextCol === null) return null;
      if (nextCol === currentCol && step < steps - 1) return null;
      currentCol = nextCol;
    }

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    return {
      col,
      targetCol: currentCol,
      inclusive: motion === "e",
    };
  }

  private moveWord(
    direction: "forward" | "backward",
    target: "start" | "end",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): void {
    let remaining = Math.max(1, Math.min(MAX_COUNT, count));

    while (remaining > 0) {
      if (this.tryMoveWordLineLocal(direction, target, semanticClass)) {
        remaining--;
        continue;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        direction,
        target,
        remaining,
        semanticClass,
      );
      if (targetAbs !== currentAbs) {
        this.moveCursorBy(targetAbs - currentAbs);
      }
      return;
    }
  }

  private writeToRegister(text: string): void {
    this.unnamedRegister = text;
    if (!text) return;
    this.clipboardFn(text);
  }

  private getCurrentLineAndCol(): { line: string; col: number } {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    return { line, col };
  }

  private isCursorOnNonWhitespace(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    const ch = line[col];
    return ch !== undefined && !/\s/.test(ch);
  }

  private isCursorAtOrPastEol(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    return col >= line.length;
  }

  private cutCharUnderCursor(): void {
    const count = this.takeTotalCount(1);
    const { line, col } = this.getCurrentLineAndCol();
    if (line.length === 0) return; // Don't merge empty lines with x
    if (col >= line.length) return; // Don't delete past end of line

    const boundedCount = Math.max(1, Math.min(MAX_COUNT, count));
    this.deleteRange(col, col + boundedCount, false);
  }

  private cutToEndOfLine(): void {
    const lines = this.getLines();
    const cursorLine = this.getCursor().line;
    const { line, col } = this.getCurrentLineAndCol();

    const hasNextLine = cursorLine < lines.length - 1;
    const deleted = col < line.length ? line.slice(col) : hasNextLine ? "\n" : "";

    this.writeToRegister(deleted);
    super.handleInput(CTRL_K);
  }

  private cutCurrentLineContent(): void {
    const lines = this.getLines();
    const cursorLine = this.getCursor().line;
    const { line } = this.getCurrentLineAndCol();

    const hasNextLine = cursorLine < lines.length - 1;
    const deleted = line.length > 0 ? line : hasNextLine ? "\n" : "";

    this.writeToRegister(deleted);
    super.handleInput(CTRL_A);
    super.handleInput(CTRL_K);
  }

  private cutLine(): void {
    this.cutCurrentLineContent();
  }

  private getNormalizedLineRange(startLine: number, endLine: number): { start: number; end: number } {
    const lines = this.getLines();
    const last = Math.max(0, lines.length - 1);
    const clampedStart = Math.max(0, Math.min(startLine, last));
    const clampedEnd = Math.max(0, Math.min(endLine, last));
    return {
      start: Math.min(clampedStart, clampedEnd),
      end: Math.max(clampedStart, clampedEnd),
    };
  }

  private getLinewisePayload(startLine: number, endLine: number): string {
    const lines = this.getLines();
    const { start, end } = this.getNormalizedLineRange(startLine, endLine);
    return `${lines.slice(start, end + 1).join("\n")}\n`;
  }

  private getLineDeleteAbsoluteRange(startLine: number, endLine: number): { startAbs: number; endAbs: number } {
    const lines = this.getLines();
    const text = this.getText();
    const { start, end } = this.getNormalizedLineRange(startLine, endLine);
    const lastLine = Math.max(0, lines.length - 1);

    let startAbs = this.getAbsoluteIndex(start, 0);
    let endAbs: number;

    if (end < lastLine) {
      const endLineText = lines[end] ?? "";
      endAbs = this.getAbsoluteIndex(end, endLineText.length) + 1;
    } else {
      endAbs = text.length;
      if (start > 0) {
        startAbs = Math.max(0, startAbs - 1);
      }
    }

    return { startAbs, endAbs };
  }

  private deleteLineRange(startLine: number, endLine: number): void {
    const lines = this.getLines();
    if (lines.length === 0) return;

    const payload = this.getLinewisePayload(startLine, endLine);
    const { startAbs, endAbs } = this.getLineDeleteAbsoluteRange(startLine, endLine);

    this.writeToRegister(payload);

    if (endAbs > startAbs) {
      const cursor = this.getCursor();
      const cursorAbs = this.getAbsoluteIndex(cursor.line, cursor.col);
      if (cursorAbs !== startAbs) {
        this.moveCursorBy(startAbs - cursorAbs);
      }

      const count = endAbs - startAbs;
      for (let i = 0; i < count; i++) {
        super.handleInput(ESC_DELETE);
      }
    }

    super.handleInput(CTRL_A);
  }

  private yankLineRange(startLine: number, endLine: number): void {
    if (this.getLines().length === 0) return;
    this.writeToRegister(this.getLinewisePayload(startLine, endLine));
  }

  private deleteLinewiseByDelta(delta: number): void {
    const currentLine = this.getCursor().line;
    this.deleteLineRange(currentLine, currentLine + delta);
  }

  private yankLinewiseByDelta(delta: number): void {
    const currentLine = this.getCursor().line;
    this.yankLineRange(currentLine, currentLine + delta);
  }

  private deleteToBufferEndLinewise(): void {
    this.deleteLineRange(this.getCursor().line, this.getLines().length - 1);
  }

  private yankToBufferEndLinewise(): void {
    this.yankLineRange(this.getCursor().line, this.getLines().length - 1);
  }

  private deleteWithMotion(motion: string, count: number = 1): boolean {
    const cursor = this.getCursor();
    const col = cursor.col;

    if (motion === "$") {
      // Match D/C behavior exactly, including newline kill at EOL.
      this.cutToEndOfLine();
      return true;
    }

    if (motion === "0") {
      this.deleteRange(col, 0, false);
      return true;
    }

    if (motion === "^") {
      this.deleteRange(col, findFirstNonWhitespaceColumn(this.getLines()[cursor.line] ?? ""), false);
      return true;
    }

    const wordMotion = this.resolveWordMotion(motion);
    if (wordMotion) {
      const lineLocalRange = this.tryWordMotionLineLocalRange(
        wordMotion.motion,
        count,
        wordMotion.semanticClass,
      );
      if (lineLocalRange) {
        this.deleteRange(
          lineLocalRange.col,
          lineLocalRange.targetCol,
          lineLocalRange.inclusive,
        );
        return true;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndex(cursor.line, col);
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        wordMotion.motion === "b" ? "backward" : "forward",
        wordMotion.motion === "e" ? "end" : "start",
        count,
        wordMotion.semanticClass,
      );
      this.deleteRangeByAbsolute(currentAbs, targetAbs, wordMotion.motion === "e");
      return true;
    }

    return false;
  }

  private deleteWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(line, col, motion, targetChar, false, count);

    if (targetCol === null) return;

    this.lastCharMotion = { motion, char: targetChar };
    this.deleteRange(col, targetCol, true); // char motions are inclusive
  }

  private handlePendingYank(data: string): void {
    if (this.isDigit(data)) {
      if (this.operatorCount.length === 0) {
        if (data !== "0") {
          this.operatorCount = data;
          return;
        }
      } else {
        this.operatorCount += data;
        return;
      }
    }

    if (data === "y") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      const hasDualCount = this.prefixCount.length > 0 && this.operatorCount.length > 0;
      const count = this.takeTotalCount(1);
      const delta = hasDualCount ? Math.max(0, count - 1) : count;
      this.yankLinewiseByDelta(data === "j" ? delta : -delta);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.yankToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
      // Counted forms beyond yy, y{count}j/k, and y{count}{f/F/t/T} are out of scope.
      this.cancelPendingOperator(data);
      return;
    }

    if (data === "i" || data === "a") {
      this.pendingTextObject = data;
      return;
    }

    if (this.yankWithMotion(data)) {
      this.pendingOperator = null;
    } else {
      this.cancelPendingOperator(data); // cancel on unrecognised motion
    }
  }

  private yankWithMotion(motion: string): boolean {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const col = cursor.col;

    if (motion === "$") {
      this.yankRange(col, line.length, false);
      return true;
    }

    if (motion === "0") {
      this.yankRange(col, 0, false);
      return true;
    }

    if (motion === "^") {
      this.yankRange(col, findFirstNonWhitespaceColumn(line), false);
      return true;
    }

    const wordMotion = this.resolveWordMotion(motion);
    if (wordMotion) {
      const lineLocalRange = this.tryWordMotionLineLocalRange(
        wordMotion.motion,
        1,
        wordMotion.semanticClass,
      );
      if (lineLocalRange) {
        this.yankRange(
          lineLocalRange.col,
          lineLocalRange.targetCol,
          lineLocalRange.inclusive,
        );
        return true;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndex(cursor.line, col);
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        wordMotion.motion === "b" ? "backward" : "forward",
        wordMotion.motion === "e" ? "end" : "start",
        1,
        wordMotion.semanticClass,
      );
      this.yankRangeByAbsolute(currentAbs, targetAbs, wordMotion.motion === "e");
      return true;
    }

    return false;
  }

  private yankWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(line, col, motion, targetChar, false, count);

    if (targetCol === null) return;

    this.lastCharMotion = { motion, char: targetChar };
    this.yankRange(col, targetCol, true); // char motions are inclusive
  }

  private yankRange(col: number, targetCol: number, inclusive: boolean): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const start = Math.min(col, targetCol);
    const rawEnd = Math.max(col, targetCol) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, line.length);

    if (end <= start) return;

    // Yank only — no cursor movement, no text mutation
    this.writeToRegister(line.slice(start, end));
  }

  private yankRangeByAbsolute(currentAbs: number, targetAbs: number, inclusive: boolean): void {
    const text = this.getText();
    const start = Math.min(currentAbs, targetAbs);
    const rawEnd = Math.max(currentAbs, targetAbs) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, text.length);
    if (end <= start) return;
    this.writeToRegister(text.slice(start, end));
  }

  private deleteRangeByAbsolute(currentAbs: number, targetAbs: number, inclusive: boolean = false): void {
    const text = this.getText();
    const start = Math.min(currentAbs, targetAbs);
    const rawEnd = Math.max(currentAbs, targetAbs) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, text.length);

    if (end <= start) return;

    this.writeToRegister(text.slice(start, end));

    const cursor = this.getCursor();
    const cursorAbs = this.getAbsoluteIndex(cursor.line, cursor.col);
    if (cursorAbs !== start) {
      this.moveCursorBy(start - cursorAbs);
    }

    const count = end - start;
    for (let i = 0; i < count; i++) {
      super.handleInput(ESC_DELETE);
    }
  }

  private getWordObjectRange(
    kind: "i" | "a",
    count: number = 1,
  ): { startAbs: number; endAbs: number } | null {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";
    if (!line) return null;

    const steps = Math.max(1, Math.min(MAX_COUNT, count));
    const hasWordChar = (idx: number) => idx >= 0 && idx < line.length && this.isWordChar(line[idx]!);

    let col = Math.min(cursor.col, Math.max(0, line.length - 1));

    if (!hasWordChar(col)) {
      let right = col;
      while (right < line.length && !hasWordChar(right)) right++;
      if (right < line.length) {
        col = right;
      } else {
        let left = Math.min(col, line.length - 1);
        while (left >= 0 && !hasWordChar(left)) left--;
        if (left < 0) return null;
        col = left;
      }
    }

    let start = col;
    while (start > 0 && hasWordChar(start - 1)) start--;

    let end = col + 1;
    while (end < line.length && hasWordChar(end)) end++;

    let remaining = steps - 1;
    while (remaining > 0) {
      let nextWordStart = end;
      while (nextWordStart < line.length && !hasWordChar(nextWordStart)) nextWordStart++;
      if (nextWordStart >= line.length) break;

      let nextWordEnd = nextWordStart + 1;
      while (nextWordEnd < line.length && hasWordChar(nextWordEnd)) nextWordEnd++;

      end = nextWordEnd;
      remaining--;
    }

    if (kind === "a") {
      let aroundEnd = end;
      while (aroundEnd < line.length && /\s/.test(line[aroundEnd]!)) aroundEnd++;

      if (aroundEnd > end) {
        end = aroundEnd;
      } else {
        while (start > 0 && /\s/.test(line[start - 1]!)) start--;
      }
    }

    return {
      startAbs: this.getAbsoluteIndex(cursor.line, start),
      endAbs: this.getAbsoluteIndex(cursor.line, end),
    };
  }

  private static readonly PUT_SIZE_LIMIT = 512 * 1024; // 512 KB safety cap

  private putAfter(): void {
    const count = this.takeTotalCount(1);
    const text = this.unnamedRegister;
    if (!text) return;
    const safeCount = Math.min(count, Math.max(1, Math.floor(ModalEditor.PUT_SIZE_LIMIT / text.length)));

    if (text.endsWith("\n")) {
      const content = text.slice(0, -1);
      for (let i = 0; i < safeCount; i++) {
        // Line-wise: insert new line below and fill it
        super.handleInput(CTRL_E);
        super.handleInput(NEWLINE);
        for (const char of content) {
          super.handleInput(char === "\n" ? NEWLINE : char);
        }
      }
      return;
    }

    // Character-wise: insert after cursor
    if (!this.isCursorAtOrPastEol()) {
      super.handleInput(ESC_RIGHT);
    }
    for (let i = 0; i < safeCount; i++) {
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
  }

  private putBefore(): void {
    const count = this.takeTotalCount(1);
    const text = this.unnamedRegister;
    if (!text) return;
    const safeCount = Math.min(count, Math.max(1, Math.floor(ModalEditor.PUT_SIZE_LIMIT / text.length)));

    if (text.endsWith("\n")) {
      const content = text.slice(0, -1);
      for (let i = 0; i < safeCount; i++) {
        // Line-wise: insert new line above and fill it
        super.handleInput(CTRL_A);
        super.handleInput(NEWLINE);
        super.handleInput(ESC_UP);
        for (const char of content) {
          super.handleInput(char === "\n" ? NEWLINE : char);
        }
      }
      return;
    }

    // Character-wise: insert before cursor (just type it)
    for (let i = 0; i < safeCount; i++) {
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
  }

  private deleteRange(col: number, targetCol: number, inclusive: boolean): void {
    const line = this.getLines()[this.getCursor().line] ?? "";

    const start = Math.min(col, targetCol);
    const rawEnd = Math.max(col, targetCol) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, line.length);

    if (end <= start) return;

    this.writeToRegister(line.slice(start, end));

    if (start !== col) {
      this.moveCursorBy(start - col);
    }

    const count = end - start;
    for (let i = 0; i < count; i++) {
      super.handleInput(ESC_DELETE);
    }
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    const label = this.getModeLabel();
    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) >= label.length) {
      lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
    }
    return lines;
  }

  private getModeLabel(): string {
    if (this.mode === "insert") return " INSERT ";

    const prefixCount = this.prefixCount;
    const operatorCount = this.operatorCount;

    if (this.pendingOperator && this.pendingMotion) {
      return ` NORMAL ${prefixCount}${this.pendingOperator}${operatorCount}${this.pendingMotion}_ `;
    }
    if (this.pendingOperator) {
      return ` NORMAL ${prefixCount}${this.pendingOperator}${operatorCount}_ `;
    }
    if (this.pendingMotion) return ` NORMAL ${this.pendingMotion}_ `;
    if (this.pendingG) {
      return this.pendingGCount
        ? ` NORMAL g${this.pendingGCount}_ `
        : " NORMAL g_ ";
    }

    const count = `${prefixCount}${operatorCount}`;
    if (count) return ` NORMAL ${count}_ `;
    return " NORMAL ";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
  });
}
