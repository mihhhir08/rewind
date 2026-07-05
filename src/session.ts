import { createHybridIo, createRecordingIo, createReplayIo, type IoFn } from "./io.js";
import { Journal, type RunId } from "./journal.js";
import { createRecordingFetch } from "./record.js";
import { createHybridFetch, createReplayFetch } from "./replay.js";

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
  /** strict (default): any miss throws ReplayMissError, zero network.
   * hybrid: misses fall through to the live API; everything served (hits AND
   * live fallbacks) is journaled into a NEW run, so the session's runId is a
   * child run that itself replays offline under strict. */
  policy?: "strict" | "hybrid";
  /** Label for the new run created by hybrid replay. */
  label?: string;
  /** Upstream transport for hybrid misses; defaults to global fetch. */
  base?: typeof fetch;
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
    if (process.env["REWIND_POLICY"] === "hybrid") {
      const session = replay({
        journal,
        run,
        policy: "hybrid",
        ...(defaults.base !== undefined ? { base: defaults.base } : {}),
      });
      console.error(`[rewind] hybrid replay of ${run} — recording into new run ${session.runId}`);
      return session;
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
  if (opts.policy === "hybrid") {
    const runId = journal.createRun({
      parentRunId: opts.run,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    });
    return {
      mode: "replay",
      runId,
      fetch: createHybridFetch(journal, opts.run, runId, opts.base ?? fetch),
      io: createHybridIo(journal, journal.eventsForRun(opts.run), runId),
      finish: () => journal.close(),
    };
  }
  return {
    mode: "replay",
    runId: opts.run,
    fetch: createReplayFetch(journal, opts.run, { policy: "strict" }),
    io: createReplayIo(journal.eventsForRun(opts.run)),
    finish: () => journal.close(),
  };
}
