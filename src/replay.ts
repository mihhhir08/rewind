import { fingerprint } from "./canonical.js";
import { decodeResponseEnvelope, envelopeToResponse } from "./envelope.js";
import type { Journal, JournalEvent, RunId } from "./journal.js";
import { requestFromFetchArgs } from "./record.js";

export interface ReplayFetchOptions {
  policy: "strict";
}

export class ReplayMissError extends Error {
  constructor(
    readonly fingerprint: string,
    readonly requestPreview: { url: string; method: string; bodyPreview: string | null },
    detail: string,
  ) {
    super(
      `[rewind] replay miss under strict policy: no unconsumed recorded response matches this request.\n` +
        `  ${requestPreview.method} ${requestPreview.url}\n` +
        `  fingerprint: ${fingerprint}\n` +
        `  ${detail}\n` +
        `  Either the agent diverged from the recorded run, or a semantic header/body changed. ` +
        `Use hybrid policy to fall through to the live API.`,
    );
    this.name = "ReplayMissError";
  }
}

/** Per-fingerprint FIFO cursors over a run's recorded LLM events. */
export class EventCursor {
  private readonly queues = new Map<string, JournalEvent[]>();
  private readonly total: number;

  constructor(events: JournalEvent[], kind: "llm_call" | "io") {
    const filtered = events.filter((e) => e.kind === kind);
    this.total = filtered.length;
    for (const e of filtered) {
      const q = this.queues.get(e.fingerprint);
      if (q) q.push(e);
      else this.queues.set(e.fingerprint, [e]);
    }
    // Queues are FIFO by ARRIVAL order, not completion (seq) order: when
    // identical requests raced during record, each replaying caller must get
    // the response its position originally received, or transcripts diverge.
    const arrivalOf = (e: JournalEvent): number =>
      typeof e.meta["arrivalIndex"] === "number" ? (e.meta["arrivalIndex"] as number) : e.seq;
    for (const q of this.queues.values()) q.sort((a, b) => arrivalOf(a) - arrivalOf(b));
  }

  next(fp: string): JournalEvent | undefined {
    return this.queues.get(fp)?.shift();
  }

  describeMiss(fp: string): string {
    if (this.queues.get(fp)?.length === 0) {
      return "This exact request WAS recorded, but all recorded copies have already been replayed (the agent is calling it more times than the recording did).";
    }
    return `Recorded run contains ${this.total} events of this kind; none match this fingerprint${
      this.queues.size > 0 ? ` (${this.queues.size} distinct fingerprints recorded)` : ""
    }.`;
  }
}

export function createReplayFetch(journal: Journal, run: RunId, _opts: ReplayFetchOptions): typeof fetch {
  const cursor = new EventCursor(journal.eventsForRun(run), "llm_call");

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record = await requestFromFetchArgs(input, init);
    const fp = fingerprint(record);
    const event = cursor.next(fp);
    if (!event) {
      throw new ReplayMissError(
        fp,
        {
          url: record.url,
          method: record.method,
          bodyPreview: record.body === null ? null : record.body.slice(0, 200),
        },
        cursor.describeMiss(fp),
      );
    }
    return envelopeToResponse(decodeResponseEnvelope(event.response));
  }) as typeof fetch;
}
