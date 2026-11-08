import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  createMultiLineEditor,
  sendKeys,
  setInternalCursor,
} from "./harness.js";

// The buffer oracle cannot snapshot a live cmdline after feedkeys returns.
// An expression mapping samples it in command mode, then returns no text.
// Only seed with histadd: unknown/Pi commands must not execute inside nvim.
const DRIVER = [
  "local input = vim.json.decode(vim.env.PI_VIM_EX_SCENARIO)",
  "vim.o.history = 100",
  "vim.api.nvim_buf_set_lines(0, 0, -1, true, {'prompt', 'second'})",
  "vim.api.nvim_win_set_cursor(0, {1, 2})",
  "vim.fn.setreg('\"', 'keep\\n', 'V')",
  "for _, line in ipairs(input.history) do vim.fn.histadd(':', line) end",
  "if input.canceled then vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(':' .. input.canceled .. '<Esc>', true, false, true), 'xt', false) end",
  "local snapshots = {}",
  "vim.keymap.set('c', '<F12>', function() local cursor = vim.api.nvim_win_get_cursor(0); table.insert(snapshots, {line = vim.fn.getcmdline(), position = vim.fn.getcmdpos(), text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, true), '\\n'), cursor = {line = cursor[1] - 1, col = cursor[2]}, mode = vim.api.nvim_get_mode().mode, register = vim.fn.getreg('\"')}); return '' end, {expr = true})",
  "local keys = ':' .. table.concat(input.keys, '<F12>') .. '<F12><C-c>'",
  "vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(keys, true, false, true), 'xt', false)",
  "print('PI_VIM_EX_RESULT:' .. vim.json.encode(snapshots))",
  "vim.cmd('qa!')",
].join("; ");

const KEYS: Record<string, string> = {
  "<C-p>": "\x10",
  "<C-n>": "\x0e",
  "<BS>": "\x7f",
};

type Case = {
  name: string;
  history: string[];
  keys: string[];
  lines: string[];
  canceled?: string;
  // Intentional divergences: edits become a fresh draft in pi-vim, and canceled
  // lines are excluded. Nvim keeps the old browse position and canceled lines.
  nvimLines?: string[];
};
const CASES: Case[] = [
  {
    name: "empty history",
    history: [],
    keys: ["<C-p>", "<C-n>"],
    lines: ["", ""],
  },
  {
    name: "empty history with draft",
    history: [],
    keys: ["x", "<C-p>", "<C-n>"],
    lines: ["x", "x", "x"],
  },
  {
    name: "oldest clamp and empty draft restoration",
    history: ["a", "b"],
    keys: ["<C-p>", "<C-p>", "<C-p>", "<C-n>", "<C-n>", "<C-n>"],
    lines: ["b", "a", "a", "b", "", ""],
  },
  {
    name: "typed draft restoration without prefix matching",
    history: ["a", "b"],
    keys: ["x", "<C-p>", "<C-n>", "<C-p>"],
    lines: ["x", "b", "x", "b"],
  },
  {
    name: "newer at a fresh draft does not browse",
    history: ["a", "b"],
    keys: ["x", "<C-n>"],
    lines: ["x", "x"],
  },
  {
    name: "duplicate promotion retains one copy",
    history: ["a", "b", "c", "b", "b"],
    keys: ["<C-p>", "<C-p>", "<C-p>", "<C-p>"],
    lines: ["b", "c", "a", "a"],
  },
  {
    name: "intentional divergence: append after recall resets browsing",
    history: ["a", "b"],
    keys: ["x", "<C-p>", "<C-p>", "z", "<C-n>", "<C-p>", "<C-n>"],
    lines: ["x", "b", "a", "az", "az", "b", "az"],
    nvimLines: ["x", "b", "a", "az", "b", "a", "b"],
  },
  {
    name: "intentional divergence: backspace after recall resets browsing",
    history: ["alpha", "beta"],
    keys: ["<C-p>", "<C-p>", "<BS>", "<C-n>", "<C-p>", "<C-n>"],
    lines: ["beta", "alpha", "alph", "alph", "beta", "alph"],
    nvimLines: ["beta", "alpha", "alph", "beta", "alpha", "beta"],
  },
  {
    name: "intentional divergence: canceled lines are not recorded",
    history: ["a", "b"],
    canceled: "canceled",
    keys: ["<C-p>", "<C-p>"],
    lines: ["b", "a"],
    nvimLines: ["canceled", "b"],
  },
  {
    name: "verbatim leading/trailing whitespace",
    history: [" name x ", "  "],
    keys: ["<C-p>", "<C-p>"],
    lines: ["  ", " name x "],
  },
  {
    name: "Unicode recall cursor is at end",
    history: ["name é👩‍💻中"],
    keys: ["x", "<C-p>", "<C-n>"],
    lines: ["x", "name é👩‍💻中", "x"],
  },
  {
    name: "cap drops the oldest entry",
    history: Array.from({ length: 101 }, (_, i) => String(i)),
    keys: Array.from({ length: 101 }, () => "<C-p>"),
    lines: [...Array.from({ length: 100 }, (_, i) => String(100 - i)), "1"],
  },
];

describe("nvim parity: EX command-line history", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const { editor } = createMultiLineEditor("prompt\nsecond");
      editor.setRegister("keep\n");
      setInternalCursor(editor, 2);
      for (const line of testCase.history) sendKeys(editor, [":", line, "\r"]);
      if (testCase.canceled) sendKeys(editor, [":", testCase.canceled, "\x1b"]);
      editor.handleInput(":");
      const pi = testCase.keys.map((key, index) => {
        editor.handleInput(KEYS[key] ?? key);
        const line = testCase.lines[index];
        assert.ok(editor.render(120).at(-1)?.endsWith(` EX :${line}_ `));
        assert.equal(editor.getMode(), "normal");
        return {
          line,
          position: Buffer.byteLength(line) + 1,
          text: editor.getText(),
          cursor: editor.getCursor(),
          mode: "c",
          register: editor.getRegister(),
        };
      });
      const child = spawnSync(
        "nvim",
        [
          "--clean",
          "--headless",
          "-n",
          "-i",
          "NONE",
          "-u",
          "NONE",
          "-c",
          `lua ${DRIVER}`,
        ],
        {
          env: { ...process.env, PI_VIM_EX_SCENARIO: JSON.stringify(testCase) },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      const output = `${child.stdout}\n${child.stderr}`;
      const prefix = "PI_VIM_EX_RESULT:";
      const start = output.indexOf(prefix);
      assert.notEqual(start, -1, output);
      const nvim: unknown = JSON.parse(
        output.slice(start + prefix.length).split(/\r?\n/)[0],
      );
      const nvimLines = testCase.nvimLines;
      const expectedNvim = nvimLines
        ? pi.map((snapshot, index) => ({
            ...snapshot,
            line: nvimLines[index],
            position: Buffer.byteLength(nvimLines[index]) + 1,
          }))
        : pi;
      assert.deepEqual(nvim, expectedNvim);
    });
  }
});
