/**
 * Input hot-path micro-benchmark, isolated so it can run against two builds of
 * `ModalEditor` without recompiling: the entry point is taken from the
 * `PIVIM_ENTRY` environment variable (defaulting to this repo's `index.ts`).
 * Point it at a checkout of an older commit to compare `handleInput` cost
 * before and after a change — for example the dot-repeat recording that now
 * runs on every keystroke.
 *
 *   node --import tsx/esm script/hotpath-compare.ts            # this checkout
 *   PIVIM_ENTRY=/path/to/base/index.ts \
 *     node --import tsx/esm script/hotpath-compare.ts          # a base checkout
 *
 * Output is JSON on stdout: one entry per operation with median/p95 us/op.
 * Only the public `ModalEditor` surface is used, so the same harness drives
 * any build old enough to predate the operations it measures.
 */
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";

interface Editor {
  handleInput(data: string): void;
  setClipboardFn(fn: (text: string, signal?: AbortSignal) => unknown): void;
}

type EditorCtor = new (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
) => Editor;

type Stats = {
  min: number;
  median: number;
  p95: number;
  max: number;
};

type SampledMetric = {
  unit: string;
  samples: number[];
  stats: Stats;
};

const repoRoot = process.cwd();

const entryPath = process.env.PIVIM_ENTRY
  ? path.resolve(process.env.PIVIM_ENTRY)
  : path.resolve(repoRoot, "index.ts");

const { ModalEditor } = (await import(pathToFileURL(entryPath).href)) as {
  ModalEditor: EditorCtor;
};

const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
} as unknown as ConstructorParameters<EditorCtor>[0];

const stubTheme = {
  borderColor: (s: string) => s,
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as ConstructorParameters<EditorCtor>[1];

const stubKeybindings = {
  matches: () => false,
  getKeys: (action: Keybinding) => getKeybindings().getKeys(action),
} as unknown as ConstructorParameters<EditorCtor>[2];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx] ?? 0;
}

function toStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function createEditor(initialText: string): Editor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn(() => {});

  if (initialText.length > 0) {
    editor.handleInput(initialText);
  }

  editor.handleInput("\x1b");
  editor.handleInput("0");
  return editor;
}

function makeWordLine(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(`w${i}`);
  }
  return out.join(" ");
}

function benchmarkLoop(
  create: () => Editor,
  runOp: (editor: Editor) => void,
  iterations: number,
  samplesCount: number,
): SampledMetric {
  const samples: number[] = [];

  for (let sampleIdx = 0; sampleIdx < samplesCount; sampleIdx++) {
    const editor = create();
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      runOp(editor);
    }
    const ended = performance.now();
    samples.push(((ended - started) * 1000) / iterations);
  }

  return { unit: "us/op", samples, stats: toStats(samples) };
}

function benchmarkWithReset(
  create: () => Editor,
  before: (editor: Editor) => void,
  runOp: (editor: Editor) => void,
  after: (editor: Editor) => void,
  iterations: number,
  samplesCount: number,
): SampledMetric {
  const samples: number[] = [];

  for (let sampleIdx = 0; sampleIdx < samplesCount; sampleIdx++) {
    const editor = create();
    before(editor);

    let totalUs = 0;
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      runOp(editor);
      const ended = performance.now();
      totalUs += (ended - started) * 1000;
      after(editor);
    }

    samples.push(totalUs / iterations);
  }

  return { unit: "us/op", samples, stats: toStats(samples) };
}

function benchmarkFresh(
  create: () => Editor,
  runOp: (editor: Editor) => void,
  iterations: number,
  samplesCount: number,
): SampledMetric {
  const samples: number[] = [];

  for (let sampleIdx = 0; sampleIdx < samplesCount; sampleIdx++) {
    let totalUs = 0;

    for (let i = 0; i < iterations; i++) {
      const editor = create();
      const started = performance.now();
      runOp(editor);
      const ended = performance.now();
      totalUs += (ended - started) * 1000;
    }

    samples.push(totalUs / iterations);
  }

  return { unit: "us/op", samples, stats: toStats(samples) };
}

function runBenchmarks(): Record<string, SampledMetric> {
  const samplesCount = 8;
  const metrics: Record<string, SampledMetric> = {};

  // No-op key: an unbound printable in normal mode. The cheapest keystroke
  // path, so any fixed per-input recording cost shows up as the largest
  // fraction here.
  metrics.noop_key = benchmarkLoop(
    () => createEditor("abc"),
    (editor) => editor.handleInput("z"),
    20_000,
    samplesCount,
  );

  // Motion, wide line: `h` one column left on a 4k-column line — the headline
  // scoreboard keystroke. Dominated by the column walk, so it is a control:
  // recording overhead should be lost in the noise here.
  const hIterations = 4_000;
  metrics.motion_h_4k = benchmarkLoop(
    () => {
      const editor = createEditor("x".repeat(hIterations + 64));
      editor.handleInput("$");
      return editor;
    },
    (editor) => editor.handleInput("h"),
    hIterations,
    samplesCount,
  );

  // Motion, short line: `w` on a 50-word line. Cheap enough that per-input
  // recording overhead is measurable against it.
  const wordLine = makeWordLine(50);
  metrics.motion_w_50 = benchmarkWithReset(
    () => createEditor(wordLine),
    () => {},
    (editor) => editor.handleInput("w"),
    (editor) => editor.handleInput("0"),
    400,
    samplesCount,
  );

  // Insert, steady state: sustained typing inside one INSERT session. Each key
  // is appended to the open recording after dot-repeat; before it, nothing was
  // recorded. The line grows identically in both builds, so the delta isolates
  // the recording append.
  metrics.insert_type = benchmarkLoop(
    () => {
      const editor = createEditor("");
      editor.handleInput("i");
      return editor;
    },
    (editor) => editor.handleInput("x"),
    1_000,
    samplesCount,
  );

  // Insert, full lifecycle: `i` opens a recording, one char appends, Esc
  // finalizes it as the last change. Fresh editor per op so each measures a
  // complete open/append/commit cycle.
  metrics.insert_edit = benchmarkFresh(
    () => createEditor("word"),
    (editor) => {
      editor.handleInput("i");
      editor.handleInput("x");
      editor.handleInput("\x1b");
    },
    2_000,
    samplesCount,
  );

  return metrics;
}

function main(): void {
  const metrics = runBenchmarks();
  const payload = {
    entry: entryPath,
    nodeVersion: process.version,
    metrics,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main();
