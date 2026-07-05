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
  return async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
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
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      },
    });

    if (didThrow) throw thrown;
    return (result as { ok: true; value: T }).value;
  };
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
    const result = JSON.parse(dec.decode(event.response)) as IoResult;
    if (!result.ok) {
      const err = new Error(result.error.message);
      err.name = result.error.name;
      throw err;
    }
    return result.value as T;
  };
}
