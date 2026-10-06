import { expect, test } from "bun:test";
import {
  bar,
  duration,
  FlowRun,
  planSlots,
  slotBar,
  slotFor,
  windowLines,
} from "../src/utils/flow_view.ts";

const start = (run: FlowRun, job: string, kind = "script") =>
  run.start(
    { type: "start", job, parent: run.root, root: run.root, step: job, kind },
    0,
  );

test("a skipped module (an identity job) counts as skipped, not run", () => {
  const run = new FlowRun("root");
  start(run, "a");
  start(run, "b", "identity");
  run.end("a", true, 10);
  run.end("b", true, 11);
  expect(run.count("ok")).toBe(1);
  expect(run.count("skipped")).toBe(1);
  expect(run.running()).toEqual([]);
});

test("output splits into lines across chunks", () => {
  const run = new FlowRun("root");
  start(run, "a");
  expect(run.output("a", "\nfirst\nsec")).toEqual(["first"]);
  expect(run.output("a", "ond\n")).toEqual(["second"]);
});

test("the end flushes a partial last line and records failure", () => {
  const run = new FlowRun("root");
  start(run, "a");
  run.output("a", "\nerror: boom");
  const s = run.end("a", false, 5)!;
  expect(s.status).toBe("failed");
  expect(s.tail).toEqual(["error: boom"]);
});

// The step runners echo a command as `+ cmd \` continued over several lines; a
// one-line window must show the command, not its last argument.
test("the output window joins a backslash-continued command", () => {
  const tail = [
    "+ systemctl \\",
    "      --user \\",
    "      restart \\",
    "      qemu-system@rxarray",
    "started",
  ];
  expect(windowLines(tail, 1)).toEqual(["started"]);
  expect(windowLines(tail.slice(0, 4), 1)).toEqual([
    "+ systemctl --user restart qemu-system@rxarray",
  ]);
  expect(windowLines(tail, 5).length).toBe(2);
});

test("subflows flatten into slots; a branch is one slot", async () => {
  const flows: Record<string, any[]> = {
    "f/kernel/build": [
      { id: "prepare", value: { type: "script" } },
      { id: "configure", value: { type: "branchone" } },
      { id: "compile", value: { type: "script" } },
    ],
  };
  const slots = await planSlots(
    [
      { id: "resolve", value: { type: "script" } },
      { id: "build_kernel", value: { type: "flow", path: "f/kernel/build" } },
    ],
    async (p) => flows[p],
  );
  expect(slots.map((s) => s.key)).toEqual([
    "resolve",
    "build_kernel › prepare",
    "build_kernel › configure",
    "build_kernel › compile",
  ]);
  expect(slotFor(slots, "build_kernel › configure › configure_preset")?.key)
    .toBe("build_kernel › configure");
  slots[0].status = "ok";
  slots[1].status = "skipped";
  slots[2].status = "running";
  expect(slotBar(slots, false)).toBe("█│▪▓·");
});

test("durations and bars render compactly", () => {
  expect(duration(1500)).toBe("1.5s");
  expect(duration(125_000)).toBe("2:05");
  expect(bar(50, 4)).toBe("|██  |");
});

test("a retried step counts once, as its last attempt", () => {
  const run = new FlowRun("root");
  for (const job of ["a1", "a2", "a3"]) {
    run.start(
      { type: "start", job, parent: "root", root: "root", step: "prep", kind: "script" },
      0,
    );
    run.end(job, false, 1);
  }
  expect(run.count("failed")).toBe(1);
  expect(run.count("retried")).toBe(2);
  expect(run.steps.get("a3")!.attempt).toBe(3);
});

test("the slot bar fits a width: dividers go first, then slots share cells", () => {
  const slots = [
    { key: "a", group: "a", status: "ok" as const },
    { key: "b › x", group: "b", status: "running" as const },
    { key: "b › y", group: "b", status: "pending" as const },
    { key: "c", group: "c", status: "failed" as const },
  ];
  expect(slotBar(slots, false)).toBe("█│▓·│█");
  expect(slotBar(slots, false, 4)).toBe("█▓·█");
  expect(slotBar(slots, false, 2)).toBe("▓█");
});
