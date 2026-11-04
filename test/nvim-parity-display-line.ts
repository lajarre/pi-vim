import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

// Unbroken text gives Pi's word-aware wrapper and nvim's hard wrapper the
// same rows. Host-specific word wrapping / tab cells have unit coverage.
const long = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
const cases: NvimParityCase[] = [
  ...["gj", "gk", "3gj", "3gk", "99999gj", "99999gk"].map((keys) => ({
    name: `${keys}: wrapped rows and count clamp`,
    initial: {
      text: `${long}\n${long}\n${long}`,
      cursor: { line: 1, col: 25 },
    },
    keys: [...keys],
  })),
  ...["gj", "gk"].map((keys) => ({
    name: `${keys}: unwrapped logical lines`,
    initial: { text: "abcdef\nghijkl\nmnopqr", cursor: { line: 1, col: 3 } },
    keys: [...keys],
  })),
  ...["gj", "gjgj", "gjgjgk", "gjhgj", "gj0gj", "2gj"].map((keys) => ({
    name: `${keys}: sticky column through a short row`,
    initial: {
      text: `${long.slice(0, 23)}\n${long}`,
      cursor: { line: 0, col: 15 },
    },
    keys: [...keys],
  })),
  ...["gj", "gjgj", "gjgjgk"].map((keys) => ({
    name: `${keys}: empty intermediate line`,
    initial: { text: "abcdef\n\nabcdefgh", cursor: { line: 0, col: 4 } },
    keys: [...keys],
  })),
  ...["gk", "9gk", "dgk", "cgk", "ygk"].map((keys) => ({
    name: `${keys}: top row is inert`,
    initial: { text: long, cursor: { line: 0, col: 3 }, register: "keep" },
    keys: [...keys],
  })),
  ...["gj", "9gj", "dgj", "cgj", "ygj"].map((keys) => ({
    name: `${keys}: bottom row is inert`,
    initial: { text: long, cursor: { line: 0, col: 45 }, register: "keep" },
    keys: [...keys],
  })),
  ...[
    "dgj",
    "dgk",
    "ygj",
    "ygk",
    "2d2gj",
    "d2gj",
    "2ygk",
    "dgj.",
    "dgj.u",
    "dgj.u\x12",
    "dgjux\x12",
  ].map((keys) => ({
    name: `${JSON.stringify(keys)}: exclusive operators and edit history`,
    initial: {
      text: `${long}\n${long}\n${long}`,
      cursor: { line: 1, col: 25 },
    },
    keys: [...keys],
    typedInput: true,
  })),
  ...["cgjX\x1b", "cgkX\x1b", "cgjX\x1b.", "cgjX\x1bu"].map((keys) => ({
    name: `${JSON.stringify(keys)}: change and dot`,
    initial: { text: long, cursor: { line: 0, col: 25 } },
    keys: [...keys],
    typedInput: true,
  })),
  ...["dgj", "ygj", "cgjX\x1b"].map((keys) => ({
    name: `${JSON.stringify(keys)}: exclusive motion ending at logical BOL`,
    initial: { text: "abc\ndef\nghi", cursor: { line: 0, col: 0 } },
    keys: [...keys],
  })),
  ...["vgj", "vgk", "v2gjy", "vgkd", "Vgj", "Vgk", "V2gjy", "Vgky"].map(
    (keys) => ({
      name: `${keys}: Visual / V-Line extend with display rows`,
      initial: { text: `${long}\n${long}`, cursor: { line: 0, col: 25 } },
      keys: [...keys],
    }),
  ),
  ...[
    "gjvgj",
    "gjVgj",
    "gjvgjgj",
    "gjygj",
    "gjdgj",
    "$gk",
    "$gkgk",
    "jgj",
    "gjjgj",
    "2dgj.",
    "dgj2.",
  ].map((keys) => ({
    name: `${keys}: wanted cells across mode, logical motion, and repeat transitions`,
    initial: {
      text: `${long.slice(0, 23)}\nxy\n${long}`,
      cursor: { line: 0, col: 15 },
    },
    keys: [...keys],
    typedInput: true,
  })),
  ...["dgj", "ygj", "cgjX\x1b"].map((keys) => ({
    name: `${JSON.stringify(keys)}: exclusive end on empty logical line excludes newline`,
    initial: { text: "abcde\n\nrest", cursor: { line: 0, col: 2 } },
    keys: [...keys],
  })),
  {
    name: "count consumed after successful motion",
    initial: { text: `${long}\n${long}`, cursor: { line: 0, col: 1 } },
    keys: [..."2gjx"],
  },
  {
    name: "wide and combining graphemes keep screen column",
    initial: {
      text: `${"中e\u0301".repeat(20)}\n${long}`,
      cursor: { line: 0, col: 3 },
    },
    keys: [..."gjgjgk"],
  },
];

describe("nvim parity display-line motions (wrap, 20 text columns)", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await assertMatchesNvim({ ...testCase, displayWidth: 20 });
    });
  }
});
