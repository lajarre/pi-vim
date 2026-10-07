/** Pi's TypeScript-private editor operations used by synthetic Vim commands. */
export type PiEditorAction =
  | [action: "undo"]
  | [action: "moveToLineStart"]
  | [action: "moveToLineEnd"]
  | [action: "deleteToEndOfLine"]
  | [action: "addNewLine"]
  | [action: "moveCursor", deltaLine: number, deltaCol: number]
  | [action: "insertCharacter", text: string];

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
