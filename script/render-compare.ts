/** Render-only comparison; PIVIM_ENTRY selects a nested no-install archive. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

type Editor = {
  setText(text: string): void;
  handleInput(key: string): void;
  render(width: number): string[];
  getMode(): string;
  focused: boolean;
};
const { ModalEditor } = (await import(
  pathToFileURL(resolve(process.env.PIVIM_ENTRY ?? "index.ts")).href
)) as {
  ModalEditor: new (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    options: unknown,
  ) => Editor;
};
const draft = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
const fiveLines = Array.from(
  { length: 5 },
  (_, i) => `line${i} ${"draft word ".repeat(6)}`,
).join("\n");
const fixtures = [
  {
    name: "insert_80_long",
    text: draft,
    keys: [],
    widths: [80],
    mode: "insert",
  },
  {
    name: "visual_5_lines",
    text: fiveLines,
    keys: ["\x1b", "g", "g", "0", "v", "4", "j", "$"],
    widths: [80],
    mode: "visual",
  },
  {
    name: "visual_line_400_words",
    text: draft,
    keys: ["\x1b", "0", "V", "$"],
    widths: [80],
    mode: "visual-line",
  },
  {
    name: "normal_80_long",
    text: draft,
    keys: ["\x1b"],
    widths: [80],
    mode: "normal",
  },
  {
    name: "ex_80_long",
    text: draft,
    keys: ["\x1b", ":", "c", "o", "n", "f", "i", "g"],
    widths: [80],
    mode: "normal",
  },
  {
    name: "insert_resize_79_80",
    text: draft,
    keys: [],
    widths: [79, 80],
    mode: "insert",
  },
  {
    name: "visual_unicode_20",
    text: "alpha 中e\u0301😀 β ".repeat(40),
    keys: ["\x1b", "0", "v", "$"],
    widths: [20],
    mode: "visual",
  },
  ...[4096, 16384].flatMap((size) => [
    {
      name: `visual_one_${size}`,
      text: "x".repeat(size),
      keys: ["\x1b", "0", "v"],
      widths: [80],
      mode: "visual",
    },
    {
      name: `normal_${size}`,
      text: "x".repeat(size),
      keys: ["\x1b", "0"],
      widths: [80],
      mode: "normal",
    },
  ]),
];
const theme = {
  borderColor: (s: string) => `\x1b[90m${s}\x1b[39m`,
  fg: (_key: string, s: string) => s,
  bold: (s: string) => s,
  bg: (_key: string, s: string) => `\x1b[48;2;38;64;84m${s}\x1b[49m`,
};
const label = (s: string) => `\x1b[36m\x1b[7m${s}\x1b[27m\x1b[39m`;
function count(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value > 0, name);
  return value;
}
const warmup = count("PIVIM_WARMUP", 1000);
const samples = count("PIVIM_SAMPLES", 60);
const iterations = count("PIVIM_ITERATIONS", 100);
const metrics: Record<string, unknown> = {};
let consumed = 0;
for (const fixture of fixtures) {
  const tui = {
    requestRender() {},
    terminal: { rows: 40, cols: 80, write() {} },
    getShowHardwareCursor: () => true,
    setShowHardwareCursor() {},
  };
  const editor = new ModalEditor(
    tui,
    theme,
    { matches: () => false },
    {
      selectionColorizer: (s: string) => theme.bg("selectedBg", s),
      labelColorizers: {
        insert: label,
        normal: label,
        visual: label,
        ex: label,
      },
    },
  );
  editor.focused = true;
  editor.setText(fixture.text);
  for (const key of fixture.keys) editor.handleInput(key);
  assert.equal(editor.getMode(), fixture.mode, fixture.name);
  for (let i = 0; i < warmup; i++)
    consumed += editor.render(
      fixture.widths[i % fixture.widths.length] ?? 80,
    ).length;
  const times: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++)
      consumed += editor.render(
        fixture.widths[i % fixture.widths.length] ?? 80,
      ).length;
    times.push(((performance.now() - start) * 1000) / iterations);
  }
  const sorted = [...times].sort((a, b) => a - b);
  metrics[fixture.name] = {
    widths: fixture.widths,
    rows: 40,
    utf16Length: fixture.text.length,
    logicalLines: fixture.text.split("\n").length,
    mode: fixture.mode,
    keys: fixture.keys,
    samples: times,
    median: sorted[Math.floor((samples - 1) * 0.5)],
    p95: sorted[Math.floor((samples - 1) * 0.95)],
  };
}
console.log(
  JSON.stringify(
    {
      build: process.env.PIVIM_BUILD,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      warmup,
      samples,
      iterations,
      consumed,
      metrics,
    },
    null,
    2,
  ),
);
