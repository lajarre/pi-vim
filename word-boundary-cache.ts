/**
 * Line-local cache for Vim word motion boundaries.
 *
 * Keyed by semantic class + exact line content to avoid stale boundary reuse.
 */

import type { WordMotionClass } from "./motions.js";

export type WordMotionDirection = "forward" | "backward";
export type WordMotionTarget = "start" | "end";

enum CharType {
  Space = 0,
  Word = 1,
  Other = 2,
}

export interface WordBoundaryData {
  readonly length: number;
  readonly charTypes: Uint8Array;
  readonly runStartByIndex: Int32Array;
  readonly runEndByIndex: Int32Array;
  readonly nextNonSpaceAtOrAfter: Int32Array;
  readonly prevNonSpaceAtOrBefore: Int32Array;
}

function getCharType(
  ch: string | undefined,
  semanticClass: WordMotionClass = "word",
): CharType {
  if (!ch || /\s/.test(ch)) return CharType.Space;
  if (semanticClass === "WORD") return CharType.Word;
  if (/\w/.test(ch)) return CharType.Word;
  return CharType.Other;
}

function buildWordBoundaryData(
  line: string,
  semanticClass: WordMotionClass = "word",
): WordBoundaryData {
  const len = line.length;
  const charTypes = new Uint8Array(len);
  const runStartByIndex = new Int32Array(len);
  const runEndByIndex = new Int32Array(len);
  const nextNonSpaceAtOrAfter = new Int32Array(len + 1);
  const prevNonSpaceAtOrBefore = new Int32Array(len);

  nextNonSpaceAtOrAfter.fill(-1);
  prevNonSpaceAtOrBefore.fill(-1);

  for (let i = 0; i < len; i++) {
    charTypes[i] = getCharType(line[i], semanticClass);
  }

  for (let runStart = 0; runStart < len;) {
    const runType = charTypes[runStart]!;
    let runEnd = runStart;
    while (runEnd + 1 < len && charTypes[runEnd + 1] === runType) {
      runEnd++;
    }

    for (let i = runStart; i <= runEnd; i++) {
      runStartByIndex[i] = runStart;
      runEndByIndex[i] = runEnd;
    }

    runStart = runEnd + 1;
  }

  let nextNonSpace = -1;
  for (let i = len - 1; i >= 0; i--) {
    if (charTypes[i] !== CharType.Space) {
      nextNonSpace = i;
    }
    nextNonSpaceAtOrAfter[i] = nextNonSpace;
  }

  let prevNonSpace = -1;
  for (let i = 0; i < len; i++) {
    if (charTypes[i] !== CharType.Space) {
      prevNonSpace = i;
    }
    prevNonSpaceAtOrBefore[i] = prevNonSpace;
  }

  return {
    length: len,
    charTypes,
    runStartByIndex,
    runEndByIndex,
    nextNonSpaceAtOrAfter,
    prevNonSpaceAtOrBefore,
  };
}

function findTargetInLine(
  data: WordBoundaryData,
  col: number,
  direction: WordMotionDirection,
  target: WordMotionTarget,
): number {
  const len = data.length;
  if (len === 0) return 0;

  let i = Math.max(0, Math.min(col, len));

  if (direction === "forward") {
    if (i >= len) return len;

    if (target === "start") {
      if (data.charTypes[i] !== CharType.Space) {
        i = data.runEndByIndex[i]! + 1;
      }

      if (i >= len) return len;

      if (data.charTypes[i] === CharType.Space) {
        const next = data.nextNonSpaceAtOrAfter[i]!;
        return next === -1 ? len : next;
      }

      return i;
    }

    if (i < len - 1) i++;

    if (i >= len) return len;

    if (data.charTypes[i] === CharType.Space) {
      const next = data.nextNonSpaceAtOrAfter[i]!;
      if (next === -1) return len;
      i = next;
    }

    return data.runEndByIndex[i]!;
  }

  if (i >= len) i = len - 1;
  if (i > 0) i--;

  if (data.charTypes[i] === CharType.Space) {
    const prev = data.prevNonSpaceAtOrBefore[i]!;
    if (prev !== -1) i = prev;
  }

  return data.runStartByIndex[i]!;
}

const DEFAULT_MAX_CACHE_ENTRIES = 256;

export class WordBoundaryCache {
  private readonly entries = new Map<string, WordBoundaryData>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_CACHE_ENTRIES) {
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries
      : DEFAULT_MAX_CACHE_ENTRIES;
  }

  private makeCacheKey(line: string, semanticClass: WordMotionClass): string {
    return `${semanticClass}\u0000${line}`;
  }

  get(line: string, semanticClass: WordMotionClass = "word"): WordBoundaryData {
    const key = this.makeCacheKey(line, semanticClass);
    const cached = this.entries.get(key);
    if (cached) return cached;

    const built = buildWordBoundaryData(line, semanticClass);

    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, built);
    return built;
  }

  tryFindTarget(
    line: string,
    col: number,
    direction: WordMotionDirection,
    target: WordMotionTarget,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    if (!Number.isInteger(col) || col < 0) return null;

    const boundaries = this.get(line, semanticClass);
    return findTargetInLine(boundaries, col, direction, target);
  }
}
