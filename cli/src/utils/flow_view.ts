/**
 * Terminal view of a flow run: a fixed region, redrawn in place as BitBake's
 * knotty redraws its footer, holding one progress bar with a slot per step of
 * the flow (subflows flattened, as the run page's bar has a slot per module), the
 * running step with its worker and host, and a window onto that step's output.
 * It is driven by the root flow's live channel (`start`, `log`, `progress`,
 * `end`, `flow_changed`), so nothing polls per step. The logs stay where
 * Windmill stores them: the view names the `wmill job logs` command for the flow
 * and for each step, and prints a failed step's tail at the end.
 */
import { colors } from "@cliffy/ansi/colors";
import * as wmill from "../../gen/services.gen.ts";
import { LiveEvent, liveEvents, LogPrinter } from "./live_logs.ts";
import { columns, fitColumns, plainLine } from "./term_width.ts";

const TAIL_LINES = 200;
const FAILED_TAIL = 10;
const REDRAW_MS = 50;
const SKIPPED_KIND = "identity";
// A running flow whose workers publish nothing is followed the old way.
const NO_EVENTS_MS = 10_000;
const SEP = " › ";
// Header, slot bar, step, worker, and the output window's title or the keys.
const REGION_FIXED = 5;

export type StepStatus =
  | "pending"
  | "running"
  | "ok"
  | "failed"
  | "skipped"
  // A failed attempt the flow retried; only the last attempt counts.
  | "retried";

export type Step = {
  job: string;
  parent: string | null;
  step: string;
  kind: string;
  worker?: string | null;
  hostname?: string | null;
  status: StepStatus;
  started: number;
  ended?: number;
  progress?: number;
  attempt: number;
  tail: string[];
  partial: string;
};

/** One slot of the bar: a step of the flow definition, keyed by its path. */
export type Slot = { key: string; group: string; status: StepStatus };

/**
 * The slots of a flow, in order. A subflow contributes its own steps; a branch
 * or a loop is one slot, since which branch runs and how often is only known
 * at run time.
 */
export async function planSlots(
  modules: any[],
  subflow: (path: string) => Promise<any[]>,
  prefix = "",
  group = "",
): Promise<Slot[]> {
  const slots: Slot[] = [];
  for (const m of modules ?? []) {
    const key = prefix ? `${prefix}${SEP}${m.id}` : m.id;
    const g = group || m.id;
    if (m.value?.type === "flow" && m.value.path) {
      const inner = await subflow(m.value.path).catch(() => undefined);
      if (inner?.length) {
        slots.push(...(await planSlots(inner, subflow, key, g)));
        continue;
      }
    }
    slots.push({ key, group: g, status: "pending" });
  }
  return slots;
}

/** The slot a step's path belongs to: itself, or the branch or loop holding it. */
export function slotFor(slots: Slot[], label: string): Slot | undefined {
  let best: Slot | undefined;
  for (const s of slots) {
    if (
      (label === s.key || label.startsWith(s.key + SEP)) &&
      (!best || s.key.length > best.key.length)
    ) {
      best = s;
    }
  }
  return best;
}

/** The run as the events have described it so far; no I/O. */
export class FlowRun {
  steps = new Map<string, Step>();

  constructor(public root: string) {}

  start(ev: Extract<LiveEvent, { type: "start" }>, now: number): Step {
    const step = ev.step ?? ev.path ?? ev.job.slice(0, 8);
    const parent = ev.parent ?? null;
    let attempt = 1;
    for (const prev of this.steps.values()) {
      if (prev.parent === parent && prev.step === step && prev.status === "failed") {
        prev.status = "retried";
        attempt = Math.max(attempt, prev.attempt + 1);
      }
    }
    const s: Step = {
      job: ev.job,
      parent,
      step,
      kind: ev.kind,
      worker: ev.worker,
      hostname: ev.hostname,
      status: ev.kind === SKIPPED_KIND ? "skipped" : "running",
      started: now,
      attempt,
      tail: [],
      partial: "",
    };
    this.steps.set(ev.job, s);
    return s;
  }

  /** Complete lines of `text`, carrying a trailing partial line to the next call. */
  output(job: string, text: string): string[] {
    const s = this.steps.get(job);
    if (!s) {
      return [];
    }
    const parts = (s.partial + text).split("\n");
    s.partial = parts.pop() ?? "";
    const lines = parts.filter((l) => l.length > 0);
    s.tail.push(...lines);
    if (s.tail.length > TAIL_LINES) {
      s.tail.splice(0, s.tail.length - TAIL_LINES);
    }
    return lines;
  }

  end(job: string, success: boolean | null, now: number): Step | undefined {
    const s = this.steps.get(job);
    if (!s) {
      return undefined;
    }
    if (s.partial) {
      this.output(job, "\n");
    }
    s.ended = now;
    if (s.status !== "skipped") {
      s.status = success === false ? "failed" : "ok";
    }
    return s;
  }

  running(): Step[] {
    return [...this.steps.values()].filter((s) => s.status === "running");
  }

  count(status: StepStatus): number {
    let n = 0;
    for (const s of this.steps.values()) {
      if (s.status === status) {
        n++;
      }
    }
    return n;
  }
}

/**
 * The last `n` lines of a log, with a command echoed across `\`-continued lines
 * (the step runners' `+ cmd \` form) joined back into one line, so a window of
 * one line shows the command rather than its last argument.
 */
export function windowLines(tail: string[], n: number): string[] {
  const joined: string[] = [];
  for (const line of tail) {
    const prev = joined.length ? joined[joined.length - 1] : undefined;
    if (prev !== undefined && prev.endsWith("\\")) {
      joined[joined.length - 1] = prev.slice(0, -1).trimEnd() + " " + line.trim();
    } else {
      joined.push(line);
    }
  }
  return joined.slice(-n);
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function bar(percent: number, width = 10): string {
  const full = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
  return "|" + "█".repeat(full) + " ".repeat(width - full) + "|";
}

// When several slots share a cell, the cell shows the one that matters most.
const SLOT_RANK: StepStatus[] = ["failed", "running", "retried", "pending", "ok", "skipped"];

/**
 * The slot bar in at most `width` columns: one cell per slot with a divider
 * between top-level steps, dividers dropped when they do not fit, and slots
 * sharing cells when even that does not.
 */
export function slotBar(slots: Slot[], paint = true, width = Infinity): string {
  const groups = new Set(slots.map((s) => s.group)).size;
  if (slots.length + Math.max(0, groups - 1) <= width) {
    return slotCells(slots, paint, true);
  }
  if (slots.length <= width) {
    return slotCells(slots, paint, false);
  }
  const per = Math.ceil(slots.length / Math.max(1, width));
  const merged: Slot[] = [];
  for (let i = 0; i < slots.length; i += per) {
    const chunk = slots.slice(i, i + per);
    const status = SLOT_RANK.find((r) => chunk.some((c) => c.status === r)) ?? "pending";
    merged.push({ key: chunk[0].key, group: "", status });
  }
  return slotCells(merged, paint, false);
}

function slotCells(slots: Slot[], paint: boolean, dividers: boolean): string {
  const cell: Record<StepStatus, [string, (s: string) => string]> = {
    ok: ["█", colors.green],
    skipped: ["▪", colors.dim],
    running: ["▓", colors.cyan],
    failed: ["█", colors.red],
    pending: ["·", colors.dim],
    retried: ["▓", colors.yellow],
  };
  let out = "";
  let group: string | undefined;
  for (const s of slots) {
    if (dividers && group !== undefined && s.group !== group) {
      out += paint ? colors.dim("│") : "│";
    }
    group = s.group;
    const [ch, color] = cell[s.status];
    out += paint ? color(ch) : ch;
  }
  return out;
}


/** Labels a step by its path from the root, `build_kernel › fetch_devel`. */
class Labels {
  private prefixes = new Map<string, Promise<string>>();

  constructor(private workspace: string, private root: string) {}

  prefix(flow: string | null): Promise<string> {
    if (!flow || flow === this.root) {
      return Promise.resolve("");
    }
    let p = this.prefixes.get(flow);
    if (!p) {
      p = wmill.getJob({ workspace: this.workspace, id: flow }).then(
        async (j: any) => {
          const up = await this.prefix(j.parent_job ?? null);
          const own = j.flow_step_id ?? flow.slice(0, 8);
          return up ? `${up}${SEP}${own}` : own;
        },
        () => flow.slice(0, 8),
      );
      this.prefixes.set(flow, p);
    }
    return p;
  }

  async of(s: Step): Promise<string> {
    const up = await this.prefix(s.parent);
    return up ? `${up}${SEP}${s.step}` : s.step;
  }
}

export type ViewOptions = {
  path: string;
  follow: boolean;
  interactive: boolean;
};

export type ViewResult = { success: boolean; result: unknown };

type Window = "line" | "lines" | "off";

function where(s: Step): string {
  if (!s.worker) {
    return "";
  }
  return s.hostname ? `${s.worker} @ ${s.hostname}` : s.worker;
}

/**
 * Follow a flow run in the terminal. Undefined, with nothing printed, when the
 * server has no live channel, so the caller can fall back to the step walker.
 */
export async function viewFlowRun(
  workspace: string,
  root: string,
  opts: ViewOptions,
): Promise<ViewResult | undefined> {
  const run = new FlowRun(root);
  const labels = new Labels(workspace, root);
  const label = new Map<string, string>();
  const printers = new Map<string, LogPrinter>();
  const t0 = Date.now();
  const out = process.stdout;
  let follow = opts.follow;
  let window: Window = "line";
  let windowSize = 10;
  let dirty = true;
  // The step the window shows: the running one, else the last that ran.
  let focus: Step | undefined;

  let slots: Slot[] = [];
  try {
    const job: any = await wmill.getJob({ workspace, id: root });
    slots = await planSlots(job.raw_flow?.modules ?? [], async (path) =>
      ((await wmill.getFlowByPath({ workspace, path })) as any).value?.modules ?? []
    );
  } catch {
    // No plan: slots are added as steps start.
  }
  // Only a resolved label places a step: its bare name would match no slot.
  const slotOf = (s: Step): Slot | undefined => {
    const l = label.get(s.job);
    return l === undefined ? undefined : slotFor(slots, l);
  };
  const setSlot = (s: Step) => {
    let slot = slotOf(s);
    if (!slot) {
      const l = label.get(s.job) ?? s.step;
      slot = { key: l, group: l.split(SEP)[0], status: "pending" };
      slots.push(slot);
    }
    // A branch or loop slot holds several jobs: running wins, then failure.
    if (s.status === "running" || slot.status !== "failed") {
      slot.status = s.status;
    }
    dirty = true;
  };

  // The region's height depends only on the window setting, never on the run's
  // state, so a redraw never shifts what is under it. Its rows are tracked, not
  // its lines: after a resize the terminal re-wraps what is already drawn.
  const write = out.write.bind(out);
  let drawn: number[] = [];
  let regionRows = 0;
  const clearRegion = () => {
    if (opts.interactive && regionRows > 0) {
      write(`\x1b[${regionRows}A\x1b[J`);
    }
    regionRows = 0;
    drawn = [];
  };
  const above = (text: string) => {
    clearRegion();
    write(text.endsWith("\n") ? text : text + "\n");
    dirty = true;
  };
  const keys = () =>
    `[w] ${window === "line" ? `${windowSize} lines` : window === "lines" ? "hide" : "show output"}` +
    (window === "lines" ? "  [+/-] size" : "") +
    `  [l] ${follow ? "stop following" : "follow"}  [q] detach`;
  const windowRows = () => {
    const rows = out.rows || 40;
    if (window === "off") {
      return 0;
    }
    return window === "line" ? 1 : Math.max(1, Math.min(windowSize, rows - REGION_FIXED - 1));
  };
  const drawRegion = () => {
    if (!opts.interactive || !dirty) {
      return;
    }
    dirty = false;
    const width = Math.max(10, (out.columns || 100) - 1);
    const now = Date.now();
    const total = slots.length;
    const finished = slots.filter((s) => s.status !== "pending" && s.status !== "running").length;
    const failed = run.count("failed");
    const lines: string[] = [];
    lines.push(
      `${colors.bold(opts.path)}  ${colors.dim(root)}   ` +
        `${duration(now - t0)}   ${colors.green(`✓ ${run.count("ok")}`)}  ` +
        `${colors.dim(`⊘ ${run.count("skipped")}`)}` +
        (failed ? `  ${colors.red(`✗ ${failed}`)}` : ""),
    );
    const count = `  ${finished}/${total}`;
    lines.push(slotBar(slots, true, width - count.length) + count);
    const cur = run.running()[0];
    focus = cur ?? focus;
    // Between steps the last one stays on screen, so the region keeps its shape.
    const shown = cur ?? focus;
    if (shown) {
      const l = label.get(shown.job) ?? shown.step;
      const slot = slotOf(shown);
      const idx = slot ? slots.indexOf(slot) + 1 : 0;
      const attempt = shown.attempt > 1 ? ` (attempt ${shown.attempt})` : "";
      if (cur) {
        const pct = cur.progress !== undefined ? `   ${cur.progress}% ${bar(cur.progress)}` : "";
        lines.push(
          colors.cyan(`▸ [${idx}/${total}] ${l}${attempt}   ${duration(now - cur.started)}${pct}`),
        );
      } else {
        const mark = shown.status === "failed"
          ? colors.red("✗")
          : shown.status === "skipped"
          ? colors.dim("⊘")
          : colors.green("✓");
        lines.push(
          `${mark} [${idx}/${total}] ${l}${attempt}   ` +
            colors.dim(`${duration((shown.ended ?? now) - shown.started)}   waiting for the next step…`),
        );
      }
      const w = where(shown);
      lines.push(colors.dim(`  ${w ? `on ${w}   ` : ""}log: wmill job logs ${shown.job}`));
    } else {
      lines.push(colors.dim("  waiting for the first step…"));
      lines.push("");
    }
    const n = windowRows();
    if (n > 0) {
      lines.push(colors.dim(`┌ output ${"─".repeat(8)} ${keys()}`));
      const text = focus ? windowLines(focus.tail.map(plainLine), n) : [];
      for (let i = 0; i < n; i++) {
        lines.push(`│ ${text[i] ?? ""}`);
      }
    } else {
      lines.push(colors.dim(keys()));
    }
    const fitted = lines.map((l) => fitColumns(l, width));
    clearRegion();
    write(fitted.join("\n") + "\n");
    drawn = fitted.map((l) => columns(l));
    regionRows = drawn.length;
  };
  // A reflowing terminal re-wraps the drawn lines to the new width: clear as many
  // rows as they take now.
  const onResize = () => {
    const cols = Math.max(1, out.columns || 100);
    regionRows = drawn.reduce((n, w) => n + Math.max(1, Math.ceil(w / cols)), 0);
    dirty = true;
    drawRegion();
  };
  // Anything else written while the region is up (a warning, a log line) goes
  // above it, as `above` does, instead of over it.
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const guard = (orig: typeof process.stdout.write, stream: NodeJS.WriteStream) =>
    ((chunk: any, ...rest: any[]) => {
      clearRegion();
      dirty = true;
      return (orig as any).call(stream, chunk, ...rest);
    }) as typeof process.stdout.write;
  const release = () => {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    out.off("resize", onResize);
  };
  if (opts.interactive) {
    process.stdout.write = guard(outWrite, process.stdout);
    process.stderr.write = guard(errWrite, process.stderr);
    out.on("resize", onResize);
  }

  const printerFor = (s: Step) => {
    let p = printers.get(s.job);
    if (!p) {
      p = new LogPrinter(
        (text) => {
          for (const line of run.output(s.job, text)) {
            if (follow) {
              above(colors.dim(`${label.get(s.job) ?? s.step} | `) + line);
            }
          }
          dirty = true;
        },
        async () =>
          (await wmill.getJobLogs({
            workspace,
            id: s.job,
            removeAnsiWarnings: true,
          })) as unknown as string,
      );
      printers.set(s.job, p);
    }
    return p;
  };

  const abort = new AbortController();
  let completion: Promise<boolean> | undefined;
  const checkDone = () => {
    completion ??= wmill
      .getJob({ workspace, id: root })
      .then((j: any) => j.type === "CompletedJob", () => false)
      .then((isDone) => {
        completion = undefined;
        if (isDone) {
          abort.abort();
        }
        return isDone;
      });
    return completion;
  };

  const restoreInput = () => {
    if (opts.interactive && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };
  if (opts.interactive && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => {
      const k = key.toString();
      if (k === "l") {
        follow = !follow;
      } else if (k === "w") {
        window = window === "line" ? "lines" : window === "lines" ? "off" : "line";
      } else if (k === "+" || k === "=") {
        windowSize = Math.min(windowSize + 5, 200);
      } else if (k === "-") {
        windowSize = Math.max(windowSize - 5, 2);
      } else if (k === "q" || k === "\x03") {
        clearRegion();
        restoreInput();
        release();
        out.write(
          `Detached; flow ${root} keeps running. Its logs: wmill job logs ${root}\n`,
        );
        process.exit(130);
      }
      dirty = true;
    });
  }

  let sawAny = false;
  let noPublisher = false;
  const redraw = setInterval(drawRegion, REDRAW_MS);
  const tick = setInterval(() => {
    dirty = true;
    if (!sawAny && Date.now() - t0 > NO_EVENTS_MS) {
      noPublisher = true;
      abort.abort();
      return;
    }
    void checkDone();
  }, 5000);
  const timers = setInterval(() => (dirty = true), 1000);

  try {
    for await (const ev of liveEvents(workspace, root, abort.signal)) {
      sawAny = true;
      const now = Date.now();
      switch (ev.type) {
        case "start": {
          const s = run.start(ev, now);
          label.set(s.job, await labels.of(s));
          setSlot(s);
          if (!opts.interactive && s.status === "running") {
            const w = where(s);
            const slot = slotOf(s);
            const idx = slot ? slots.indexOf(slot) + 1 : 0;
            above(`▸ [${idx}/${slots.length}] ${label.get(s.job)}${w ? `  on ${w}` : ""}`);
          }
          break;
        }
        case "log": {
          const s = run.steps.get(ev.job);
          if (s) {
            await printerFor(s).chunk(ev.offset, ev.text);
          }
          break;
        }
        case "progress": {
          const s = run.steps.get(ev.job);
          if (s) {
            s.progress = ev.percent;
            dirty = true;
          }
          break;
        }
        case "end": {
          const s = run.end(ev.job, ev.success, now);
          if (s) {
            setSlot(s);
            if (!opts.interactive && s.status !== "skipped") {
              const mark = s.status === "failed" ? "✗" : "✓";
              above(
                `${mark} ${label.get(s.job)}  ${duration(now - s.started)}  ` +
                  colors.dim(`wmill job logs ${s.job}`),
              );
            }
          }
          break;
        }
        case "flow_changed":
          void checkDone();
          break;
      }
    }
  } catch {
    if (!abort.signal.aborted) {
      noPublisher = !sawAny;
    }
  } finally {
    clearInterval(redraw);
    clearInterval(tick);
    clearInterval(timers);
  }
  if (noPublisher) {
    clearRegion();
    restoreInput();
    release();
    return undefined;
  }

  // The flow can be seen finished before its last step's `end` arrives: settle
  // any step still running from its completed job.
  for (const s of run.running()) {
    const done = await wmill
      .getCompletedJob({ workspace, id: s.job })
      .catch(() => undefined);
    run.end(s.job, done?.success ?? null, Date.now());
    setSlot(s);
  }

  // A failed step's tail comes from its stored log, which now holds the error
  // its completion appended.
  for (const s of run.steps.values()) {
    if (s.status === "failed") {
      await printerFor(s).backfill().catch(() => {});
    }
  }
  const final = await wmill.getCompletedJob({ workspace, id: root });
  clearRegion();
  restoreInput();
  release();

  const failed = [...run.steps.values()].filter((s) => s.status === "failed");
  const finalCount = `  ${slots.filter((s) => s.status !== "pending").length}/${slots.length}`;
  const finalWidth = Math.max(10, (out.columns || 100) - 1) - finalCount.length;
  out.write(`${slotBar(slots, true, opts.interactive ? finalWidth : Infinity)}${finalCount}\n`);
  for (const s of failed) {
    const w = where(s);
    out.write(
      colors.red(
        `✗ ${label.get(s.job) ?? s.step}` +
          (s.attempt > 1 ? ` (attempt ${s.attempt})` : "") +
          `${w ? `  on ${w}` : ""}\n`,
      ),
    );
    // A script's exception is in its result, not its log.
    const done: any = await wmill
      .getCompletedJob({ workspace, id: s.job })
      .catch(() => undefined);
    const err = done?.result?.error;
    if (err?.message) {
      out.write(colors.red(`  ${err.name ? `${err.name}: ` : ""}${err.message}\n`));
    }
    for (const line of windowLines(s.tail.map(plainLine), FAILED_TAIL)) {
      out.write(colors.dim("  | ") + line + "\n");
    }
    out.write(colors.dim(`  log: wmill job logs ${s.job}\n`));
  }
  const summary =
    `${run.count("ok")} ran, ${run.count("skipped")} skipped` +
    (failed.length ? `, ${failed.length} failed` : "") +
    ` in ${duration(Date.now() - t0)}`;
  out.write(
    (final.success
      ? colors.green.bold("Flow ran to completion: ")
      : colors.red.bold("Flow failed: ")) + summary + "\n",
  );
  out.write(colors.dim(`Logs: wmill job logs ${root}\n`));
  return { success: final.success !== false, result: final.result };
}
