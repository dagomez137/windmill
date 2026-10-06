import { expect, test } from "bun:test";
import { columns, fitColumns, plainLine } from "../src/utils/term_width.ts";

test("columns count what the terminal draws", () => {
  expect(columns("abc")).toBe(3);
  expect(columns("\x1b[36mabc\x1b[39m")).toBe(3);
  expect(columns("日本")).toBe(4);
  expect(columns("é")).toBe(1);
  expect(columns("█│▪·▸✓")).toBe(6);
});

test("a fitted line never exceeds the width and resets colour", () => {
  const s = "\x1b[36m" + "x".repeat(50) + "\x1b[39m";
  const f = fitColumns(s, 20);
  expect(columns(f)).toBe(20);
  expect(f.endsWith("…\x1b[0m")).toBe(true);
  expect(fitColumns("short", 20)).toBe("short");
  expect(columns(fitColumns("日本語のテキスト", 7))).toBeLessThanOrEqual(7);
});

test("program output is made drawable: \\r, escapes, tabs, controls", () => {
  expect(plainLine("50%\r100% done")).toBe("100% done");
  expect(plainLine("\x1b[31mred\x1b[0m \x1b[2Kok")).toBe("red ok");
  expect(plainLine("a\tb")).toBe("a       b");
  expect(plainLine("x\x07y")).toBe("xy");
});
