import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { fitModeLabel, takeModeLabelSuffix } from "../mode-label.js";

// truncateToWidth appends an ANSI reset; strip it to compare visible text.
const ANSI_RESET = "\x1b[0m";
const visibleText = (s: string): string =>
  s.endsWith(ANSI_RESET) ? s.slice(0, -ANSI_RESET.length) : s;

describe("fitModeLabel", () => {
  it("returns the label unchanged when it already fits", () => {
    assert.equal(fitModeLabel(" NORMAL ", 20), " NORMAL ");
    assert.equal(fitModeLabel(" INSERT ", 8), " INSERT ");
  });

  it("keeps the mode keyword, an ellipsis, and the trailing tail", () => {
    const result = fitModeLabel(" EX helloworld_ ", 10);
    assert.equal(result, " EX …rld_ ");
    assert.equal(visibleWidth(result), 10);
  });

  // These compact labels are pi-vim UI, intentionally not nvim's mode text.
  it("keeps compact prefixes and grapheme-safe pending tails", () => {
    for (const prefix of [" I ", " N ", " V ", " VL ", " :"]) {
      const raw = `${prefix}long-command-é👩‍💻_ `;
      assert.equal(fitModeLabel(raw, 80), raw);
      assert.equal(
        fitModeLabel(raw, visibleWidth(prefix) + 6),
        `${prefix}…é👩‍💻_ `,
      );
      for (let width = 0; width <= 20; width++) {
        assert.ok(visibleWidth(fitModeLabel(raw, width)) <= width);
      }
    }
    assert.equal(fitModeLabel(" :command_ ", 6), " :…d_ ");
    assert.equal(fitModeLabel(" N 123d4f_ ", 8), " N …4f_ ");
  });

  it("emits just the keyword and ellipsis when no suffix fits", () => {
    assert.equal(fitModeLabel(" EX command_ ", 5), " EX …");
  });

  it("plain-truncates the head when there is no mode keyword", () => {
    const raw = "XX some long text";
    const result = fitModeLabel(raw, 5);
    assert.ok(!result.includes("…"));
    assert.equal(visibleText(result), "XX so");
    assert.ok(visibleWidth(result) <= 5);
  });

  it("plain-truncates when the width cannot fit the keyword", () => {
    const raw = " NORMAL xyz_ ";
    const result = fitModeLabel(raw, 4);
    assert.ok(!result.includes("…"));
    assert.equal(visibleText(result), " NOR");
    assert.ok(visibleWidth(result) <= 4);
  });
});

describe("takeModeLabelSuffix", () => {
  it("returns empty for non-positive width", () => {
    assert.equal(takeModeLabelSuffix("hello", 0), "");
    assert.equal(takeModeLabelSuffix("hello", -3), "");
  });

  it("takes as many trailing graphemes as fit", () => {
    assert.equal(takeModeLabelSuffix("hello", 3), "llo");
    assert.equal(takeModeLabelSuffix("hello", 100), "hello");
  });

  it("never splits a wide grapheme", () => {
    assert.equal(takeModeLabelSuffix("a👍", 1), "");
    assert.equal(takeModeLabelSuffix("a👍", 2), "👍");
    assert.equal(takeModeLabelSuffix("a👍", 3), "a👍");
  });
});
