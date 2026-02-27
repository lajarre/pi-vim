/**
 * Unit tests for motions.ts — pure functions, no DOM/pi-tui dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findWordMotionTarget, findCharMotionTarget } from "../motions.js";
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

describe("WordBoundaryCache", () => {
  it("keys entries by exact line content", () => {
    const cache = new WordBoundaryCache();

    const first = cache.get("alpha beta");
    const second = cache.get("alpha beta");
    const third = cache.get("alpha  beta");

    assert.equal(first, second);
    assert.notEqual(first, third);
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

    assert.equal(
      cache.tryFindTarget(line, 0, "forward", "start"),
      findWordMotionTarget(line, 0, "forward", "start"),
    );
    assert.equal(
      cache.tryFindTarget(line, 0, "forward", "end"),
      findWordMotionTarget(line, 0, "forward", "end"),
    );
    assert.equal(
      cache.tryFindTarget(line, 11, "backward", "start"),
      findWordMotionTarget(line, 11, "backward", "start"),
    );
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
          const fast = cache.tryFindTarget(line, col, direction, target);
          const canonical = findWordMotionTarget(line, col, direction, target);

          assert.equal(
            fast,
            canonical,
            `line=${JSON.stringify(line)} col=${col} ${direction}/${target}`,
          );
        }
      }
    }
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
