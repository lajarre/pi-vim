import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExHistory } from "../ex-history.js";

describe("EX history store", () => {
  it("keeps an empty history and newer-at-draft navigation harmless", () => {
    const history = new ExHistory();
    assert.equal(history.older(), "");
    history.reset("draft");
    history.push("");
    history.reset("draft");
    assert.equal(history.newer(), "draft");
    assert.equal(history.older(), "draft");
  });

  it("browses newest first, clamps oldest and restores the draft past newest", () => {
    const history = new ExHistory();
    history.push("a");
    history.push("b");
    history.reset("x");
    assert.equal(history.newer(), "x");
    assert.equal(history.older(), "b");
    assert.equal(history.older(), "a");
    assert.equal(history.older(), "a");
    assert.equal(history.newer(), "b");
    assert.equal(history.newer(), "x");
    assert.equal(history.newer(), "x");
    assert.equal(history.older(), "b");
  });

  it("moves exact duplicates to the front without adding a copy", () => {
    const history = new ExHistory();
    for (const line of ["a", "b", "c", "b", "b"]) history.push(line);
    assert.equal(history.older(), "b");
    assert.equal(history.older(), "c");
    assert.equal(history.older(), "a");
    assert.equal(history.older(), "a");
  });

  it("retains verbatim whitespace, case and Unicode (only empty is omitted)", () => {
    const history = new ExHistory();
    for (const line of ["Name", "name", " name ", "  ", "é👩‍💻"]) {
      history.push(line);
    }
    assert.equal(history.older(), "é👩‍💻");
    assert.equal(history.older(), "  ");
    assert.equal(history.older(), " name ");
    assert.equal(history.older(), "name");
    assert.equal(history.older(), "Name");
  });

  it("caps at 100 distinct entries, retaining a promoted oldest entry", () => {
    const history = new ExHistory();
    for (let i = 0; i < 100; i++) history.push(String(i));
    history.push("0");
    history.push("100");
    assert.equal(history.older(), "100");
    assert.equal(history.older(), "0");
    for (let i = 99; i >= 2; i--) assert.equal(history.older(), String(i));
    assert.equal(history.older(), "2");
  });

  it("resets browsing after editing, pushing or canceling without losing entries", () => {
    const history = new ExHistory();
    history.push("a");
    history.push("b");
    history.older();
    history.older();
    history.reset("a edited");
    assert.equal(history.newer(), "a edited");
    assert.equal(history.older(), "b");
    assert.equal(history.newer(), "a edited");
    history.push("c");
    assert.equal(history.newer(), "");
    assert.equal(history.older(), "c");
    history.reset();
    assert.equal(history.newer(), "");
    assert.equal(history.older(), "c");
  });

  it("filters by the saved draft, clamps oldest and restores past newest match", () => {
    const history = new ExHistory();
    for (const line of ["ab", "xy", "ac", "yz"]) history.push(line);
    history.reset("a");
    assert.equal(history.newer(true), "a");
    assert.equal(history.older(true), "ac");
    assert.equal(history.older(true), "ab");
    assert.equal(history.older(true), "ab");
    assert.equal(history.newer(true), "ac");
    assert.equal(history.newer(true), "a");
    assert.equal(history.newer(true), "a");
    assert.equal(history.older(true), "ac");
  });

  it("leaves an unmatched prefix or empty history unchanged", () => {
    const history = new ExHistory();
    history.reset("a");
    assert.equal(history.older(true), "a");
    history.push("ab");
    history.push("xy");
    history.reset("z");
    assert.equal(history.older(true), "z");
    assert.equal(history.older(true), "z");
    assert.equal(history.newer(true), "z");
    assert.equal(history.older(), "xy");
    assert.equal(history.newer(), "z");
  });

  it("matches literal case-sensitive prefixes without trimming or normalizing", () => {
    const history = new ExHistory();
    for (const line of ["Name", "name", " name ", "é👩‍💻", "[a"])
      history.push(line);
    for (const [prefix, expected] of [
      ["N", "Name"],
      ["n", "name"],
      [" ", " name "],
      ["é", "é👩‍💻"],
      ["é", "é"],
      ["[", "[a"],
    ]) {
      history.reset(prefix);
      assert.equal(history.older(true), expected);
      assert.equal(history.newer(true), prefix);
    }
  });

  it("shares position and draft with unfiltered navigation when keys are mixed", () => {
    const history = new ExHistory();
    for (const line of ["ab", "xy", "ac", "yz"]) history.push(line);
    history.reset("a");
    assert.equal(history.older(true), "ac");
    assert.equal(history.newer(), "yz");
    assert.equal(history.older(true), "ac");
    assert.equal(history.older(), "xy");
    assert.equal(history.older(true), "ab");
    assert.equal(history.newer(true), "ac");
    assert.equal(history.newer(true), "a");
    assert.equal(history.older(), "yz");
    assert.equal(history.newer(true), "a");
  });

  it("empty-prefix navigation uses the same duplicate rule and cap", () => {
    const history = new ExHistory();
    for (let i = 0; i < 101; i++) history.push(String(i));
    history.push("50");
    assert.equal(history.older(true), "50");
    for (let i = 100; i >= 1; i--)
      if (i !== 50) assert.equal(history.older(true), String(i));
    assert.equal(history.older(true), "1");
    for (let i = 2; i <= 100; i++)
      if (i !== 50) assert.equal(history.newer(true), String(i));
    assert.equal(history.newer(true), "50");
    assert.equal(history.newer(true), "");
  });

  it("reset replaces the filter and position without mutating the stored entries", () => {
    const history = new ExHistory();
    for (const line of ["ab", "xy", "ac"]) history.push(line);
    history.reset("a");
    assert.equal(history.older(true), "ac");
    assert.equal(history.older(true), "ab");
    history.reset("ac");
    assert.equal(history.newer(true), "ac");
    assert.equal(history.older(true), "ac");
    assert.equal(history.older(true), "ac");
    history.reset();
    assert.equal(history.older(true), "ac");
    assert.equal(history.older(true), "xy");
    assert.equal(history.older(true), "ab");
  });

  it("isolates sessions", () => {
    const first = new ExHistory();
    first.push("private command");
    const second = new ExHistory();
    assert.equal(second.older(), "");
    assert.equal(first.older(), "private command");
  });
});
