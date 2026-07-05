import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

let dir: string;
let path: string;
let journal: Journal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
  path = join(dir, "test.rewind.db");
  journal = Journal.open(path);
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

function event(i: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: "llm_call" as const,
    fingerprint: `fp-${i}`,
    request: enc.encode(`request-${i}`),
    response: enc.encode(`response-${i}`),
    streamed: false,
    meta: { url: "https://api.anthropic.com/v1/messages", status: 200 },
    ...overrides,
  };
}

describe("Journal: runs and events round-trip", () => {
  it("appends events and reads them back in seq order with identical bytes", () => {
    const run = journal.createRun({ label: "test-run" });
    const seqs = [0, 1, 2].map((i) => journal.appendEvent(run, event(i)));
    expect(seqs).toEqual([0, 1, 2]);

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(3);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i);
      expect(e.kind).toBe("llm_call");
      expect(e.fingerprint).toBe(`fp-${i}`);
      expect(dec.decode(e.request)).toBe(`request-${i}`);
      expect(dec.decode(e.response)).toBe(`response-${i}`);
      expect(e.streamed).toBe(false);
      expect(e.meta["status"]).toBe(200);
    });
  });

  it("dedups identical blobs via content addressing", () => {
    const run = journal.createRun({});
    const sameBody = enc.encode("identical-system-prompt-payload");
    journal.appendEvent(run, event(0, { request: sameBody }));
    journal.appendEvent(run, event(1, { request: sameBody }));

    // 1 shared request blob + 2 distinct response blobs
    expect(journal.stats().blobs).toBe(3);
    // both events still read back correctly
    const events = journal.eventsForRun(run);
    expect(dec.decode(events[0]!.request)).toBe("identical-system-prompt-payload");
    expect(dec.decode(events[1]!.request)).toBe("identical-system-prompt-payload");
  });

  it("lists runs with event counts and parent linkage", () => {
    const a = journal.createRun({ label: "original" });
    journal.appendEvent(a, event(0));
    journal.appendEvent(a, event(1));
    const b = journal.createRun({ label: "fork", parentRunId: a, forkedAtSeq: 1 });
    journal.appendEvent(b, event(0));

    const runs = journal.runs();
    expect(runs).toHaveLength(2);
    const original = runs.find((r) => r.id === a)!;
    const fork = runs.find((r) => r.id === b)!;
    expect(original.label).toBe("original");
    expect(original.eventCount).toBe(2);
    expect(original.parentRunId).toBeNull();
    expect(fork.eventCount).toBe(1);
    expect(fork.parentRunId).toBe(a);
    expect(fork.forkedAtSeq).toBe(1);
  });

  it("persists across close/reopen", () => {
    const run = journal.createRun({ label: "persist" });
    journal.appendEvent(run, event(0));
    journal.close();

    journal = Journal.open(path);
    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    expect(dec.decode(events[0]!.response)).toBe("response-0");
  });

  it("keeps interleaved runs isolated with independent seq counters", () => {
    const a = journal.createRun({});
    const b = journal.createRun({});
    expect(journal.appendEvent(a, event(0))).toBe(0);
    expect(journal.appendEvent(b, event(100))).toBe(0);
    expect(journal.appendEvent(a, event(1))).toBe(1);
    expect(journal.appendEvent(b, event(101))).toBe(1);

    expect(journal.eventsForRun(a).map((e) => e.fingerprint)).toEqual(["fp-0", "fp-1"]);
    expect(journal.eventsForRun(b).map((e) => e.fingerprint)).toEqual(["fp-100", "fp-101"]);
  });

  it("preserves streamed flag and io kind", () => {
    const run = journal.createRun({});
    journal.appendEvent(run, event(0, { kind: "io", fingerprint: "io:get_weather", streamed: false }));
    journal.appendEvent(run, event(1, { streamed: true }));
    const events = journal.eventsForRun(run);
    expect(events[0]!.kind).toBe("io");
    expect(events[1]!.streamed).toBe(true);
  });
});
