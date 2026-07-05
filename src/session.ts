import { createRecordingIo, createReplayIo, type IoFn } from "./io.js";
import { Journal, type RunId } from "./journal.js";
import { createRecordingFetch } from "./record.js";
import { createReplayFetch } from "./replay.js";

export interface Session {
  mode: "record" | "replay";
  runId: RunId;
  fetch: typeof fetch;
  io: IoFn;
  /** Flush and close the journal. Call when the run is finished. */
  finish: () => void;
}

export interface RecordOptions {
  /** Path to the journal database (created if missing). */
  journal: string;
  label?: string;
  /** Upstream transport; defaults to global fetch. */
  base?: typeof fetch;
}

export function record(opts: RecordOptions): Session {
  const journal = Journal.open(opts.journal);
  const runId = journal.createRun(opts.label === undefined ? {} : { label: opts.label });
  return {
    mode: "record",
    runId,
    fetch: createRecordingFetch(journal, runId, opts.base ?? fetch),
    io: createRecordingIo(journal, runId),
    finish: () => journal.close(),
  };
}

export interface ReplayOptions {
  journal: string;
  run: RunId;
}

export function replay(opts: ReplayOptions): Session {
  const journal = Journal.open(opts.journal);
  return {
    mode: "replay",
    runId: opts.run,
    fetch: createReplayFetch(journal, opts.run, { policy: "strict" }),
    io: createReplayIo(journal.eventsForRun(opts.run)),
    finish: () => journal.close(),
  };
}
