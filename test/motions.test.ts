/**
 * Unit tests for motions.ts — pure functions, no DOM/pi-tui dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findWordMotionTarget,
  findCharMotionTarget,
  findFirstNonWhitespaceColumn,
  isBlankLine,
  isParagraphStart,
  findNextParagraphStart,
  findPrevParagraphStart,
  findParagraphMotionTarget,
} from "../motions.js";
import { WordBoundaryCache } from "../word-boundary-cache.js";

function makeGeneratedLineFixtures(count: number): string[] {
  let seed = 0x1badf00d;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };

  const words = ["alpha", "beta_2", "GAMMA", "z9", "m_n"];
  const punct = ["-", "--", "::", ".", ",", "!?", "#"];
  const spaces = [" ", "  ", "   ", "\t"];
  const fixtures = ["", "   ", "---", "a", "a   b", "foo--bar"];

  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const partCount = 1 + (next() % 6);

    for (let part = 0; part < partCount; part++) {
      const bucket = next() % 5;
      if (bucket <= 1) {
        parts.push(words[next() % words.length]!);
      } else if (bucket === 2) {
        parts.push(punct[next() % punct.length]!);
      } else {
        parts.push(spaces[next() % spaces.length]!);
      }
    }

    fixtures.push(parts.join(""));
  }

  return fixtures;
}

// ---------------------------------------------------------------------------
// findWordMotionTarget
// ---------------------------------------------------------------------------

describe("findWordMotionTarget — forward/start (w)", () => {
  it("already at EOL returns line.length", () => {
    assert.equal(findWordMotionTarget("foo", 3, "forward", "start"), 3);
  });

  it("moves from start of keyword word to next word start", () => {
    // "foo bar", col=0 ('f') → skip 'foo', skip ' ', land on 'b' at 4
    assert.equal(findWordMotionTarget("foo bar", 0, "forward", "start"), 4);
  });

  it("jumps over punctuation to next word start", () => {
    // "foo-bar", col=3 ('-') → skip '-', land on 'b' at 4
    assert.equal(findWordMotionTarget("foo-bar", 3, "forward", "start"), 4);
  });

  it("skips multiple spaces to reach next word", () => {
    // "foo   bar", col=0 → skip 'foo', skip '   ', land on 'b' at 6
    assert.equal(findWordMotionTarget("foo   bar", 0, "forward", "start"), 6);
  });
});

describe("findWordMotionTarget — forward/end (e)", () => {
  it("trailing spaces: e returns line.length (past last word)", () => {
    // "foo   " len=6, col=3 (space) → skip spaces, hit EOL
    assert.equal(findWordMotionTarget("foo   ", 3, "forward", "end"), 6);
  });

  it("e from word interior reaches end of that word", () => {
    // "foobar", col=0 → end of word is index 5
    assert.equal(findWordMotionTarget("foobar", 0, "forward", "end"), 5);
  });

  it("e from end of one word jumps to end of next word", () => {
    // "foo bar", col=2 (last 'o') → next word end is 6 ('r')
    assert.equal(findWordMotionTarget("foo bar", 2, "forward", "end"), 6);
  });
});

describe("findWordMotionTarget — backward/start (b)", () => {
  it("b from start of word lands on start of previous word", () => {
    // "foo bar", col=4 ('b') → b lands on 'f' at 0
    assert.equal(findWordMotionTarget("foo bar", 4, "backward", "start"), 0);
  });

  it("b from middle of word lands on start of current word", () => {
    // "foo bar", col=5 ('a') → b lands on 'b' at 4
    assert.equal(findWordMotionTarget("foo bar", 5, "backward", "start"), 4);
  });

  it("b from col=0 stays at 0", () => {
    assert.equal(findWordMotionTarget("foo", 0, "backward", "start"), 0);
  });

  it("b skips trailing spaces before the previous word", () => {
    // "foo   bar", col=6 ('b') → b skips '   ', lands on 'f' at 0
    assert.equal(findWordMotionTarget("foo   bar", 6, "backward", "start"), 0);
  });
});

describe("findWordMotionTarget — WORD semantics", () => {
  it("treats punctuation-joined tokens as one WORD for W/E/B", () => {
    assert.equal(
      findWordMotionTarget("foo-bar baz", 0, "forward", "start", "WORD"),
      8,
    );
    assert.equal(
      findWordMotionTarget("foo-bar baz", 0, "forward", "end", "WORD"),
      6,
    );
    assert.equal(
      findWordMotionTarget("foo-bar baz", 8, "backward", "start", "WORD"),
      0,
    );
  });

  it("uses whitespace-only delimiting transitions", () => {
    assert.equal(
      findWordMotionTarget("foo-bar   baz", 7, "forward", "start", "WORD"),
      10,
    );
    assert.equal(
      findWordMotionTarget("foo-bar   baz", 7, "forward", "end", "WORD"),
      12,
    );
  });

  it("keeps empty-line behavior", () => {
    assert.equal(findWordMotionTarget("", 0, "forward", "start", "WORD"), 0);
    assert.equal(findWordMotionTarget("", 0, "forward", "end", "WORD"), 0);
    assert.equal(findWordMotionTarget("", 0, "backward", "start", "WORD"), 0);
  });
});

describe("WordBoundaryCache", () => {
  it("keys entries by exact line content", () => {
    const cache = new WordBoundaryCache();

    const first = cache.get("alpha beta");
    const second = cache.get("alpha beta");
    const third = cache.get("alpha  beta");

    assert.equal(first, second);
    assert.notEqual(first, third);
  });

  it("separates cache entries by semantic class", () => {
    const cache = new WordBoundaryCache();

    const word = cache.get("foo-bar baz", "word");
    const wordAgain = cache.get("foo-bar baz", "word");
    const WORD = cache.get("foo-bar baz", "WORD");
    const WORDAgain = cache.get("foo-bar baz", "WORD");

    assert.equal(word, wordAgain);
    assert.equal(WORD, WORDAgain);
    assert.notEqual(word, WORD);
  });

  it("evicts oldest entries when cache size is exceeded", () => {
    const cache = new WordBoundaryCache(2);

    const first = cache.get("first");
    const second = cache.get("second");
    cache.get("third");

    // "second" survives right after first eviction.
    assert.equal(cache.get("second"), second);

    // "first" should be evicted first (FIFO eviction).
    const firstReloaded = cache.get("first");
    assert.notEqual(firstReloaded, first);
  });

  it("falls back to default capacity for invalid maxEntries", () => {
    const cache = new WordBoundaryCache(0);

    // Should not thrash every insertion: same key remains cached.
    const first = cache.get("stable");
    const second = cache.get("stable");

    assert.equal(first, second);
  });

  it("returns precomputed targets equivalent to canonical line scanner", () => {
    const cache = new WordBoundaryCache();
    const line = "foo_bar -- baz";

    for (const semanticClass of ["word", "WORD"] as const) {
      assert.equal(
        cache.tryFindTarget(line, 0, "forward", "start", semanticClass),
        findWordMotionTarget(line, 0, "forward", "start", semanticClass),
      );
      assert.equal(
        cache.tryFindTarget(line, 0, "forward", "end", semanticClass),
        findWordMotionTarget(line, 0, "forward", "end", semanticClass),
      );
      assert.equal(
        cache.tryFindTarget(line, 11, "backward", "start", semanticClass),
        findWordMotionTarget(line, 11, "backward", "start", semanticClass),
      );
    }
  });

  it("supports WORD semantics in cache lookups", () => {
    const cache = new WordBoundaryCache();
    const line = "foo-bar baz";

    assert.equal(cache.tryFindTarget(line, 0, "forward", "start", "WORD"), 8);
    assert.equal(cache.tryFindTarget(line, 0, "forward", "end", "WORD"), 6);
    assert.equal(cache.tryFindTarget(line, 8, "backward", "start", "WORD"), 0);
  });

  it("returns null for uncertain cursor inputs", () => {
    const cache = new WordBoundaryCache();

    assert.equal(cache.tryFindTarget("abc", -1, "forward", "start"), null);
    assert.equal(cache.tryFindTarget("abc", Number.NaN, "forward", "start"), null);
  });
});

describe("WordBoundaryCache differential", () => {
  it("matches canonical targets on generated line fixtures", () => {
    const cache = new WordBoundaryCache();
    const fixtures = makeGeneratedLineFixtures(80);

    for (const line of fixtures) {
      for (let col = 0; col <= line.length; col++) {
        const cases: Array<[
          direction: "forward" | "backward",
          target: "start" | "end",
        ]> = [
          ["forward", "start"],
          ["forward", "end"],
          ["backward", "start"],
        ];

        for (const [direction, target] of cases) {
          for (const semanticClass of ["word", "WORD"] as const) {
            const fast = cache.tryFindTarget(line, col, direction, target, semanticClass);
            const canonical = findWordMotionTarget(
              line,
              col,
              direction,
              target,
              semanticClass,
            );

            assert.equal(
              fast,
              canonical,
              `class=${semanticClass} line=${JSON.stringify(line)} col=${col} ${direction}/${target}`,
            );
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// First non-whitespace column
// ---------------------------------------------------------------------------

describe("findFirstNonWhitespaceColumn", () => {
  it("returns 0 for blank and all-whitespace lines", () => {
    assert.equal(findFirstNonWhitespaceColumn(""), 0);
    assert.equal(findFirstNonWhitespaceColumn("   \t"), 0);
  });

  it("finds the first non-whitespace column", () => {
    assert.equal(findFirstNonWhitespaceColumn("    foo"), 4);
    assert.equal(findFirstNonWhitespaceColumn("\t  foo"), 3);
  });
});

// ---------------------------------------------------------------------------
// Paragraph scanner helpers
// ---------------------------------------------------------------------------

describe("paragraph scanner helpers", () => {
  const lines = [
    "alpha",
    "alpha tail",
    "",
    "   ",
    "beta",
    "beta tail",
    "",
    "gamma",
    "",
    "   ",
  ];

  it("detects blank lines using ^\\s*$ semantics", () => {
    assert.equal(isBlankLine(""), true);
    assert.equal(isBlankLine("   \t"), true);
    assert.equal(isBlankLine("  x  "), false);
  });

  it("detects paragraph starts: non-blank line at BOF or after blank", () => {
    assert.equal(isParagraphStart(lines, 0), true);
    assert.equal(isParagraphStart(lines, 1), false);
    assert.equal(isParagraphStart(lines, 2), false);
    assert.equal(isParagraphStart(lines, 4), true);
    assert.equal(isParagraphStart(lines, 7), true);
  });

  it("scans next paragraph start from non-blank and blank-run positions", () => {
    assert.equal(findNextParagraphStart(lines, 0), 4);
    assert.equal(findNextParagraphStart(lines, 1), 4);
    assert.equal(findNextParagraphStart(lines, 2), 4);
    assert.equal(findNextParagraphStart(lines, 3), 4);
  });

  it("scans previous paragraph start from non-blank and blank-run positions", () => {
    assert.equal(findPrevParagraphStart(lines, 5), 4);
    assert.equal(findPrevParagraphStart(lines, 4), 0);
    assert.equal(findPrevParagraphStart(lines, 6), 4);
    assert.equal(findPrevParagraphStart(lines, 8), 7);
  });

  it("clamps to EOF/BOF when no paragraph start exists in direction", () => {
    assert.equal(findNextParagraphStart(lines, 7), 9);
    assert.equal(findNextParagraphStart(lines, 9), 9);
    assert.equal(findPrevParagraphStart(lines, 0), 0);

    const leadingBlankLines = ["", "  ", "alpha"];
    assert.equal(findPrevParagraphStart(leadingBlankLines, 2), 0);
  });

  it("supports counted traversal and clamps after exhausting paragraph starts", () => {
    assert.equal(findParagraphMotionTarget(lines, 0, "forward", 1), 4);
    assert.equal(findParagraphMotionTarget(lines, 0, "forward", 2), 7);
    assert.equal(findParagraphMotionTarget(lines, 0, "forward", 3), 9);

    assert.equal(findParagraphMotionTarget(lines, 7, "backward", 1), 4);
    assert.equal(findParagraphMotionTarget(lines, 7, "backward", 2), 0);
    assert.equal(findParagraphMotionTarget(lines, 7, "backward", 3), 0);

    assert.equal(findParagraphMotionTarget(lines, 3, "forward", 2), 7);
    assert.equal(findParagraphMotionTarget(lines, 6, "backward", 2), 0);
  });
});

// ---------------------------------------------------------------------------
// findCharMotionTarget
// ---------------------------------------------------------------------------

describe("findCharMotionTarget — f (inclusive forward)", () => {
  it("f finds first occurrence after cursor", () => {
    // "abcabc", col=2 ('c') — f 'a' finds 'a' at index 3
    assert.equal(findCharMotionTarget("abcabc", 2, "f", "a"), 3);
  });

  it("f finds char immediately after cursor", () => {
    // "abc", col=0 — f 'b' finds 'b' at 1
    assert.equal(findCharMotionTarget("abc", 0, "f", "b"), 1);
  });

  it("f returns null when char not found forward", () => {
    assert.equal(findCharMotionTarget("abc", 0, "f", "z"), null);
  });

  it("f does not match char at current col (searches col+1 onward)", () => {
    // cursor is on 'a' at col=0; f 'a' should find next 'a' at 3, not 0
    assert.equal(findCharMotionTarget("abca", 0, "f", "a"), 3);
  });
});

describe("findCharMotionTarget — t (exclusive forward / till)", () => {
  it("t lands one before target", () => {
    // "abcabc", col=0 — t 'c' finds 'c' at 2, stops at 1
    assert.equal(findCharMotionTarget("abcabc", 0, "t", "c"), 1);
  });

  it("t returns null when char not found", () => {
    assert.equal(findCharMotionTarget("abc", 0, "t", "z"), null);
  });

  it("t with isRepeat=true skips one extra char (;-repeat semantics)", () => {
    // "aXbXc", last t 'X' stopped at col=1 (before X@2); repeat starts at col+2
    // isRepeat: searchStart = col+1+1 = col+2+1 = 3 → finds 'X' at 3, returns 2
    assert.equal(findCharMotionTarget("aXbXc", 1, "t", "X", true), 2);
  });

  it("t isRepeat=false uses normal offset", () => {
    // without repeat, from col=1 searchStart=2, finds 'X' at 3, returns 2
    assert.equal(findCharMotionTarget("aXbXc", 1, "t", "X", false), 2);
  });
});

describe("findCharMotionTarget — F (inclusive backward)", () => {
  it("F finds last occurrence before cursor", () => {
    // "abcabc", col=4 ('b') — F 'a' searches up to col-1=3 → finds 'a' at 3
    assert.equal(findCharMotionTarget("abcabc", 4, "F", "a"), 3);
  });

  it("F finds char immediately before cursor", () => {
    // "abc", col=2 — F 'b' finds 'b' at 1
    assert.equal(findCharMotionTarget("abc", 2, "F", "b"), 1);
  });

  it("F returns null when char not found backward", () => {
    assert.equal(findCharMotionTarget("abc", 2, "F", "z"), null);
  });

  it("F does not match char at current col", () => {
    // col=3 on 'a'; F 'a' should find previous 'a' at 0, not 3
    assert.equal(findCharMotionTarget("abca", 3, "F", "a"), 0);
  });
});

describe("findCharMotionTarget — T (exclusive backward / till)", () => {
  it("T lands one after target", () => {
    // "abcabc", col=4 — T 'a' finds 'a' at 3, stops at 3+1=4 (same col, no move)
    assert.equal(findCharMotionTarget("abcabc", 4, "T", "a"), 4);
  });

  it("T finds char and steps one forward (exclusive)", () => {
    // "abcde", col=4 ('e') — T 'b' finds 'b' at 1, returns 1+1=2
    assert.equal(findCharMotionTarget("abcde", 4, "T", "b"), 2);
  });

  it("T returns null when char not found backward", () => {
    assert.equal(findCharMotionTarget("abc", 2, "T", "z"), null);
  });

  it("T with isRepeat=true skips one extra char for ; semantics", () => {
    // "aXbXc", last T 'X' stopped at col=4 (after X@3); repeat searchStart = col-1-1
    // from col=4: searchStart=4-1-1=2 → lastIndexOf('X', 2): not found (X only at 1,3)
    // actually let's use "XbXa", col=3 ('a') — T 'X' repeat: searchStart=3-1-1=1
    // lastIndexOf('X',1) = 0, return 0+1 = 1
    assert.equal(findCharMotionTarget("XbXa", 3, "T", "X", true), 1);
  });
});
