/**
 * Types and constants for vim-mode extension
 */

import type { PiEditorAction } from "./pi-editor-actions.js";

export type Mode = "normal" | "insert" | "visual" | "visual-line";
export type CharMotion = "f" | "F" | "t" | "T";
export type PendingMotion = CharMotion | null;
export type PendingOperator = "d" | "c" | "y" | null;

export interface LastCharMotion {
  motion: CharMotion;
  char: string;
}

/** Normal-mode key mappings; null entries use pi-vim's own command handlers. */
export const NORMAL_KEYS: Record<string, PiEditorAction | null> = {
  h: ["moveCursor", 0, -1],
  j: ["moveCursor", 1, 0],
  k: ["moveCursor", -1, 0],
  l: ["moveCursor", 0, 1],
  "0": ["moveToLineStart"],
  $: null, // line end
  x: null, // delete char (custom clipboard handling)
  X: null, // delete char before cursor (custom clipboard handling)
  D: null, // delete to end of line (custom clipboard handling)
  C: null, // change to end of line (delete to end + insert mode)
  S: null, // substitute line (delete line content + insert mode)
  s: null, // substitute char (delete char + insert mode)
  i: null, // insert mode
  a: null, // append (insert + right)
  A: null, // append at end of line
  I: null, // insert at start of line
  o: null, // open line below
  O: null, // open line above
};

// Character motion keys that wait for a target character
export const CHAR_MOTION_KEYS = new Set<string>(["f", "F", "t", "T"]);

// Raw user-input aliases retained by the Vim undo/redo dispatcher.
export const CTRL_R = "\x12"; // ctrl+r — readline redo trigger in vim layer
export const CTRL_UNDERSCORE = "\x1f"; // ctrl+_ — readline undo
