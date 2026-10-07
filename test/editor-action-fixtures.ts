import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { KeybindingsConfig } from "@earendil-works/pi-tui";

const requireFromPi = createRequire(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } =
  (await import(
    pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href
  )) as typeof import("@earendil-works/pi-tui");

export const EDITOR_BINDING_VARIANTS = ["remapped", "disabled"] as const;
export type EditorBindingVariant = (typeof EDITOR_BINDING_VARIANTS)[number];

const SYNTHETIC_ACTIONS = [
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.deleteToLineEnd",
  "tui.editor.undo",
  "tui.input.newLine",
] as const;

export function withEditorBindings<T>(
  variant: EditorBindingVariant,
  run: () => T,
): T {
  const previous = getKeybindings();
  const bindings: KeybindingsConfig = {};
  for (const [index, action] of SYNTHETIC_ACTIONS.entries()) {
    bindings[action] =
      variant === "disabled"
        ? []
        : (`ctrl+shift+${String.fromCharCode(97 + index)}` as KeybindingsConfig[string]);
  }
  bindings["tui.input.submit"] = [
    "ctrl+k",
    "ctrl+a",
    "ctrl+e",
    "ctrl+_",
    "right",
    "up",
    "q",
  ];
  bindings["tui.editor.deleteWordForward"] = ["left", "x"];
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
  try {
    return run();
  } finally {
    setKeybindings(previous);
  }
}
