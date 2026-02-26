/**
 * Motion calculation utilities for vim-mode
 */

import type { CharMotion } from "./types.js";

// Character types for word boundary detection
enum CharType {
  Space = 0,
  Keyword = 1, // alphanumeric + underscore
  Other = 2, // punctuation/symbols
}

function getCharType(c: string | undefined): CharType {
  if (!c || /\s/.test(c)) return CharType.Space;
  if (/\w/.test(c)) return CharType.Keyword;
  return CharType.Other;
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
): number | null {
  const isForward = motion === "f" || motion === "t";
  const isTill = motion === "t" || motion === "T";

  // For till repeats (;/,), we need extra offset to skip past the character we stopped before/after
  const tillRepeatOffset = isTill && isRepeat ? 1 : 0;

  if (isForward) {
    const searchStart = col + 1 + tillRepeatOffset;
    const idx = line.indexOf(targetChar, searchStart);
    if (idx !== -1) {
      return isTill ? idx - 1 : idx;
    }
  } else {
    const searchStart = col - 1 - tillRepeatOffset;
    const idx = line.lastIndexOf(targetChar, searchStart);
    if (idx !== -1) {
      return isTill ? idx + 1 : idx;
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
): number {
  const len = line.length;
  if (len === 0) return 0;

  let i = Math.max(0, Math.min(col, len));

  if (direction === "forward") {
    if (i >= len) return len;

    if (target === "start") {
      // w: move to start of next word
      const startType = getCharType(line[i]);

      // Skip current word/punct block
      if (startType !== CharType.Space) {
        while (i < len && getCharType(line[i]) === startType) i++;
      }

      // Skip whitespace
      while (i < len && getCharType(line[i]) === CharType.Space) i++;

      return i;
    }

    // e: move to end of current/next word
    if (i < len - 1) i++;

    // Skip whitespace forward
    while (i < len && getCharType(line[i]) === CharType.Space) i++;

    // Now at start of next word (or end of line). Find end.
    if (i >= len) return len;

    const type = getCharType(line[i]);
    while (i < len - 1 && getCharType(line[i + 1]) === type) i++;

    return i;
  }

  // b: move to start of previous word
  if (i >= len) i = len - 1;
  if (i > 0) i--;

  // Skip whitespace backward
  while (i > 0 && getCharType(line[i]) === CharType.Space) i--;

  // Now at end of prev word (or start of line). Find start.
  const type = getCharType(line[i]);
  while (i > 0 && getCharType(line[i - 1]) === type) i--;

  return i;
}
