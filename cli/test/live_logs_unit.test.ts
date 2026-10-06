import { expect, test } from "bun:test";
import {
  codePoints,
  LogPrinter,
  sliceCodePoints,
} from "../src/utils/live_logs.ts";

function printer(stored: () => string) {
  let out = "";
  const p = new LogPrinter((s) => (out += s), async () => stored(), 0);
  return { p, out: () => out };
}

// Offsets are Postgres `char_length` positions: an emoji is one, not two.
test("code point helpers count and slice like Postgres", () => {
  const s = "a😀b\nc";
  expect(codePoints(s)).toBe(5);
  expect(sliceCodePoints(s, 1, 3)).toBe("😀b");
  expect(sliceCodePoints(s, 2)).toBe("b\nc");
  expect(sliceCodePoints(s, 5)).toBe("");
});

test("live chunks print in order, once, with the stored head first", async () => {
  const { p, out } = printer(() => "head\nline1");
  await p.chunk(5, "line1");
  await p.chunk(5, "line1");
  await p.chunk(10, "\nline2");
  expect(out()).toBe("head\nline1\nline2");
  expect(p.printed).toBe(16);
});

test("a gap is filled from the stored log", async () => {
  const stored = "\na\nb\nc";
  const { p, out } = printer(() => stored);
  await p.chunk(0, "\na");
  await p.chunk(4, "\nc");
  expect(out()).toBe(stored);
});

test("an overlapping chunk prints only its new part", async () => {
  const { p, out } = printer(() => "");
  await p.chunk(0, "abc");
  await p.chunk(1, "bcdé");
  expect(out()).toBe("abcdé");
  expect(p.printed).toBe(5);
});

test("a hole the store cannot fill is marked, not skipped silently", async () => {
  const { p, out } = printer(() => "ab");
  await p.chunk(0, "ab");
  await p.chunk(5, "z");
  expect(out()).toContain("3 characters not stored yet");
  expect(out().endsWith("z")).toBe(true);
});

test("the final backfill prints whatever followed the last chunk", async () => {
  const { p, out } = printer(() => "x\ny\nJob result: ok");
  await p.chunk(0, "x\ny");
  await p.backfill();
  expect(out()).toBe("x\ny\nJob result: ok");
});
