import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";
import { createRecordingFetch } from "../src/record.js";
import { createReplayFetch } from "../src/replay.js";
import { decodeResponseEnvelope } from "../src/envelope.js";
import { record, replay } from "../src/session.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

let dir: string;
let path: string;
let journal: Journal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
  path = join(dir, "t.rewind.db");
  journal = Journal.open(path);
});

afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://api.anthropic.com/v1/messages";
const dec = new TextDecoder();

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  };
}

async function text(res: Response): Promise<string> {
  return ((await res.json()) as { content: Array<{ text: string }> }).content[0]!.text;
}

describe("concurrency: racing identical requests", () => {
  it("replays each concurrent caller the same response it received during record, across 25 replays", async () => {
    // Identical requests, distinct responses, reversed completion order:
    // caller 0 gets the SLOWEST response, caller 3 the fastest.
    const fake = createFakeAnthropic((_r, i) => ({ json: messageJson(`racer-${i}`), delayMs: (4 - i) * 10 }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const recordedTexts = await Promise.all(
      [0, 1, 2, 3].map(async () => text(await rec(URL_, post({ same: "race" })))),
    );
    // fake assigns bodies by call order: caller i got racer-i
    expect(recordedTexts).toEqual(["racer-0", "racer-1", "racer-2", "racer-3"]);

    // Journal seq is completion order — reversed by the delays above.
    const seqBodies = journal.eventsForRun(run).map((e) => {
      const env = decodeResponseEnvelope(e.response);
      return (JSON.parse(dec.decode(env.body)) as { content: Array<{ text: string }> }).content[0]!.text;
    });
    expect(seqBodies).toEqual(["racer-3", "racer-2", "racer-1", "racer-0"]);

    // Replay pairing must follow ARRIVAL order, not completion order —
    // and must be identical on every replay.
    for (let iteration = 0; iteration < 25; iteration++) {
      const rep = createReplayFetch(journal, run, { policy: "strict" });
      const replayedTexts = await Promise.all(
        [0, 1, 2, 3].map(async () => text(await rep(URL_, post({ same: "race" })))),
      );
      expect(replayedTexts).toEqual(recordedTexts);
    }
    expect(fake.calls()).toBe(4);
  });

  it("handles concurrent distinct requests interleaved with io() without deadlock", async () => {
    const fake = createFakeAnthropic((r) => {
      const parsed = JSON.parse(r.body!) as { id: number };
      return { json: messageJson(`resp-${parsed.id}`), delayMs: (parsed.id % 3) * 7 };
    });

    async function agent(s: { fetch: typeof fetch; io: <T>(n: string, f: () => T | Promise<T>) => Promise<T> }) {
      const results = await Promise.all([
        text(await s.fetch(URL_, post({ id: 1 }))),
        s.io("clock", () => 1111),
        text(await s.fetch(URL_, post({ id: 2 }))),
        s.io("clock", () => 2222),
        text(await s.fetch(URL_, post({ id: 3 }))),
      ]);
      return JSON.stringify(results);
    }

    const rec = record({ journal: path, base: fake.fetch });
    const recorded = await agent(rec);
    rec.finish();
    expect(recorded).toContain("resp-1");

    for (let iteration = 0; iteration < 10; iteration++) {
      const rep = replay({ journal: path, run: rec.runId });
      expect(await agent(rep)).toBe(recorded);
      rep.finish();
    }
    expect(fake.calls()).toBe(3);
  });

  it("concurrent same-name io() calls replay by arrival order", async () => {
    const rec = record({ journal: path });
    const delayed = (v: number, ms: number) => () => new Promise<number>((r) => setTimeout(() => r(v), ms));
    // caller order 10,20,30 — completion order 30,20,10
    const recorded = await Promise.all([
      rec.io("sensor", delayed(10, 30)),
      rec.io("sensor", delayed(20, 15)),
      rec.io("sensor", delayed(30, 1)),
    ]);
    expect(recorded).toEqual([10, 20, 30]);
    rec.finish();

    for (let iteration = 0; iteration < 10; iteration++) {
      const rep = replay({ journal: path, run: rec.runId });
      const replayed = await Promise.all([
        rep.io("sensor", () => -1),
        rep.io("sensor", () => -1),
        rep.io("sensor", () => -1),
      ]);
      expect(replayed).toEqual(recorded);
      rep.finish();
    }
  });
});
