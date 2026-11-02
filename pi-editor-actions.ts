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
