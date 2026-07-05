import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editResponseBody, forkRun } from "../src/fork.js";
import { Journal } from "../src/journal.js";
import { fromEnv, record, replay } from "../src/session.js";
import { createFakeAnthropic, messageJson, sseChunksForText } from "./helpers/fake-anthropic.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
  path = join(dir, "t.rewind.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const URL_ = "https://api.anthropic.com/v1/messages";

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

/** Agent whose control flow depends on responses: each turn's request embeds
 * the previous answer, so an edited response changes every later request. */
async function contextAgent(s: {
  fetch: typeof fetch;
  io: <T>(n: string, f: () => T | Promise<T>) => Promise<T>;
}): Promise<string> {
  const transcript: string[] = [];
  let context = "start";
  for (let turn = 0; turn < 3; turn++) {
    const answer = await text(await s.fetch(URL_, post({ turn, context })));
    transcript.push(answer);
    context = answer;
  }
  const clock = await s.io("clock", () => 12345);
  // Final call repeats turn 0's EXACT request — a post-divergence journal hit.
  const repeat = await text(await s.fetch(URL_, post({ turn: 0, context: "start" })));
  transcript.push(String(clock), repeat);
  return transcript.join("|");
}

describe("hybrid policy", () => {
  it("serves recorded events offline and falls through to live only on miss, journaling everything into a replayable new run", async () => {
    const fake = createFakeAnthropic((r) => {
      const parsed = JSON.parse(r.body!) as { turn: number };
      return { json: messageJson(`ans-${parsed.turn}`) };
    });

    // Record a 2-turn agent.
    const rec = record({ journal: path, base: fake.fetch });
    await text(await rec.fetch(URL_, post({ turn: 0 })));
    await text(await rec.fetch(URL_, post({ turn: 1 })));
    rec.finish();
    expect(fake.calls()).toBe(2);

    // Hybrid replay of an agent that asks an EXTRA question.
    const hyb = replay({ journal: path, run: rec.runId, policy: "hybrid", base: fake.fetch });
    expect(hyb.runId).not.toBe(rec.runId); // hybrid re-records into a new run
    const a0 = await text(await hyb.fetch(URL_, post({ turn: 0 })));
    const a1 = await text(await hyb.fetch(URL_, post({ turn: 1 })));
    const a2 = await text(await hyb.fetch(URL_, post({ turn: 2 }))); // never recorded → live
    hyb.finish();
    expect([a0, a1, a2]).toEqual(["ans-0", "ans-1", "ans-2"]);
    expect(fake.calls()).toBe(3); // only ONE live call during hybrid replay

    // Closure property: the hybrid run replays fully offline under strict.
    const journal = Journal.open(path);
    expect(journal.eventsForRun(hyb.runId)).toHaveLength(3);
    journal.close();
    const strict = replay({ journal: path, run: hyb.runId });
    expect(await text(await strict.fetch(URL_, post({ turn: 0 })))).toBe("ans-0");
    expect(await text(await strict.fetch(URL_, post({ turn: 1 })))).toBe("ans-1");
    expect(await text(await strict.fetch(URL_, post({ turn: 2 })))).toBe("ans-2");
    strict.finish();
    expect(fake.calls()).toBe(3); // still 3 — strict stayed offline
  });

  it("hybrid io(): journal hits do not execute, misses execute live and journal", async () => {
    const rec = record({ journal: path });
    await rec.io("known_tool", () => "recorded-value");
    rec.finish();

    const hyb = replay({ journal: path, run: rec.runId, policy: "hybrid" });
    const mustNotRun = vi.fn(() => "WRONG");
    expect(await hyb.io("known_tool", mustNotRun)).toBe("recorded-value");
    expect(mustNotRun).not.toHaveBeenCalled();

    const runsLive = vi.fn(() => "live-value");
    expect(await hyb.io("new_tool", runsLive)).toBe("live-value");
    expect(runsLive).toHaveBeenCalledTimes(1);
    hyb.finish();

    // Closure: both io results replay offline from the hybrid run.
    const strict = replay({ journal: path, run: hyb.runId });
    expect(await strict.io("known_tool", () => "X")).toBe("recorded-value");
    expect(await strict.io("new_tool", () => "Y")).toBe("live-value");
    strict.finish();
  });
});

describe("forkRun", () => {
  it("fork at seq k: prefix replays offline, edit takes effect, divergence goes live, post-divergence identical requests still hit the journal", async () => {
    const fake = createFakeAnthropic((r) => {
      const parsed = JSON.parse(r.body!) as { turn: number; context: string };
      return { json: messageJson(`ans-${parsed.turn}-<${parsed.context}>`) };
    });

    // Original run: 4 llm calls (turn0, turn1, turn2, repeat-of-turn0) + 1 io.
    const rec = record({ journal: path, base: fake.fetch });
    const original = await contextAgent(rec);
    rec.finish();
    const callsAfterRecord = fake.calls();
    expect(callsAfterRecord).toBe(4);
    expect(original).toBe(
      "ans-0-<start>|ans-1-<ans-0-<start>>|ans-2-<ans-1-<ans-0-<start>>>|12345|ans-0-<start>",
    );

    // Fork at seq 1 (turn 1's llm call), rewriting the model's answer.
    const journal = Journal.open(path);
    const forkId = forkRun(journal, {
      from: rec.runId,
      atSeq: 1,
      label: "what-if",
      edit: (event) => editResponseBody(event, JSON.stringify(messageJson("EDITED"))),
    });
    const forkEvents = journal.eventsForRun(forkId);
    expect(forkEvents).toHaveLength(2); // prefix [0,1) + edited event at 1
    expect(forkEvents[1]!.meta["edited"]).toBe(true);
    expect(forkEvents[1]!.fingerprint).toBe(journal.eventsForRun(rec.runId)[1]!.fingerprint);
    journal.close();

    // Replay the fork under hybrid: turn0 + turn1 offline (turn1 = EDITED),
    // turn2 diverges (context now contains EDITED) → live. The io and the
    // repeated turn-0 request... io was NOT copied (seq 3 > fork point), so it
    // goes live too; the repeated turn-0 request has no unconsumed copy left
    // (its only copy was consumed by turn 0), so it also goes live.
    const hyb = replay({ journal: path, run: forkId, policy: "hybrid", base: fake.fetch });
    const forked = await contextAgent(hyb);
    hyb.finish();

    expect(forked).toBe("ans-0-<start>|EDITED|ans-2-<EDITED>|12345|ans-0-<start>");
    // Live calls during fork replay: turn2 (diverged) + repeat (copy consumed) = 2.
    expect(fake.calls()).toBe(callsAfterRecord + 2);

    // Closure: the diverged future replays fully offline, byte-exact.
    const strict = replay({ journal: path, run: hyb.runId });
    const replayedFork = await contextAgent(strict);
    strict.finish();
    expect(replayedFork).toBe(forked);
    expect(fake.calls()).toBe(callsAfterRecord + 2); // zero network
  });

  it("editResponseBody re-frames streamed responses so forked SSE stays consumable", async () => {
    const fake = createFakeAnthropic(() => ({ sseChunks: sseChunksForText("original streamed") }));
    const rec = record({ journal: path, base: fake.fetch });
    const res = await rec.fetch(URL_, post({ stream: true }));
    await res.text(); // drain so the event journals
    rec.finish();

    const journal = Journal.open(path);
    const newSse = sseChunksForText("edited streamed").join("");
    const forkId = forkRun(journal, {
      from: rec.runId,
      atSeq: 0,
      edit: (event) => editResponseBody(event, newSse),
    });
    const edited = journal.eventsForRun(forkId)[0]!;
    expect(edited.streamed).toBe(true);
    journal.close();

    const strict = replay({ journal: path, run: forkId });
    const replayed = await strict.fetch(URL_, post({ stream: true }));
    expect(replayed.headers.get("content-type")).toContain("text/event-stream");
    const body = await replayed.text();
    expect(body).toBe(newSse);
    expect(body).toContain("edited streamed".slice(0, 5));
    strict.finish();
  });

  it("fromEnv honors REWIND_POLICY=hybrid, re-recording into a child run", async () => {
    const rec = record({ journal: path });
    await rec.io("known", () => 1);
    rec.finish();

    const saved = { ...process.env };
    process.env["REWIND_MODE"] = "replay";
    process.env["REWIND_RUN"] = rec.runId;
    process.env["REWIND_JOURNAL"] = path;
    process.env["REWIND_POLICY"] = "hybrid";
    try {
      const s = fromEnv();
      expect(s.mode).toBe("replay");
      expect(s.runId).not.toBe(rec.runId);
      expect(await s.io("known", () => 999)).toBe(1); // hit: recorded value wins
      expect(await s.io("new", () => 2)).toBe(2); // miss: executes live
      s.finish();
    } finally {
      process.env = saved;
    }
  });

  it("rejects out-of-range fork points", async () => {
    const rec = record({ journal: path });
    await rec.io("only", () => 1);
    rec.finish();

    const journal = Journal.open(path);
    expect(() => forkRun(journal, { from: rec.runId, atSeq: 5, edit: (e) => e.response })).toThrow(/atSeq/);
    journal.close();
  });
});
