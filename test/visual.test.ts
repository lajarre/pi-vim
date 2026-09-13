import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampVisualPosition,
  compareVisualPositions,
  getInclusiveEndColumn,
  getVisualLineRange,
  getVisualRenderSpan,
  highlightRenderedTextRange,
  isVisualMode,
  orderVisualEndpoints,
} from "../visual.js";

describe("isVisualMode", () => {
  it("recognises both visual modes", () => {
    assert.equal(isVisualMode("visual"), true);
    assert.equal(isVisualMode("visual-line"), true);
    assert.equal(isVisualMode("normal"), false);
    assert.equal(isVisualMode("insert"), false);
  });
});

describe("compareVisualPositions", () => {
  it("orders by line first, then column", () => {
    assert.ok(
      compareVisualPositions({ line: 0, col: 9 }, { line: 1, col: 0 }) < 0,
    );
    assert.ok(
      compareVisualPositions({ line: 1, col: 0 }, { line: 0, col: 9 }) > 0,
    );
    assert.ok(
      compareVisualPositions({ line: 2, col: 1 }, { line: 2, col: 3 }) < 0,
    );
    assert.equal(
      compareVisualPositions({ line: 2, col: 3 }, { line: 2, col: 3 }),
      0,
    );
  });
});

describe("orderVisualEndpoints", () => {
  it("keeps a forward selection in place", () => {
    assert.deepEqual(
      orderVisualEndpoints({ line: 0, col: 1 }, { line: 0, col: 4 }),
      { start: { line: 0, col: 1 }, end: { line: 0, col: 4 } },
    );
  });

  it("swaps a backward selection", () => {
    assert.deepEqual(
      orderVisualEndpoints({ line: 2, col: 0 }, { line: 1, col: 5 }),
      { start: { line: 1, col: 5 }, end: { line: 2, col: 0 } },
    );
  });

  it("treats the anchor as the start when both ends coincide", () => {
    const anchor = { line: 1, col: 1 };
    const cursor = { line: 1, col: 1 };
    assert.equal(orderVisualEndpoints(anchor, cursor).start, anchor);
  });
});

describe("getVisualLineRange", () => {
  it("normalises the line range in both directions", () => {
    assert.deepEqual(
      getVisualLineRange({ line: 0, col: 3 }, { line: 2, col: 0 }),
      { startLine: 0, endLine: 2 },
    );
    assert.deepEqual(
      getVisualLineRange({ line: 2, col: 0 }, { line: 0, col: 3 }),
      { startLine: 0, endLine: 2 },
    );
  });

  it("collapses a single-line selection", () => {
    assert.deepEqual(
      getVisualLineRange({ line: 1, col: 0 }, { line: 1, col: 9 }),
      {
        startLine: 1,
        endLine: 1,
      },
    );
  });
});

describe("getInclusiveEndColumn", () => {
  it("includes the whole grapheme under the end of the selection", () => {
    assert.equal(getInclusiveEndColumn("abc", 1), 2);
  });

  it("takes an entire emoji cluster", () => {
    assert.equal(getInclusiveEndColumn("a\u{1F600}b", 1), 3);
  });

  it("returns the line length at or past the end of the line", () => {
    assert.equal(getInclusiveEndColumn("abc", 3), 3);
    assert.equal(getInclusiveEndColumn("abc", 99), 3);
  });

  it("returns zero on an empty line", () => {
    assert.equal(getInclusiveEndColumn("", 0), 0);
  });
});

describe("clampVisualPosition", () => {
  it("leaves an in-bounds position untouched", () => {
    assert.deepEqual(clampVisualPosition({ line: 1, col: 2 }, ["abc", "def"]), {
      line: 1,
      col: 2,
    });
  });

  it("clamps a stale anchor back into the buffer", () => {
    assert.deepEqual(clampVisualPosition({ line: 9, col: 9 }, ["abc"]), {
      line: 0,
      col: 3,
    });
    assert.deepEqual(clampVisualPosition({ line: -1, col: -1 }, ["abc"]), {
      line: 0,
      col: 0,
    });
  });
});

describe("getVisualRenderSpan", () => {
  it("returns the inclusive character-wise grapheme span", () => {
    assert.deepEqual(
      getVisualRenderSpan(
        "visual",
        { line: 0, col: 1 },
        { line: 0, col: 3 },
        ["a😀bc"],
        { logicalLine: 0, startCol: 0, length: 5 },
      ),
      { start: 1, end: 4 },
    );
  });

  it("clips selection spans to host-wrapped layout lines", () => {
    const lines = ["alpha beta"];
    assert.deepEqual(
      getVisualRenderSpan(
        "visual",
        { line: 0, col: 2 },
        { line: 0, col: 8 },
        lines,
        { logicalLine: 0, startCol: 0, length: 6 },
      ),
      { start: 2, end: 6 },
    );
    assert.deepEqual(
      getVisualRenderSpan(
        "visual",
        { line: 0, col: 2 },
        { line: 0, col: 8 },
        lines,
        { logicalLine: 0, startCol: 6, length: 4 },
      ),
      { start: 0, end: 3 },
    );
  });

  it("paints the final EOL cell for whole-line selections", () => {
    assert.deepEqual(
      getVisualRenderSpan(
        "visual-line",
        { line: 0, col: 2 },
        { line: 0, col: 2 },
        ["abc"],
        { logicalLine: 0, startCol: 0, length: 3 },
      ),
      { start: 0, end: 4 },
    );
  });
});

describe("highlightRenderedTextRange", () => {
  it("ignores the hardware cursor marker when locating the selected text", () => {
    const marker = "\x1b_pi:c\x07";
    assert.equal(
      highlightRenderedTextRange(
        `ab${marker}cdef`,
        1,
        4,
        (text) => `<selected>${text}</selected>`,
      ),
      `a<selected>b${marker}cd</selected>ef`,
    );
  });

  it("restarts the highlight after a software-cursor reset", () => {
    assert.equal(
      highlightRenderedTextRange(
        "a\x1b[7mb\x1b[0mc",
        0,
        3,
        (text) => `[${text}]`,
      ),
      "[a\x1b[7mb]\x1b[0m[c]",
    );
  });
});
