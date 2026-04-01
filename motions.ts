/**
 * Motion calculation utilities for vim-mode
 */

import type { CharMotion } from "./types.js";

// Character types for word boundary detection
export type WordMotionClass = "word" | "WORD";

enum CharType {
  Space = 0,
  Keyword = 1, // alphanumeric + underscore (or all non-space in WORD mode)
  Other = 2, // punctuation/symbols
}

function getCharType(
  c: string | undefined,
  semanticClass: WordMotionClass = "word",
): CharType {
  if (!c || /\s/.test(c)) return CharType.Space;
  if (semanticClass === "WORD") return CharType.Keyword;
  if (/\w/.test(c)) return CharType.Keyword;
  return CharType.Other;
}

function clampLineIndex(lines: readonly string[], lineIndex: number): number {
  if (lines.length === 0) return 0;
  if (!Number.isFinite(lineIndex)) return 0;
  const normalized = Math.trunc(lineIndex);
  return Math.max(0, Math.min(normalized, lines.length - 1));
}

/**
 * Column of first non-whitespace char, or 0 for blank lines.
 */
export function findFirstNonWhitespaceColumn(line: string): number {
  const match = line.search(/\S/);
  return match === -1 ? 0 : match;
}

/**
 * True when line matches ^\s*$.
 */
export function isBlankLine(line: string | undefined): boolean {
  if (line === undefined) return true;
  return /^\s*$/.test(line);
}

/**
 * Paragraph start: non-blank line at BOF or after a blank line.
 */
export function isParagraphStart(lines: readonly string[], lineIndex: number): boolean {
  if (!Number.isInteger(lineIndex)) return false;
  if (lineIndex < 0 || lineIndex >= lines.length) return false;
  if (isBlankLine(lines[lineIndex])) return false;
  if (lineIndex === 0) return true;
  return isBlankLine(lines[lineIndex - 1]);
}

/**
 * One step of } motion from current line index.
 */
export function findNextParagraphStart(lines: readonly string[], fromLine: number): number {
  if (lines.length === 0) return 0;

  const start = clampLineIndex(lines, fromLine) + 1;
  for (let i = start; i < lines.length; i++) {
    if (isParagraphStart(lines, i)) return i;
  }

  return lines.length - 1;
}

/**
 * One step of { motion from current line index.
 */
export function findPrevParagraphStart(lines: readonly string[], fromLine: number): number {
  if (lines.length === 0) return 0;

  const start = clampLineIndex(lines, fromLine) - 1;
  for (let i = start; i >= 0; i--) {
    if (isParagraphStart(lines, i)) return i;
  }

  return 0;
}

/**
 * Paragraph motion target for counted { / } semantics.
 */
export function findParagraphMotionTarget(
  lines: readonly string[],
  fromLine: number,
  direction: "forward" | "backward",
  count: number = 1,
): number {
  if (lines.length === 0) return 0;

  const steps = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  let currentLine = clampLineIndex(lines, fromLine);

  for (let i = 0; i < steps; i++) {
    const nextLine =
      direction === "forward"
        ? findNextParagraphStart(lines, currentLine)
        : findPrevParagraphStart(lines, currentLine);

    if (nextLine === currentLine) break;
    currentLine = nextLine;
  }

  return currentLine;
}

/**
 * Reverse a character motion direction (f ↔ F, t ↔ T).
 */
export function reverseCharMotion(motion: CharMotion): CharMotion {
  const reverseMap: Record<CharMotion, CharMotion> = {
    f: "F",
    F: "f",
    t: "T",
    T: "t",
  };
  return reverseMap[motion];
}

const GRAPHEME_SEGMENTER = typeof Intl !== "undefined"
  && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export function getLineGraphemes(line: string): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  if (GRAPHEME_SEGMENTER) {
    for (const part of GRAPHEME_SEGMENTER.segment(line)) {
      segments.push({ start: part.index, end: part.index + part.segment.length });
    }
    return segments;
  }
  let start = 0;
  for (const text of Array.from(line)) {
    segments.push({ start, end: start + text.length });
    start += text.length;
  }
  return segments;
}

/**
 * Find target column for a character motion (f/F/t/T).
 * @returns target column or null if not found
 */
export function findCharMotionTarget(
  line: string,
  col: number,
  motion: CharMotion,
  targetChar: string,
  isRepeat: boolean = false,
  count: number = 1,
): number | null {
  const isForward = motion === "f" || motion === "t";
  const isTill = motion === "t" || motion === "T";
  const steps = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;

  const graphemes = getLineGraphemes(line);
  let currentIndex = graphemes.findIndex(g => col < g.end);
  if (currentIndex === -1) currentIndex = graphemes.length;

  for (let i = 0; i < steps; i++) {
    const isFirst = i === 0;
    const isFinal = i === steps - 1;
    const tillRepeatOffset = isFirst && isTill && isRepeat ? 1 : 0;

    if (isForward) {
      const nextIndex = currentIndex + 1 + tillRepeatOffset;
      let found = -1;
      for (let j = nextIndex; j < graphemes.length; j++) {
        const g = graphemes[j]!;
        // Use startsWith to allow matching base chars if targetChar lacks combining marks,
        // or just exact match since targetChar is typically a full grapheme.
        if (line.slice(g.start, g.end) === targetChar || line.slice(g.start, g.end).startsWith(targetChar)) {
          found = j;
          break;
        }
      }
      if (found === -1) return null;
      if (isFinal) return isTill ? graphemes[found - 1]!.start : graphemes[found]!.start;
      currentIndex = found;
    } else {
      const nextIndex = currentIndex - 1 - tillRepeatOffset;
      let found = -1;
      for (let j = nextIndex; j >= 0; j--) {
        const g = graphemes[j]!;
        if (line.slice(g.start, g.end) === targetChar || line.slice(g.start, g.end).startsWith(targetChar)) {
          found = j;
          break;
        }
      }
      if (found === -1) return null;
      if (isFinal) {
        if (!isTill) return graphemes[found]!.start;
        const afterTarget = graphemes[found + 1];
        return afterTarget ? afterTarget.start : line.length;
      }
      currentIndex = found;
    }
  }

  return null;
}

/**
 * Calculate word motion target column.
 */
export function findWordMotionTarget(
  line: string,
  col: number,
  direction: "forward" | "backward",
  target: "start" | "end",
  semanticClass: WordMotionClass = "word",
): number {
  const len = line.length;
  if (len === 0) return 0;

  let i = Math.max(0, Math.min(col, len));

  if (direction === "forward") {
    if (i >= len) return len;

    if (target === "start") {
      // w: move to start of next word
      const startType = getCharType(line[i], semanticClass);

      // Skip current word/punct block
      if (startType !== CharType.Space) {
        while (i < len && getCharType(line[i], semanticClass) === startType) i++;
      }

      // Skip whitespace
      while (i < len && getCharType(line[i], semanticClass) === CharType.Space) i++;

      return i;
    }

    // e: move to end of current/next word
    if (i < len - 1) i++;

    // Skip whitespace forward
    while (i < len && getCharType(line[i], semanticClass) === CharType.Space) i++;

    // Now at start of next word (or end of line). Find end.
    if (i >= len) return len;

    const type = getCharType(line[i], semanticClass);
    while (i < len - 1 && getCharType(line[i + 1], semanticClass) === type) i++;

    return i;
  }

  // b: move to start of previous word
  if (i >= len) i = len - 1;
  if (i > 0) i--;

  // Skip whitespace backward
  while (i > 0 && getCharType(line[i], semanticClass) === CharType.Space) i--;

  // Now at end of prev word (or start of line). Find start.
  const type = getCharType(line[i], semanticClass);
  while (i > 0 && getCharType(line[i - 1], semanticClass) === type) i--;

  return i;
}
