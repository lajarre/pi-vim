import { CURSOR_MARKER } from "@earendil-works/pi-tui";

const SOFTWARE_CURSOR_START = "\x1b[7m";
const SOFTWARE_CURSOR_RESETS = ["\x1b[0m", "\x1b[27m"] as const;
export const INSERT_CURSOR_SHAPE = "\x1b[5 q";
export const BLOCK_CURSOR_SHAPE = "\x1b[1 q";
export const CURSOR_SHAPE_SEQUENCES = {
  block: BLOCK_CURSOR_SHAPE,
  underline: "\x1b[3 q",
  bar: INSERT_CURSOR_SHAPE,
  "steady-block": "\x1b[2 q",
  "steady-underline": "\x1b[4 q",
  "steady-bar": "\x1b[6 q",
} as const;
const RESET_CURSOR_SHAPE = "\x1b[0 q";
const SHOW_HARDWARE_CURSOR = "\x1b[?25h";

export type CursorShapeSequence =
  | (typeof CURSOR_SHAPE_SEQUENCES)[keyof typeof CURSOR_SHAPE_SEQUENCES]
  | typeof RESET_CURSOR_SHAPE
  | typeof SHOW_HARDWARE_CURSOR;

export type CursorShapeRuntime = {
  writeCursorShape: (sequence: CursorShapeSequence) => void;
  setShowHardwareCursor: (show: boolean) => void;
  getShowHardwareCursor?: () => boolean | undefined;
};

export type CursorShapeCleanup = (event?: { reason?: string }) => void;

type CursorShapeTuiCandidate = {
  terminal?: { write?: unknown };
  setShowHardwareCursor?: unknown;
  getShowHardwareCursor?: unknown;
};

export function getCursorShapeRuntime(tui: unknown): CursorShapeRuntime | null {
  if (typeof tui !== "object" || tui === null) return null;

  const candidate = tui as CursorShapeTuiCandidate;
  const terminal = candidate.terminal;
  if (typeof terminal !== "object" || terminal === null) return null;

  const write = terminal.write;
  const setShowHardwareCursor = candidate.setShowHardwareCursor;
  if (
    typeof write !== "function" ||
    typeof setShowHardwareCursor !== "function"
  ) {
    return null;
  }

  const runtime: CursorShapeRuntime = {
    writeCursorShape(sequence: CursorShapeSequence): void {
      write.call(terminal, sequence);
    },
    setShowHardwareCursor(show: boolean): void {
      setShowHardwareCursor.call(candidate, show);
    },
  };

  if (typeof candidate.getShowHardwareCursor === "function") {
    const getShowHardwareCursor = candidate.getShowHardwareCursor;
    runtime.getShowHardwareCursor = () => {
      const value = getShowHardwareCursor.call(candidate);
      return typeof value === "boolean" ? value : undefined;
    };
  }

  return runtime;
}

export function enableCursorShapeSupport(
  tui: unknown,
): CursorShapeCleanup | null {
  const runtime = getCursorShapeRuntime(tui);
  if (!runtime) return null;

  const previousShowHardwareCursor = runtime.getShowHardwareCursor?.();
  runtime.setShowHardwareCursor(true);

  return (event) => {
    runtime.writeCursorShape(RESET_CURSOR_SHAPE);
    if (event?.reason === "quit") {
      runtime.writeCursorShape(SHOW_HARDWARE_CURSOR);
    } else if (previousShowHardwareCursor !== undefined) {
      runtime.setShowHardwareCursor(previousShowHardwareCursor);
    }
  };
}

function findSoftwareCursorReset(
  line: string,
  startIndex: number,
): { index: number; sequence: (typeof SOFTWARE_CURSOR_RESETS)[number] } | null {
  let firstReset: {
    index: number;
    sequence: (typeof SOFTWARE_CURSOR_RESETS)[number];
  } | null = null;

  for (const sequence of SOFTWARE_CURSOR_RESETS) {
    const index = line.indexOf(sequence, startIndex);
    if (index === -1) continue;
    if (!firstReset || index < firstReset.index) {
      firstReset = { index, sequence };
    }
  }

  return firstReset;
}

export function stripSoftwareCursorAfterMarker(line: string): string {
  const markerIndex = line.indexOf(CURSOR_MARKER);
  if (markerIndex === -1) return line;

  const searchStart = markerIndex + CURSOR_MARKER.length;
  const cursorStart = line.indexOf(SOFTWARE_CURSOR_START, searchStart);
  if (cursorStart === -1) return line;

  const cursorContentStart = cursorStart + SOFTWARE_CURSOR_START.length;
  const reset = findSoftwareCursorReset(line, cursorContentStart);
  if (!reset) return line;

  return (
    line.slice(0, cursorStart) +
    line.slice(cursorContentStart, reset.index) +
    line.slice(reset.index + reset.sequence.length)
  );
}

export function hasPromptCursorMarker(lines: string[]): boolean {
  return lines.some((line) => line.includes(CURSOR_MARKER));
}

export function stripSoftwareCursorWhenHardwareCursorIsUsed(
  lines: string[],
): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes(CURSOR_MARKER)) continue;

    lines[i] = stripSoftwareCursorAfterMarker(line);
    return;
  }
}
