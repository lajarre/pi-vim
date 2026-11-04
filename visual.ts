/**
 * Visual-mode selection geometry.
 *
 * A visual selection is an anchor (where `v`/`V` was pressed) plus the live
 * cursor. Both ends are inclusive, so the grapheme under the later end belongs
 * to the selection. Character-wise selections span an absolute text range;
 * line-wise selections span whole lines and ignore the columns.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { getLineGraphemes } from "./motions.js";
import type { Mode } from "./types.js";

export type VisualMode = "visual" | "visual-line";
export type VisualPosition = { line: number; col: number };
export type VisualLayoutLine = {
  logicalLine: number;
  startCol: number;
  length: number;
};

/** A buffer-local display-row motion; columns are screen cells, not UTF-16. */
export function findDisplayLineTarget(
  lines: readonly string[],
  rows: readonly VisualLayoutLine[],
  cursor: VisualPosition,
  delta: number,
  wantedColumn: number | null,
  allowEol = false,
  preferredCol = cursor.col,
): (VisualPosition & { wantedColumn: number }) | null {
  // The optional host map must cover the buffer in order, without gaps. Never
  // turn an incompatible layout into an operator range over unrelated text.
  let logicalLine = 0;
  let startCol = 0;
  for (const row of rows) {
    if (
      !row ||
      row.logicalLine !== logicalLine ||
      row.startCol !== startCol ||
      !Number.isInteger(row.length) ||
      row.length < 0 ||
      (row.length === 0 && lines[logicalLine] !== "") ||
      startCol + row.length > (lines[logicalLine]?.length ?? -1)
    ) {
      return null;
    }
    startCol += row.length;
    if (startCol === lines[logicalLine]?.length) {
      logicalLine++;
      startCol = 0;
    }
  }
  if (logicalLine !== lines.length || startCol !== 0) return null;

  const current = rows.findIndex(
    (row, index) =>
      row.logicalLine === cursor.line &&
      cursor.col >= row.startCol &&
      (cursor.col < row.startCol + row.length ||
        (cursor.col === row.startCol + row.length &&
          rows[index + 1]?.logicalLine !== row.logicalLine)),
  );
  if (current < 0) return null;
  const source = rows[current];
  const targetIndex = Math.max(0, Math.min(current + delta, rows.length - 1));
  const target = rows[targetIndex];
  const sourceText = lines[cursor.line] ?? "";
  const column =
    wantedColumn ??
    visibleWidth(sourceText.slice(source.startCol, preferredCol)) +
      Math.max(0, preferredCol - sourceText.length);
  // At a buffer edge even an EOL cursor must remain exactly where it was.
  if (targetIndex === current) return { ...cursor, wantedColumn: column };

  const text = (lines[target.logicalLine] ?? "").slice(
    target.startCol,
    target.startCol + target.length,
  );
  let cells = 0;
  let col = target.startCol;
  for (const grapheme of getLineGraphemes(text)) {
    col = target.startCol + grapheme.start;
    cells += visibleWidth(text.slice(grapheme.start, grapheme.end));
    if (cells > column) break;
  }
  if (
    allowEol &&
    rows[targetIndex + 1]?.logicalLine !== target.logicalLine &&
    cells <= column
  ) {
    col = target.startCol + target.length;
  }
  return { line: target.logicalLine, col, wantedColumn: column };
}

export type VisualRenderSpan = { start: number; end: number };
export type VisualRenderRange = {
  start: VisualPosition;
  end: VisualPosition;
  endColExclusive: number;
};

/** Resolve the inclusive end grapheme once, not once per wrapped row. */
export function prepareVisualRenderRange(
  mode: VisualMode,
  anchor: VisualPosition,
  cursor: VisualPosition,
  lines: string[],
): VisualRenderRange {
  const { start, end } = orderVisualEndpoints(anchor, cursor);
  return {
    start,
    end,
    endColExclusive:
      mode === "visual"
        ? getInclusiveEndColumn(lines[end.line] ?? "", end.col)
        : 0,
  };
}

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
  range = prepareVisualRenderRange(mode, anchor, cursor, lines),
): VisualRenderSpan | null {
  const { logicalLine, startCol, length } = layoutLine;
  const line = lines[logicalLine] ?? "";
  const segmentEnd = startCol + length;
  const isLastSegment = segmentEnd >= line.length;

  const { start, end, endColExclusive } = range;
  if (mode === "visual-line") {
    if (logicalLine < start.line || logicalLine > end.line) return null;
    return { start: 0, end: length + (isLastSegment ? 1 : 0) };
  }

  if (logicalLine < start.line || logicalLine > end.line) return null;

  const selectionStart = logicalLine === start.line ? start.col : 0;
  const selectionEnd = logicalLine === end.line ? endColExclusive : line.length;
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

// APC payloads are zero-width host metadata (cursor and fake-cursor markers
// on newer pi-tui). Accept BEL and ST terminators without slicing per byte.
const APC_SOURCE = `${String.fromCharCode(27)}_[\\s\\S]*?(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)`;
const APC_PATTERN = new RegExp(APC_SOURCE, "y");
const PAINT_BREAK_PATTERN = new RegExp(
  `(${APC_SOURCE}|${String.fromCharCode(27)}\\[0m)`,
);
const CSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "y",
);

function rawIndexAtTextOffset(line: string, target: number): number {
  let raw = 0;
  let text = 0;
  while (raw < line.length && text < target) {
    APC_PATTERN.lastIndex = raw;
    if (APC_PATTERN.test(line)) {
      raw = APC_PATTERN.lastIndex;
      continue;
    }
    CSI_PATTERN.lastIndex = raw;
    const ansi = CSI_PATTERN.exec(line)?.[0];
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
  // Validate the entire row, even metadata beyond the selected span. An
  // unterminated APC makes text offsets unsafe: leave this frame untouched.
  for (let apc = line.indexOf("\x1b_"); apc !== -1; ) {
    APC_PATTERN.lastIndex = apc;
    if (!APC_PATTERN.test(line)) return line;
    apc = line.indexOf("\x1b_", APC_PATTERN.lastIndex);
  }
  const rawStart = rawIndexAtTextOffset(line, start);
  const rawEnd = rawIndexAtTextOffset(line, end);
  if (rawEnd <= rawStart) return line;

  const selected = line.slice(rawStart, rawEnd);
  // Keep APCs outside added SGR, especially the adjacent pi:c + pi:fc pair
  // matched by the host compositor. Only their cell text receives styling.
  const highlighted = selected
    .split(PAINT_BREAK_PATTERN)
    .map((part, index) => (index % 2 === 0 && part ? colorize(part) : part))
    .join("");
  return line.slice(0, rawStart) + highlighted + line.slice(rawEnd);
}
