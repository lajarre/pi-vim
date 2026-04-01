import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ModalEditor } from "../index.js";

type StubTui = {
  requestRender(): void;
  terminal: { rows: number; cols: number };
};

type StubTheme = {
  borderColor(s: string): string;
  fg(_k: string, s: string): string;
  bold(s: string): string;
};

type StubKeybindings = {
  matches(): boolean;
};

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

const stubTui: StubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
};

const stubTheme: StubTheme = {
  borderColor: (s: string) => s,
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
};

const stubKeybindings: StubKeybindings = {
  matches: () => false,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
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

function runNodeEval(code: string, extraArgs: string[] = []): { stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", ...extraArgs, "-e", code],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        `node child process failed (status=${result.status})`,
        result.stderr?.trim() ?? "",
      ].filter(Boolean).join("\n"),
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function measureStartup(importExpr: string, runs: number): SampledMetric {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    runNodeEval(importExpr);
    const ended = performance.now();
    samples.push(ended - started);
  }
  return { unit: "ms", samples, stats: toStats(samples) };
}

function measureHeap(importTarget: string | null, runs: number): SampledMetric {
  const samples: number[] = [];

  const importLine = importTarget
    ? `await import(${JSON.stringify(importTarget)});`
    : "";

  const code = `
${importLine}
if (typeof globalThis.gc === 'function') {
  for (let i = 0; i < 5; i++) globalThis.gc();
}
const mem = process.memoryUsage();
console.log(JSON.stringify({ heapUsed: mem.heapUsed }));
`;

  for (let i = 0; i < runs; i++) {
    const { stdout } = runNodeEval(code, ["--expose-gc"]);
    const parsed = JSON.parse(stdout.trim()) as { heapUsed: number };
    samples.push(parsed.heapUsed);
  }

  return { unit: "bytes", samples, stats: toStats(samples) };
}

function createEditor(initialText: string): ModalEditor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn(() => {});

  if (initialText.length > 0) {
    editor.handleInput(initialText);
  }

  editor.handleInput("\x1b");
  editor.handleInput("0");
  return editor;
}

function benchmarkSimpleLoop(
  create: () => ModalEditor,
  runOp: (editor: ModalEditor) => void,
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
    const usPerOp = ((ended - started) * 1000) / iterations;
    samples.push(usPerOp);
  }

  return { unit: "us/op", samples, stats: toStats(samples) };
}

function benchmarkSingleOpWithReset(
  create: () => ModalEditor,
  before: (editor: ModalEditor) => void,
  runOp: (editor: ModalEditor) => void,
  after: (editor: ModalEditor) => void,
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

function benchmarkSingleOpFresh(
  create: () => ModalEditor,
  before: (editor: ModalEditor) => void,
  runOp: (editor: ModalEditor) => void,
  iterations: number,
  samplesCount: number,
): SampledMetric {
  const samples: number[] = [];

  for (let sampleIdx = 0; sampleIdx < samplesCount; sampleIdx++) {
    let totalUs = 0;

    for (let i = 0; i < iterations; i++) {
      const editor = create();
      before(editor);

      const started = performance.now();
      runOp(editor);
      const ended = performance.now();
      totalUs += (ended - started) * 1000;
    }

    samples.push(totalUs / iterations);
  }

  return { unit: "us/op", samples, stats: toStats(samples) };
}

function makeWordLine(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(`w${i}`);
  }
  return out.join(" ");
}

function runResponsivenessBenchmarks(): Record<string, SampledMetric> {
  const samplesCount = 4;

  const metrics: Record<string, SampledMetric> = {};

  const hIterations = 4_000;
  metrics.h = benchmarkSimpleLoop(
    () => {
      const editor = createEditor("x".repeat(hIterations + 64));
      editor.handleInput("$");
      return editor;
    },
    (editor) => editor.handleInput("h"),
    hIterations,
    samplesCount,
  );

  metrics.ignored_printable = benchmarkSimpleLoop(
    () => createEditor("abc"),
    (editor) => editor.handleInput("z"),
    20_000,
    samplesCount,
  );

  const countWordLine = makeWordLine(400);
  metrics["10w"] = benchmarkSingleOpWithReset(
    () => createEditor(countWordLine),
    () => {},
    (editor) => {
      editor.handleInput("1");
      editor.handleInput("0");
      editor.handleInput("w");
    },
    (editor) => editor.handleInput("0"),
    220,
    samplesCount,
  );

  const charFindLine = "aX".repeat(300);
  metrics["3fX"] = benchmarkSingleOpWithReset(
    () => createEditor(charFindLine),
    () => {},
    (editor) => {
      editor.handleInput("3");
      editor.handleInput("f");
      editor.handleInput("X");
    },
    (editor) => editor.handleInput("0"),
    300,
    samplesCount,
  );

  const verticalLinesText = Array.from({ length: 320 }, (_, i) => `line_${i}`).join("\n");
  metrics["200j"] = benchmarkSingleOpWithReset(
    () => createEditor(verticalLinesText),
    () => {},
    (editor) => {
      editor.handleInput("2");
      editor.handleInput("0");
      editor.handleInput("0");
      editor.handleInput("j");
    },
    (editor) => {
      editor.handleInput("g");
      editor.handleInput("g");
    },
    120,
    samplesCount,
  );

  metrics["50p"] = benchmarkSingleOpFresh(
    () => createEditor("seed next"),
    (editor) => {
      editor.handleInput("y");
      editor.handleInput("w");
      editor.handleInput("0");
    },
    (editor) => {
      editor.handleInput("5");
      editor.handleInput("0");
      editor.handleInput("p");
    },
    120,
    samplesCount,
  );

  const wordCases = [20, 50, 100, 200, 400] as const;
  const iterationsByWords: Record<number, number> = {
    20: 600,
    50: 400,
    100: 300,
    200: 200,
    400: 120,
  };

  for (const words of wordCases) {
    const line = makeWordLine(words);
    const iterations = iterationsByWords[words];

    metrics[`w_words_${words}`] = benchmarkSingleOpWithReset(
      () => createEditor(line),
      () => {},
      (editor) => editor.handleInput("w"),
      (editor) => editor.handleInput("0"),
      iterations,
      samplesCount,
    );

    metrics[`b_words_${words}`] = benchmarkSingleOpWithReset(
      () => createEditor(line),
      (editor) => editor.handleInput("$"),
      (editor) => editor.handleInput("b"),
      (editor) => editor.handleInput("$"),
      iterations,
      samplesCount,
    );
  }

  const longWords = 400;
  const longLine = makeWordLine(longWords);

  metrics.dw_words_400 = benchmarkSingleOpWithReset(
    () => createEditor(longLine),
    () => {},
    (editor) => {
      editor.handleInput("d");
      editor.handleInput("w");
    },
    (editor) => {
      editor.handleInput("P");
      editor.handleInput("0");
    },
    120,
    samplesCount,
  );

  metrics.yw_words_400 = benchmarkSimpleLoop(
    () => createEditor(longLine),
    (editor) => {
      editor.handleInput("y");
      editor.handleInput("w");
    },
    1_200,
    samplesCount,
  );

  return metrics;
}

function summarizeForTextOutput(data: {
  startup: Record<string, SampledMetric>;
  memory: Record<string, SampledMetric>;
  responsiveness: Record<string, SampledMetric>;
  startupIncrementalMs: number;
  memoryIncrementalBytes: number;
}): string {
  const lines: string[] = [];

  lines.push("startup (median)");
  lines.push(`  runtime_only: ${data.startup.runtime_only.stats.median.toFixed(2)} ms`);
  lines.push(`  host_import: ${data.startup.host_import.stats.median.toFixed(2)} ms`);
  lines.push(`  extension_import: ${data.startup.extension_import.stats.median.toFixed(2)} ms`);
  lines.push(`  incremental_extension: ${data.startupIncrementalMs.toFixed(2)} ms`);
  lines.push("");

  lines.push("memory (median heapUsed)");
  lines.push(`  host_import: ${Math.round(data.memory.host_import.stats.median).toLocaleString()} bytes`);
  lines.push(`  extension_import: ${Math.round(data.memory.extension_import.stats.median).toLocaleString()} bytes`);
  lines.push(`  incremental_extension: ${Math.round(data.memoryIncrementalBytes).toLocaleString()} bytes`);
  lines.push("");

  lines.push("responsiveness (median us/op)");
  for (const [name, metric] of Object.entries(data.responsiveness)) {
    lines.push(`  ${name}: ${metric.stats.median.toFixed(2)} us/op`);
  }

  return lines.join("\n");
}

function main(): void {
  const asJson = process.argv.includes("--json");

  const startupRuns = 7;
  const memoryRuns = 5;

  const extensionImport = pathToFileURL(path.resolve(repoRoot, "index.ts")).href;

  const startup = {
    runtime_only: measureStartup("", startupRuns),
    host_import: measureStartup(`await import('@mariozechner/pi-coding-agent');`, startupRuns),
    extension_import: measureStartup(`await import(${JSON.stringify(extensionImport)});`, startupRuns),
  };

  const memory = {
    host_import: measureHeap("@mariozechner/pi-coding-agent", memoryRuns),
    extension_import: measureHeap(extensionImport, memoryRuns),
  };

  const responsiveness = runResponsivenessBenchmarks();

  const startupIncrementalMs = startup.extension_import.stats.median - startup.host_import.stats.median;
  const memoryIncrementalBytes = memory.extension_import.stats.median - memory.host_import.stats.median;

  const payload = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    startupRuns,
    memoryRuns,
    startup,
    startupIncrementalMs,
    memory,
    memoryIncrementalBytes,
    responsiveness,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2));
    return;
  }

  process.stdout.write(
    summarizeForTextOutput({
      startup,
      memory,
      responsiveness,
      startupIncrementalMs,
      memoryIncrementalBytes,
    }),
  );
}

main();
