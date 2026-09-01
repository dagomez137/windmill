import { expect, test } from "bun:test";
import {
  isLogGap,
  logOrigin,
  nextLogOffset,
} from "../src/commands/script/script.ts";

test("resumes from the offset the server reports, not from what was printed", () => {
  // 752 characters that end at 16201: a reader that advances by their length
  // stays 15449 behind, and every later request is clamped back to this tail.
  expect(nextLogOffset(0, { new_logs: "x".repeat(752), log_offset: 16201 }))
    .toBe(16201);
});

test("falls back to counting when the server reports no offset", () => {
  expect(nextLogOffset(100, { new_logs: "abcde" })).toBe(105);
  expect(nextLogOffset(100, {})).toBe(100);
});

test("a chunk is a gap only when it starts past what was printed", () => {
  expect(isLogGap(100, 50, 150)).toBe(false);
  expect(isLogGap(1800, 752, 15679)).toBe(true);
});

test("the log does not begin at zero, so a first chunk is never a gap", () => {
  // A 32-character log is answered as ending at 33: it occupies [1, 33).
  const origin = logOrigin(32, 33);
  expect(origin).toBe(1);
  expect(isLogGap(origin, 32, 33)).toBe(false);
});
