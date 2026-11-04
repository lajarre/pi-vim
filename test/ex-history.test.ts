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

  it("isolates sessions", () => {
    const first = new ExHistory();
    first.push("private command");
    const second = new ExHistory();
    assert.equal(second.older(), "");
    assert.equal(first.older(), "private command");
  });
});
