/**
 * Live job output from the server hub (`/jobs_u/live/{id}`), see
 * backend/windmill-common/src/live_logs.rs. A `log` event's `offset` counts code
 * points of the job's whole stored log, so anything the live stream skipped is
 * read back from that stored log.
 */
import { getHeaders } from "./utils.ts";
import { detectAuthGatewayChallenge } from "./http_guards.ts";

export type LiveEvent =
  | {
    type: "start";
    job: string;
    parent?: string | null;
    root: string;
    step?: string | null;
    path?: string | null;
    kind: string;
    worker?: string | null;
    hostname?: string | null;
  }
  | { type: "log"; job: string; offset: number; text: string }
  | { type: "gap"; job: string }
  | { type: "progress"; job: string; percent: number }
  | { type: "flow_changed"; flow: string }
  | { type: "end"; job: string; success: boolean | null }
  | { type: "lagged" };

export class LiveUnavailable extends Error {}

export async function* liveEvents(
  workspace: string,
  id: string,
  signal: AbortSignal,
): AsyncGenerator<LiveEvent> {
  const { OpenAPI } = await import("../../gen/index.ts");
  const url = `${OpenAPI.BASE}/w/${workspace}/jobs_u/live/${id}`;
  const response = await fetch(url, {
    signal,
    headers: {
      ...getHeaders(),
      Accept: "text/event-stream",
      Authorization: `Bearer ${OpenAPI.TOKEN}`,
    },
  });
  await detectAuthGatewayChallenge(response, url);
  if (!response.ok || !response.body) {
    throw new LiveUnavailable(`${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6)) as LiveEvent;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) {
    n++;
  }
  return n;
}

/** `s` from code point `from` up to (excluding) code point `to`. */
export function sliceCodePoints(s: string, from: number, to = Infinity): string {
  let i = 0;
  let start = s.length;
  let end = s.length;
  let unit = 0;
  for (const ch of s) {
    if (i === from) {
      start = unit;
    }
    if (i === to) {
      end = unit;
      break;
    }
    unit += ch.length;
    i++;
  }
  return start >= end ? "" : s.slice(start, end);
}

/**
 * Writes one job's log in order, exactly once, from live chunks and from the
 * stored log for whatever the chunks do not cover.
 */
export class LogPrinter {
  printed = 0;

  constructor(
    private write: (s: string) => void,
    private readStored: () => Promise<string>,
    private settleMs = 6000,
  ) {}

  async chunk(offset: number, text: string) {
    if (offset > this.printed) {
      await this.backfill(offset);
    }
    if (offset > this.printed) {
      this.write(
        `\n--- ${offset - this.printed} characters not stored yet; \`wmill job logs\` has them ---\n`,
      );
      this.printed = offset;
    }
    const end = offset + codePoints(text);
    if (end <= this.printed) {
      return;
    }
    this.write(
      offset < this.printed ? sliceCodePoints(text, this.printed - offset) : text,
    );
    this.printed = end;
  }

  /**
   * Print the stored log up to `upTo` (all of it when omitted). Live chunks run
   * ahead of the batched database write, so a range the store does not hold yet
   * is retried until the worker's longest batching delay has passed.
   */
  async backfill(upTo?: number) {
    const deadline = Date.now() + (upTo === undefined ? 0 : this.settleMs);
    while (true) {
      const stored = await this.readStored();
      const have = codePoints(stored);
      const to = upTo === undefined ? have : Math.min(upTo, have);
      if (to > this.printed) {
        this.write(sliceCodePoints(stored, this.printed, to));
        this.printed = to;
      }
      if (upTo === undefined || this.printed >= upTo || Date.now() >= deadline) {
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
