/**
 * Modal Editor - vim-like modal editing example
 *
 * Usage: pi --extension ./examples/extensions/modal-editor.ts
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
} from "./types.js";
import {
  reverseCharMotion,
  findCharMotionTarget,
} from "./motions.js";

export class ModalEditor extends CustomEditor {
  private mode: Mode = "insert";
  private pendingMotion: PendingMotion = null;
  private pendingTextObject: "i" | "a" | null = null;
  private pendingOperator: PendingOperator = null;
  private lastCharMotion: LastCharMotion | null = null;

  // Unnamed register (task 3)
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

  handleInput(data: string): void {
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

  private handleEscape(): void {
    if (this.pendingMotion || this.pendingTextObject || this.pendingOperator) {
      this.pendingMotion = null;
      this.pendingTextObject = null;
      this.pendingOperator = null;
      return;
    }
    if (this.mode === "insert") {
      this.mode = "normal";
    } else {
      super.handleInput("\x1b"); // pass escape to abort agent
    }
  }

  private handlePendingMotion(data: string): void {
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
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
    }
    this.pendingMotion = null;
  }

  private handlePendingTextObject(data: string): void {
    if (data !== "w") {
      this.pendingTextObject = null;
      this.pendingOperator = null;
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
    if (data === "d") {
      this.cutLine();
      this.pendingOperator = null;
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
    this.pendingOperator = null;
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
    this.pendingOperator = null;
  }

  private handleNormalMode(data: string): void {
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

    if (data in NORMAL_KEYS) {
      return this.handleMappedKey(data);
    }

    // Pass control sequences (ctrl+c, etc.) to super, ignore printable chars
    if (data.length === 1 && data.charCodeAt(0) >= 32) return;
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
        super.handleInput(ESC_RIGHT);
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

  private moveCursorBy(delta: number): void {
    const seq = delta > 0 ? ESC_RIGHT : ESC_LEFT;
    for (let i = 0; i < Math.abs(delta); i++) {
      super.handleInput(seq);
    }
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

  private moveWord(direction: "forward" | "backward", target: "start" | "end"): void {
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
    if (data === "y") {
      // yy — yank whole line (linewise)
      const line = this.getLines()[this.getCursor().line] ?? "";
      this.writeToRegister(line + "\n");
      this.pendingOperator = null;
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
      this.pendingOperator = null; // cancel on unrecognised motion
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
      super.handleInput(ESC_RIGHT);
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
    if (this.pendingOperator && this.pendingMotion) {
      return ` NORMAL ${this.pendingOperator}${this.pendingMotion}_ `;
    }
    if (this.pendingOperator) return ` NORMAL ${this.pendingOperator}_ `;
    if (this.pendingMotion) return ` NORMAL ${this.pendingMotion}_ `;
    return " NORMAL ";
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
  });
}
