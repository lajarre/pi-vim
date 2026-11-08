import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getLineGraphemes } from "./motions.js";

// Mode-label fitting for the editor borders. Pure, grapheme-aware functions
// that shrink the ` INSERT `/` NORMAL `/` EX … ` status label to a target
// width without splitting a grapheme — no editor state. The `render()` path
// composes the raw label (from editor state) and then fits it here.

// Take as many trailing graphemes of `rawLabel` as fit within `width`,
// measuring by visible width so wide/combining graphemes are never split.
export function takeModeLabelSuffix(rawLabel: string, width: number): string {
  if (width <= 0) return "";

  const graphemes = getLineGraphemes(rawLabel);
  const suffix: string[] = [];
  let usedWidth = 0;

  for (let i = graphemes.length - 1; i >= 0; i--) {
    const grapheme = graphemes[i];
    if (!grapheme) continue;

    const segment = rawLabel.slice(grapheme.start, grapheme.end);
    const segmentWidth = visibleWidth(segment);
    if (usedWidth + segmentWidth > width) break;
    suffix.push(segment);
    usedWidth += segmentWidth;
  }

  return suffix.reverse().join("");
}

// Fit `rawLabel` into `width`. When it overflows, keep the leading mode
// keyword (or compact I/N/V/VL/: prefix) plus an ellipsis and as much of the
// pending-command tail as fits; fall back to a plain right-truncation when
// there is no recognizable keyword or no room for the keyword itself.
export function fitModeLabel(rawLabel: string, width: number): string {
  if (visibleWidth(rawLabel) <= width) return rawLabel;

  const prefix = rawLabel.startsWith(" INSERT ")
    ? " INSERT "
    : rawLabel.startsWith(" NORMAL ")
      ? " NORMAL "
      : rawLabel.startsWith(" EX ")
        ? " EX "
        : rawLabel.startsWith(" VL ")
          ? " VL "
          : /^ [INV] /.test(rawLabel)
            ? rawLabel.slice(0, 3)
            : rawLabel.startsWith(" :")
              ? " :"
              : "";

  if (!prefix || visibleWidth(prefix) >= width) {
    return truncateToWidth(rawLabel, width, "");
  }

  const suffixWidth = width - visibleWidth(prefix) - 1;
  if (suffixWidth <= 0) return `${prefix}…`;
  return `${prefix}…${takeModeLabelSuffix(rawLabel, suffixWidth)}`;
}

const SGR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "g");

// Only overwrite border cells, never an annotation: pi-tui 0.78 puts its
// scroll indicator after three dashes; 1.0 centers it. Prefer the left edge
// when the label fits, otherwise use the larger edge gap and shrink to fit.
// Cached by the editor on source row, width and raw label (not on theme).
export function layoutTopModeLabel(
  source: string,
  width: number,
  rawLabel: string,
): { label: string; before: string; after: string } {
  // Older hosts can emit a three-dot scroll ellipsis even at widths 1–2.
  const line = truncateToWidth(source, width, "");
  const text = stripVTControlCharacters(line);
  const left = text.match(/^─*/)?.[0].length ?? 0;
  const right = text.match(/─*$/)?.[0].length ?? 0;
  const useLeft = left >= visibleWidth(rawLabel) || left >= right;
  const label = fitModeLabel(rawLabel, useLeft ? left : right);
  const cells = visibleWidth(label);
  if (cells === 0) return { label: "", before: line, after: "" };

  // The replaceable cells are all single-column dashes, so their raw indices
  // locate the splice without splitting ANSI runs or any annotation graphemes.
  const dashes = [...line.matchAll(/─/g)];
  const first = useLeft ? 0 : dashes.length - right;
  const start = dashes[first]?.index;
  const last = dashes[first + cells - 1]?.index;
  if (start === undefined || last === undefined) {
    return { label: "", before: line, after: "" };
  }
  const end = last + 1;
  // Isolate the label, then replay the host's SGR state at the splice. This
  // works for one color run around the row and for a run around every dash.
  // Keep the original suffix (including its resets), not a repainted border.
  const restore = line.slice(0, end).match(SGR_PATTERN)?.join("") ?? "";
  return {
    label,
    before: `${line.slice(0, start)}\x1b[0m`,
    after: `\x1b[0m${restore}${line.slice(end)}`,
  };
}
