import { EventCursor } from "./replay.js";
import type { Journal, JournalEvent, RunId } from "./journal.js";

export type IoFn = <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;

type IoResult = { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };

const enc = new TextEncoder();
const dec = new TextDecoder();

function ioFingerprint(name: string): string {
  return `io:${name}`;
}

export class IoSerializationError extends Error {
  constructor(name: string, cause: unknown) {
    super(
      `[rewind] io("${name}") returned a value that cannot be JSON-serialized, so it cannot replay deterministically. ` +
        `Return plain data from io() wrappers. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "IoSerializationError";
  }
}

export function createRecordingIo(journal: Journal, run: RunId): IoFn {
  let arrival = 0;
  return <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const arrivalIndex = arrival;
    arrival += 1;
    return executeAndJournalIo(journal, run, name, fn, arrivalIndex);
  };
}

async function executeAndJournalIo<T>(
  journal: Journal,
  run: RunId,
  name: string,
  fn: () => T | Promise<T>,
  arrivalIndex: number,
): Promise<T> {
  const started = performance.now();
  let result: IoResult;
  let thrown: unknown;
  let didThrow = false;
  try {
    const value = await fn();
    result = { ok: true, value };
  } catch (err) {
    didThrow = true;
    thrown = err;
    const e = err instanceof Error ? err : new Error(String(err));
    result = { ok: false, error: { name: e.name, message: e.message } };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error("result serialized to undefined");
  } catch (cause) {
    throw new IoSerializationError(name, cause);
  }

  journal.appendEvent(run, {
    kind: "io",
    fingerprint: ioFingerprint(name),
    request: enc.encode(JSON.stringify({ name })),
    response: enc.encode(serialized),
    streamed: false,
    meta: {
      name,
      ok: result.ok,
      arrivalIndex,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    },
  });

  if (didThrow) throw thrown;
  return (result as { ok: true; value: T }).value;
}

function unwrapIoResult<T>(response: Uint8Array): T {
  const result = JSON.parse(dec.decode(response)) as IoResult;
  if (!result.ok) {
    const err = new Error(result.error.message);
    err.name = result.error.name;
    throw err;
  }
  return result.value as T;
}

export function createReplayIo(events: JournalEvent[]): IoFn {
  const cursor = new EventCursor(events, "io");
  return async <T>(name: string, _fn: () => T | Promise<T>): Promise<T> => {
    const event = cursor.next(ioFingerprint(name));
    if (!event) {
      throw new Error(
        `[rewind] replay miss: io("${name}") has no unconsumed recorded result. ` +
          `The agent diverged from the recorded run, or this io call is new. ${cursor.describeMiss(ioFingerprint(name))}`,
      );
    }
    return unwrapIoResult<T>(event.response);
  };
}

/** Hybrid io: journal hits replay WITHOUT executing fn; misses execute live.
 * Both re-journal into targetRun so the hybrid run replays offline (closure). */
export function createHybridIo(journal: Journal, sourceEvents: JournalEvent[], targetRun: RunId): IoFn {
  const cursor = new EventCursor(sourceEvents, "io");
  let arrival = 0;
  return async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const arrivalIndex = arrival;
    arrival += 1;
    const event = cursor.next(ioFingerprint(name));
    if (!event) {
      return executeAndJournalIo(journal, targetRun, name, fn, arrivalIndex);
    }
    journal.appendEvent(targetRun, {
      kind: "io",
      fingerprint: event.fingerprint,
      request: event.request,
      response: event.response,
      streamed: false,
      meta: { ...event.meta, arrivalIndex, replayedFromSeq: event.seq },
    });
    return unwrapIoResult<T>(event.response);
  };
}
