/**
 * Terminal column arithmetic for redrawing a region in place: a line that wraps
 * occupies two rows, so every line drawn must fit the width as the terminal
 * counts it, not as String.length does.
 */

// deno-lint-ignore no-control-regex
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// deno-lint-ignore no-control-regex
const SGR = /^\x1b\[[0-9;]*m/;

const ZERO_WIDTH: [number, number][] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) {
      hi = mid - 1;
    } else if (cp > b) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** Columns a single code point takes. */
export function charColumns(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || inRanges(cp, ZERO_WIDTH)) {
    return 0;
  }
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** Columns `s` takes on screen, its escape sequences taking none. */
export function columns(s: string): number {
  let n = 0;
  for (const ch of s.replace(ESCAPE, "")) {
    n += charColumns(ch.codePointAt(0)!);
  }
  return n;
}

/**
 * A line of program output made safe to draw inside a region: what a carriage
 * return overwrote is dropped, escape sequences (colours and cursor moves alike)
 * are removed, tabs are expanded to 8-column stops, and other control
 * characters go.
 */
export function plainLine(line: string): string {
  const afterCr = line.slice(line.lastIndexOf("\r") + 1);
  let out = "";
  let col = 0;
  for (const ch of afterCr.replace(ESCAPE, "")) {
    if (ch === "\t") {
      const pad = 8 - (col % 8);
      out += " ".repeat(pad);
      col += pad;
      continue;
    }
    const w = charColumns(ch.codePointAt(0)!);
    if (w === 0 && ch.codePointAt(0)! < 0x20) {
      continue;
    }
    out += ch;
    col += w;
  }
  return out;
}

/**
 * `s` cut to at most `width` columns, ending in `…` when cut. Colour codes pass
 * through without counting, and a cut line resets colour so it cannot bleed.
 */
export function fitColumns(s: string, width: number): string {
  if (columns(s) <= width) {
    return s;
  }
  let out = "";
  let used = 0;
  let i = 0;
  while (i < s.length) {
    const sgr = SGR.exec(s.slice(i));
    if (sgr) {
      out += sgr[0];
      i += sgr[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charColumns(cp);
    if (used + w > width - 1) {
      break;
    }
    out += ch;
    used += w;
    i += ch.length;
  }
  return out + "…\x1b[0m";
}
