import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { highlightRenderedTextRange } from "./visual.js";

/** Pi's TypeScript-private editor operations used by synthetic Vim commands. */
export type PiEditorAction =
  | [action: "undo"]
  | [action: "navigateHistory", direction: -1 | 1]
  | [action: "moveToLineStart"]
  | [action: "moveToLineEnd"]
  | [action: "deleteToEndOfLine"]
  | [action: "addNewLine"]
  | [action: "moveCursor", deltaLine: number, deltaCol: number];

/** Validate the whole contract before a command can make partial changes. */
export function getPiEditorCompatibilityError(editor: object): string | null {
  const actions: Record<PiEditorAction[0], true> = {
    undo: true,
    navigateHistory: true,
    moveToLineStart: true,
    moveToLineEnd: true,
    deleteToEndOfLine: true,
    addNewLine: true,
    moveCursor: true,
  };
  for (const action of Object.keys(actions)) {
    if (typeof (editor as Record<string, unknown>)[action] !== "function") {
      return `Pi editor compatibility error: ${action}() unavailable`;
    }
  }
  return null;
}

/** One detached host render: never change the live draft, history or TUI focus. */
export function probePiEditorCursor(
  ...args: ConstructorParameters<typeof CustomEditor>
): boolean {
  try {
    const probe = new CustomEditor(...args);
    probe.setText("a"); // Public setText leaves the cursor on the EOL cell, col 1.
    probe.focused = true;
    const row = probe.render(16)[1];
    const prefix = `a${CURSOR_MARKER}`;
    if (!row?.startsWith(prefix)) return false;
    const cell = row.slice(prefix.length);
    if (
      !cell.startsWith(" ") &&
      !cell.startsWith("\x1b_pi:fc\x07 \x1b_pi:/fc\x07") &&
      !cell.startsWith("\x1b[7m \x1b[0m") &&
      !cell.startsWith("\x1b[7m \x1b[27m")
    )
      return false;
    // Exercise the same raw-offset scanner as Visual paint, not a second
    // parser that could accept metadata the painter cannot actually skip.
    let selected = "";
    highlightRenderedTextRange(row, 1, 2, (text) => {
      selected += text;
      return text;
    });
    return selected === " " || selected === "\x1b[7m ";
  } catch {
    // An optional presentation probe must not disable working editor actions.
    // The caller emits one warning and disables only Visual paint.
    return false;
  }
}

/** Bypass input dispatch without silently falling back to configurable keys. */
export function runPiEditorAction(
  editor: object,
  ...[action, ...args]: PiEditorAction
): void {
  const method = (editor as unknown as Record<string, unknown>)[action];
  if (typeof method !== "function") {
    throw new Error(`Pi editor compatibility error: ${action}() unavailable`);
  }
  method.apply(editor, args);
}
