import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { SearchMatch } from "./search.js";

type LayoutLine = { text: string; hasCursor: boolean; cursorPos?: number };
type NativeLayout = {
  layoutText?: (width: number) => LayoutLine[];
  scrollOffset?: number;
  renderedVisibleLineCount?: number;
  tui?: { terminal?: { rows?: number } };
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Decorate only verified native draft rows; retain their cursor, layout and menus.
 * Pi TUI 1.0's private layout/scroll data is read, never changed. On a host
 * upgrade or unexpected row shape we leave the native row untouched.
 */
export function highlightSearchRows(
  rows: string[],
  editor: NativeLayout & {
    getLines(): string[];
    getPaddingX(): number;
    focused: boolean;
  },
  width: number,
  matches: SearchMatch[],
  current: number | null,
): void {
  if (!matches.some((match) => match.end > match.start)) return;
  const paddingX = Math.min(
    editor.getPaddingX(),
    Math.max(0, Math.floor((width - 1) / 2)),
  );
  const contentWidth = Math.max(1, width - paddingX * 2);
  const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
  const scroll = editor.scrollOffset;
  const visible =
    editor.renderedVisibleLineCount ??
    (typeof editor.tui?.terminal?.rows === "number"
      ? Math.min(
          Math.max(5, Math.floor(editor.tui.terminal.rows * 0.3)),
          rows.length - 2,
        )
      : undefined);
  if (
    typeof editor.layoutText !== "function" ||
    typeof scroll !== "number" ||
    typeof visible !== "number" ||
    !Number.isInteger(scroll) ||
    !Number.isInteger(visible) ||
    scroll < 0 ||
    visible < 0
  )
    return;
  const layout = editor.layoutText(layoutWidth);
  if (!Array.isArray(layout)) return;
  const sourceLines = editor.getLines();
  let logical = 0;
  let consumed = 0;
  let lineAbsolute = 0;
  let matchIndex = 0;
  for (let i = 0; i < layout.length; i++) {
    const part = layout[i];
    const source = sourceLines[logical];
    if (
      !part ||
      typeof part.text !== "string" ||
      source === undefined ||
      source.slice(consumed, consumed + part.text.length) !== part.text
    )
      return;
    const start = lineAbsolute + consumed;
    if (i >= scroll && i < scroll + visible) {
      const rowIndex = i - scroll + 1;
      const row = rows[rowIndex];
      if (row !== undefined && part.text.length > 0) {
        while (matches[matchIndex] && matches[matchIndex].end <= start)
          matchIndex++;
        const relevant: SearchMatch[] = [];
        for (let j = matchIndex; j < matches.length; j++) {
          const match = matches[j];
          if (!match || match.start >= start + part.text.length) break;
          if (match.end > start) relevant.push(match);
        }
        if (relevant.length) {
          const styled = decorateNativeRow(
            row,
            part,
            paddingX,
            contentWidth,
            editor.focused,
            start,
            relevant,
            current,
          );
          if (styled !== null) rows[rowIndex] = styled;
        }
      }
    }
    consumed += part.text.length;
    if (consumed === source.length) {
      logical++;
      lineAbsolute += source.length + 1;
      consumed = 0;
    }
  }
}

function decorateNativeRow(
  row: string,
  part: LayoutLine,
  padding: number,
  contentWidth: number,
  focused: boolean,
  start: number,
  matches: SearchMatch[],
  current: number | null,
): string | null {
  const cursor = part.hasCursor ? part.cursorPos : undefined;
  if (
    part.hasCursor &&
    (cursor === undefined || cursor < 0 || cursor > part.text.length)
  )
    return null;
  const marker = focused ? CURSOR_MARKER : "";
  const segments = [...segmenter.segment(part.text)];
  if (
    cursor !== undefined &&
    cursor < part.text.length &&
    !segments.some((segment) => segment.index === cursor)
  )
    return null;
  let native = "";
  let styled = "";
  for (const segment of segments) {
    const absolute = start + segment.index;
    const match = matches.find(
      (item) =>
        item.start < absolute + segment.segment.length && item.end > absolute,
    );
    const style = match
      ? match.start === current
        ? "\x1b[4;7m"
        : "\x1b[4m"
      : "";
    const raw =
      cursor === segment.index
        ? `${marker}\x1b[7m${segment.segment}\x1b[0m`
        : segment.segment;
    native += raw;
    styled += style ? `${style}${raw}\x1b[24;27m` : raw;
  }
  let cellWidth = visibleWidth(part.text);
  if (cursor === part.text.length) {
    native += `${marker}\x1b[7m \x1b[0m`;
    styled += `${marker}\x1b[7m \x1b[0m`;
    cellWidth++;
  }
  const rightPadding =
    cellWidth > contentWidth && padding > 0 ? padding - 1 : padding;
  const suffix = " ".repeat(
    Math.max(0, contentWidth - cellWidth) + rightPadding,
  );
  const prefix = " ".repeat(padding);
  if (row !== prefix + native + suffix) return null;
  return prefix + styled + suffix;
}
