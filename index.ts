/**
 * Modal Editor - vim-like modal editing extension
 *
 * Usage: pi --extension ./index.ts
 *
 * - Escape: insert → normal mode (in normal mode, aborts agent)
 * - i: normal → insert mode (at cursor)
 * - a: insert after cursor
 * - A: insert at end of line
 * - I: insert at start of line
 * - o: open new line below (insert mode)
 * - O: open new line above (insert mode)
 * - hjkl: navigation in normal mode
 * - 0/$: line start/end
 * - x: delete char under cursor
 * - D: delete to end of line
 * - S: substitute line (delete line content + insert mode)
 * - s: substitute char (delete char + insert mode)
 * - d{motion}: delete with motion (dw, db, de, d$, d0, dd, df/dt/dF/dT{char})
 * - f{char}: jump to next {char} on line
 * - F{char}: jump to previous {char} on line
 * - t{char}: jump to just before next {char} on line
 * - T{char}: jump to just after previous {char} on line
 * - ;: repeat last f/F/t/T motion (same direction)
 * - ,: repeat last f/F/t/T motion (reverse direction)
 * - w: move to start of next word
 * - b: move to start of previous word
 * - e: move to end of word
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
  CTRL_UNDERSCORE,
  NEWLINE,
  ESC_DOWN,
} from "./types.js";
import {
  reverseCharMotion,
  findCharMotionTarget,
} from "./motions.js";
import {
  WordBoundaryCache,
  type WordMotionDirection,
  type WordMotionTarget,
} from "./word-boundary-cache.js";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_PASTE_END_TAIL = BRACKETED_PASTE_END.slice(1);

export class ModalEditor extends CustomEditor {
  private mode: Mode = "insert";
  private pendingMotion: PendingMotion = null;
  private pendingTextObject: "i" | "a" | null = null;
  private pendingOperator: PendingOperator = null;
  private pendingCount: string = "";
  private pendingCountKind: "prefix" | "operator" | null = null;
  private pendingG: boolean = false;
  private lastCharMotion: LastCharMotion | null = null;
  private discardingBracketedPasteInNormalMode: boolean = false;
  private pendingEscWhileDiscardingBracketedPasteInNormalMode: boolean = false;
  private readonly wordBoundaryCache = new WordBoundaryCache();

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

  private clearPendingState(): void {
    this.pendingMotion = null;
    this.pendingTextObject = null;
    this.pendingOperator = null;
    this.pendingCount = "";
    this.pendingCountKind = null;
    this.pendingG = false;
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
    if (this.mode !== "insert") {
      if (this.discardingBracketedPasteInNormalMode) {
        if (data === "\x1b") {
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

    if (matchesKey(data, "escape")) {
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
        super.handleInput(CTRL_E);
        super.handleInput(NEWLINE);
        return;
      }
      // Alt+Shift+o: open new line above (stay in insert mode)
      // \x1bO is the legacy sequence for Alt+Shift+O (VT100 SS3 prefix in non-Kitty terminals)
      if (matchesKey(data, Key.shiftAlt("o")) || data === "\x1bO") {
        super.handleInput(CTRL_A);
        super.handleInput(NEWLINE);
        super.handleInput(ESC_UP);
        return;
      }
      return super.handleInput(data);
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
      || this.pendingCount
      || this.pendingG
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

  private takePendingCount(defaultValue: number = 1): number {
    if (!this.pendingCount) return defaultValue;

    const parsed = Number.parseInt(this.pendingCount, 10);
    this.pendingCount = "";
    this.pendingCountKind = null;

    if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
    return parsed;
  }

  private cancelPendingOperator(data: string): void {
    this.pendingOperator = null;
    this.pendingCount = "";
    this.pendingCountKind = null;
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

    const range = this.getWordObjectRange(this.pendingTextObject!);
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
      if (this.pendingCount.length === 0) {
        if (data !== "0") {
          this.pendingCount = data;
          this.pendingCountKind = "operator";
          return;
        }
      } else if (this.pendingCountKind === "operator") {
        this.pendingCount += data;
        return;
      } else {
        // Dual counts like 2d3j are out of scope; fail closed.
        this.cancelPendingOperator(data);
        return;
      }
    }

    if (data === "d") {
      const count = this.takePendingCount(1);
      this.deleteLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      if (this.pendingCountKind === "prefix") {
        this.cancelPendingOperator(data);
        return;
      }

      const count = this.takePendingCount(1);
      this.deleteLinewiseByDelta(data === "j" ? count : -count);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.pendingCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.deleteToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (this.pendingCount.length > 0) {
      // Counted forms beyond dd and d{count}j/k are intentionally out of scope.
      this.cancelPendingOperator(data);
      return;
    }

    if (data === "i" || data === "a") {
      this.pendingTextObject = data;
      return;
    }
    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (this.deleteWithMotion(data)) {
      this.pendingOperator = null;
      return;
    }

    // Invalid motion: cancel operator to avoid sticky surprising deletes.
    this.cancelPendingOperator(data);
  }

  private handlePendingChange(data: string): void {
    if (data === "c") {
      this.cutLine();
      this.pendingOperator = null;
      this.mode = "insert";
      return;
    }
    if (data === "i" || data === "a") {
      this.pendingTextObject = data;
      return;
    }
    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }
    if (this.deleteWithMotion(data)) {
      this.pendingOperator = null;
      this.mode = "insert";
      return;
    }

    // Invalid motion: cancel operator to avoid sticky surprising changes.
    this.cancelPendingOperator(data);
  }

  private handleNormalMode(data: string): void {
    if (this.pendingG) {
      this.pendingG = false;
      if (data === "g") {
        this.moveCursorToBufferStart();
        return;
      }
      // Unsupported g-prefix command: discard prefix and keep processing input.
    }

    if (this.pendingCount.length > 0) {
      if (this.isDigit(data) && this.pendingCountKind === "prefix") {
        this.pendingCount += data;
        return;
      }

      if ((data === "d" || data === "y") && this.pendingCountKind === "prefix") {
        this.pendingOperator = data;
        return;
      }

      // Count prefixes are currently supported for dd/yy only.
      this.pendingCount = "";
      this.pendingCountKind = null;
    } else if (this.isCountStarter(data)) {
      this.pendingCount = data;
      this.pendingCountKind = "prefix";
      return;
    }

    if (data === "g") {
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

    if (data === "u") {
      super.handleInput(CTRL_UNDERSCORE); // ctrl+_ — readline undo
      return;
    }

    if (data === "w") return this.moveWord("forward", "start");
    if (data === "b") return this.moveWord("backward", "start");
    if (data === "e") return this.moveWord("forward", "end");

    if (Object.hasOwn(NORMAL_KEYS, data)) {
      return this.handleMappedKey(data);
    }

    // Pass control sequences (ctrl+c, etc.) to super, ignore printable chars
    if (this.isPrintableChunk(data)) return;
    super.handleInput(data);
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
        super.handleInput(CTRL_E);
        super.handleInput(NEWLINE);
        this.mode = "insert";
        break;
      case "O":
        super.handleInput(CTRL_A);
        super.handleInput(NEWLINE);
        super.handleInput(ESC_UP);
        this.mode = "insert";
        break;
      case "D":
        this.cutToEndOfLine();
        break;
      case "C":
        this.cutToEndOfLine();
        this.mode = "insert";
        break;
      case "S":
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
    const targetCol = findCharMotionTarget(line, col, motion, targetChar, !saveMotion);

    if (targetCol !== null && saveMotion) {
      this.lastCharMotion = { motion, char: targetChar };
    }

    if (targetCol !== null && targetCol !== col) {
      this.moveCursorBy(targetCol - col);
    }
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

  private moveCursorToBufferStart(): void {
    this.moveCursorToLineStart(0);
  }

  private moveCursorToBufferEnd(): void {
    const lines = this.getLines();
    this.moveCursorToLineStart(Math.max(0, lines.length - 1));
  }

  private isWordChar(ch: string): boolean {
    return /\w/.test(ch);
  }

  private charType(ch: string | undefined): "space" | "word" | "other" {
    if (!ch || /\s/.test(ch)) return "space";
    if (this.isWordChar(ch)) return "word";
    return "other";
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
  ): number {
    const len = text.length;
    if (len === 0) return 0;

    let i = Math.max(0, Math.min(abs, len));

    if (direction === "forward") {
      if (i >= len) return len;

      if (target === "start") {
        const startType = this.charType(text[i]);
        if (startType !== "space") {
          while (i < len && this.charType(text[i]) === startType) i++;
        }
        while (i < len && this.charType(text[i]) === "space") i++;
        return i;
      }

      if (i < len - 1) i++;
      while (i < len && this.charType(text[i]) === "space") i++;
      if (i >= len) return len;
      const t = this.charType(text[i]);
      while (i < len - 1 && this.charType(text[i + 1]) === t) i++;
      return i;
    }

    if (i >= len) i = len - 1;
    if (i > 0) i--;
    while (i > 0 && this.charType(text[i]) === "space") i--;
    const t = this.charType(text[i]);
    while (i > 0 && this.charType(text[i - 1]) === t) i--;
    return i;
  }

  private tryFindWordTargetLineLocal(
    direction: WordMotionDirection,
    target: WordMotionTarget,
    allowSameColumn: boolean = false,
  ): number | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";

    if (lineSnapshot.length === 0) return null;
    if (col < 0 || col > lineSnapshot.length) return null;

    if (direction === "forward") {
      if (col >= lineSnapshot.length) return null;
    } else {
      if (col <= 0) return null;
      if (!/\S/.test(lineSnapshot.slice(0, col))) return null;
    }

    const targetCol = this.wordBoundaryCache.tryFindTarget(
      lineSnapshot,
      col,
      direction,
      target,
    );
    if (targetCol === null) return null;

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    if (direction === "forward") {
      if (targetCol >= lineSnapshot.length) return null;
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

  private tryMoveWordLineLocal(
    direction: "forward" | "backward",
    target: "start" | "end",
  ): boolean {
    const col = this.getCursor().col;
    const targetCol = this.tryFindWordTargetLineLocal(direction, target);
    if (targetCol === null || targetCol === col) return false;

    this.moveCursorBy(targetCol - col);
    return true;
  }

  private tryWordMotionLineLocalRange(
    motion: "w" | "e" | "b",
  ): { col: number; targetCol: number; inclusive: boolean } | null {
    const col = this.getCursor().col;
    const direction: WordMotionDirection = motion === "b" ? "backward" : "forward";
    const target: WordMotionTarget = motion === "e" ? "end" : "start";
    const targetCol = this.tryFindWordTargetLineLocal(direction, target, motion === "e");

    if (targetCol === null) return null;

    return {
      col,
      targetCol,
      inclusive: motion === "e",
    };
  }

  private moveWord(direction: "forward" | "backward", target: "start" | "end"): void {
    if (this.tryMoveWordLineLocal(direction, target)) return;

    const text = this.getText();
    const currentAbs = this.getAbsoluteIndexFromCursor();
    const targetAbs = this.findWordTargetInText(text, currentAbs, direction, target);
    if (targetAbs !== currentAbs) {
      this.moveCursorBy(targetAbs - currentAbs);
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

  private isCursorAtOrPastEol(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    return col >= line.length;
  }

  private cutCharUnderCursor(): void {
    const { line, col } = this.getCurrentLineAndCol();
    if (line.length === 0) return; // Don't merge empty lines with x
    if (col >= line.length) return; // Don't delete past end of line

    const deleted = line.slice(col, col + 1);
    this.writeToRegister(deleted);
    super.handleInput(ESC_DELETE);
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

  private deleteWithMotion(motion: string): boolean {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
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

    if (motion === "w" || motion === "e" || motion === "b") {
      const lineLocalRange = this.tryWordMotionLineLocalRange(motion);
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
        motion === "b" ? "backward" : "forward",
        motion === "e" ? "end" : "start",
      );
      this.deleteRangeByAbsolute(currentAbs, targetAbs, motion === "e");
      return true;
    }

    return false;
  }

  private deleteWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const targetCol = findCharMotionTarget(line, col, motion, targetChar);

    if (targetCol === null) return;

    this.lastCharMotion = { motion, char: targetChar };
    this.deleteRange(col, targetCol, true); // char motions are inclusive
  }

  private handlePendingYank(data: string): void {
    if (this.isDigit(data)) {
      if (this.pendingCount.length === 0) {
        if (data !== "0") {
          this.pendingCount = data;
          this.pendingCountKind = "operator";
          return;
        }
      } else if (this.pendingCountKind === "operator") {
        this.pendingCount += data;
        return;
      } else {
        // Dual counts like 2y3k are out of scope; fail closed.
        this.cancelPendingOperator(data);
        return;
      }
    }

    if (data === "y") {
      const count = this.takePendingCount(1);
      this.yankLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      if (this.pendingCountKind === "prefix") {
        this.cancelPendingOperator(data);
        return;
      }

      const count = this.takePendingCount(1);
      this.yankLinewiseByDelta(data === "j" ? count : -count);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.pendingCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.yankToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (this.pendingCount.length > 0) {
      // Counted forms beyond yy and y{count}j/k are intentionally out of scope.
      this.cancelPendingOperator(data);
      return;
    }

    if (data === "i" || data === "a") {
      this.pendingTextObject = data;
      return;
    }
    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
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

    if (motion === "w" || motion === "e" || motion === "b") {
      const lineLocalRange = this.tryWordMotionLineLocalRange(motion);
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
        motion === "b" ? "backward" : "forward",
        motion === "e" ? "end" : "start",
      );
      this.yankRangeByAbsolute(currentAbs, targetAbs, motion === "e");
      return true;
    }

    return false;
  }

  private yankWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const targetCol = findCharMotionTarget(line, col, motion, targetChar);

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

  private getWordObjectRange(kind: "i" | "a"): { startAbs: number; endAbs: number } | null {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";
    if (!line) return null;

    let col = Math.min(cursor.col, Math.max(0, line.length - 1));

    const hasWordChar = (idx: number) => idx >= 0 && idx < line.length && this.isWordChar(line[idx]!);

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

    if (kind === "a") {
      let aroundStart = start;
      let aroundEnd = end;

      while (aroundEnd < line.length && /\s/.test(line[aroundEnd]!)) aroundEnd++;
      if (aroundEnd === end) {
        while (aroundStart > 0 && /\s/.test(line[aroundStart - 1]!)) aroundStart--;
      }

      start = aroundStart;
      end = aroundEnd;
    }

    return {
      startAbs: this.getAbsoluteIndex(cursor.line, start),
      endAbs: this.getAbsoluteIndex(cursor.line, end),
    };
  }

  private putAfter(): void {
    const text = this.unnamedRegister;
    if (!text) return;

    if (text.endsWith("\n")) {
      // Line-wise: insert new line below and fill it
      super.handleInput(CTRL_E);
      super.handleInput(NEWLINE);
      const content = text.slice(0, -1);
      for (const char of content) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    } else {
      // Character-wise: insert after cursor
      if (!this.isCursorAtOrPastEol()) {
        super.handleInput(ESC_RIGHT);
      }
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
  }

  private putBefore(): void {
    const text = this.unnamedRegister;
    if (!text) return;

    if (text.endsWith("\n")) {
      // Line-wise: insert new line above and fill it
      super.handleInput(CTRL_A);
      super.handleInput(NEWLINE);
      super.handleInput(ESC_UP);
      const content = text.slice(0, -1);
      for (const char of content) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    } else {
      // Character-wise: insert before cursor (just type it)
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

    const count = this.pendingCount;

    if (this.pendingOperator && this.pendingMotion) {
      const prefix = this.pendingCountKind === "prefix" ? count : "";
      const opCount = this.pendingCountKind === "operator" ? count : "";
      return ` NORMAL ${prefix}${this.pendingOperator}${opCount}${this.pendingMotion}_ `;
    }
    if (this.pendingOperator) {
      const prefix = this.pendingCountKind === "prefix" ? count : "";
      const opCount = this.pendingCountKind === "operator" ? count : "";
      return ` NORMAL ${prefix}${this.pendingOperator}${opCount}_ `;
    }
    if (this.pendingMotion) return ` NORMAL ${this.pendingMotion}_ `;
    if (this.pendingG) return " NORMAL g_ ";
    if (count) return ` NORMAL ${count}_ `;
    return " NORMAL ";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
  });
}
