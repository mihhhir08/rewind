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

/** Session wired from the environment — the handshake used by the rewind CLI.
 * `rewind replay <run> -- <cmd>` sets REWIND_MODE/REWIND_RUN/REWIND_JOURNAL;
 * unwired environments fall back to a live recording session, so agent code
 * is written once and never branches on mode. */
export function fromEnv(defaults: { journal?: string; label?: string; base?: typeof fetch } = {}): Session {
  const journal = process.env["REWIND_JOURNAL"] ?? defaults.journal ?? "default.rewind.db";
  if (process.env["REWIND_MODE"] === "replay") {
    const run = process.env["REWIND_RUN"];
    if (run === undefined || run === "") {
      throw new Error("[rewind] REWIND_MODE=replay requires REWIND_RUN to be set");
    }
    return replay({ journal, run });
  }
  return record({
    journal,
    ...(defaults.label !== undefined ? { label: defaults.label } : {}),
    ...(defaults.base !== undefined ? { base: defaults.base } : {}),
  });
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
