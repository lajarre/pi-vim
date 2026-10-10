/**
 * Visual-mode selection geometry.
 *
 * A visual selection is an anchor (where `v`/`V` was pressed) plus the live
 * cursor. Both ends are inclusive, so the grapheme under the later end belongs
 * to the selection. Character-wise selections span an absolute text range;
 * line-wise selections span whole lines and ignore the columns.
 */

import { getLineGraphemes } from "./motions.js";
import type { Mode } from "./types.js";

export type VisualMode = "visual" | "visual-line";
export type VisualPosition = { line: number; col: number };
export type VisualLayoutLine = {
  logicalLine: number;
  startCol: number;
  length: number;
};

export type VisualRenderSpan = { start: number; end: number };

export function isVisualMode(mode: Mode): mode is VisualMode {
  return mode === "visual" || mode === "visual-line";
}

/** Negative when `a` precedes `b` in buffer order, positive when it follows. */
export function compareVisualPositions(
  a: VisualPosition,
  b: VisualPosition,
): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

/** The two endpoints in buffer order, regardless of which one is the anchor. */
export function orderVisualEndpoints(
  anchor: VisualPosition,
  cursor: VisualPosition,
): { start: VisualPosition; end: VisualPosition } {
  return compareVisualPositions(anchor, cursor) <= 0
    ? { start: anchor, end: cursor }
    : { start: cursor, end: anchor };
}

/** Whole lines covered by a line-wise selection. */
export function getVisualLineRange(
  anchor: VisualPosition,
  cursor: VisualPosition,
): { startLine: number; endLine: number } {
  return {
    startLine: Math.min(anchor.line, cursor.line),
    endLine: Math.max(anchor.line, cursor.line),
  };
}

/**
 * Exclusive end column for an inclusive selection end sitting at `col`.
 * Grapheme-aware, so a selection ending on an emoji takes the whole cluster.
 * A column at or past the end of the line yields the line length.
 */
export function getInclusiveEndColumn(line: string, col: number): number {
  if (col >= line.length) return line.length;
  const segment = getLineGraphemes(line).find((s) => col < s.end);
  return segment ? segment.end : line.length;
}

/** Keep a stale anchor inside the buffer after the text changed underneath it. */
export function clampVisualPosition(
  position: VisualPosition,
  lines: string[],
): VisualPosition {
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  const col = Math.max(0, Math.min(position.col, (lines[line] ?? "").length));
  return { line, col };
}

/**
 * Selected UTF-16 span within one host-wrapped layout line. The end may be one
 * cell past the line text: that paints the selected newline/EOL on the final
 * wrapped segment, including otherwise-empty lines.
 */
export function getVisualRenderSpan(
  mode: VisualMode,
  anchor: VisualPosition,
  cursor: VisualPosition,
  lines: string[],
  layoutLine: VisualLayoutLine,
): VisualRenderSpan | null {
  const { logicalLine, startCol, length } = layoutLine;
  const line = lines[logicalLine] ?? "";
  const segmentEnd = startCol + length;
  const isLastSegment = segmentEnd >= line.length;

  if (mode === "visual-line") {
    const { startLine, endLine } = getVisualLineRange(anchor, cursor);
    if (logicalLine < startLine || logicalLine > endLine) return null;
    return { start: 0, end: length + (isLastSegment ? 1 : 0) };
  }

  const { start, end } = orderVisualEndpoints(anchor, cursor);
  if (logicalLine < start.line || logicalLine > end.line) return null;

  const selectionStart = logicalLine === start.line ? start.col : 0;
  const selectionEnd =
    logicalLine === end.line
      ? getInclusiveEndColumn(line, end.col)
      : line.length;
  const intersectionStart = Math.max(selectionStart, startCol);
  const intersectionEnd = Math.min(selectionEnd, segmentEnd);
  const includesEol =
    isLastSegment &&
    (logicalLine < end.line ||
      (logicalLine === end.line &&
        end.col >= line.length &&
        logicalLine < lines.length - 1));

  if (intersectionEnd > intersectionStart) {
    return {
      start: intersectionStart - startCol,
      end: intersectionEnd - startCol + (includesEol ? 1 : 0),
    };
  }
  if (includesEol && selectionStart <= line.length) {
    return { start: length, end: length + 1 };
  }

  // An empty selected final line still occupies the cursor cell, including
  // when the anchor is on an earlier line and there is no final newline.
  if (isLastSegment && line.length === 0) {
    return { start: 0, end: 1 };
  }
  return null;
}

const CURSOR_MARKER = "\x1b_pi:c\x07";
const CSI_PATTERN = new RegExp(
  `^${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
);

function rawIndexAtTextOffset(line: string, target: number): number {
  let raw = 0;
  let text = 0;
  while (raw < line.length && text < target) {
    if (line.startsWith(CURSOR_MARKER, raw)) {
      raw += CURSOR_MARKER.length;
      continue;
    }
    const ansi = line.slice(raw).match(CSI_PATTERN)?.[0];
    if (ansi) {
      raw += ansi.length;
      continue;
    }
    raw++;
    text++;
  }
  return raw;
}

/** Apply a colorizer without letting the host software-cursor reset cancel it. */
export function highlightRenderedTextRange(
  line: string,
  start: number,
  end: number,
  colorize: (text: string) => string,
): string {
  if (end <= start) return line;
  const rawStart = rawIndexAtTextOffset(line, start);
  const rawEnd = rawIndexAtTextOffset(line, end);
  if (rawEnd <= rawStart) return line;

  const selected = line.slice(rawStart, rawEnd);
  const highlighted = selected
    .split("\x1b[0m")
    .map((part) => colorize(part))
    .join("\x1b[0m");
  return line.slice(0, rawStart) + highlighted + line.slice(rawEnd);
}
