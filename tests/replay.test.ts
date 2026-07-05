import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";
import { createRecordingFetch } from "../src/record.js";
import { createReplayFetch, ReplayMissError } from "../src/replay.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

let dir: string;
let journal: Journal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
  journal = Journal.open(join(dir, "t.rewind.db"));
});

afterEach(() => {
  journal.close();
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

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("createReplayFetch (strict)", () => {
  it("replays recorded responses byte-identically with zero upstream calls", async () => {
    const fake = createFakeAnthropic((_r, i) => ({ json: messageJson(`answer-${i}`), headers: { "x-marker": `m${i}` } }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      bodies.push(await (await rec(URL_, post({ turn: i }))).text());
    }
    const callsAfterRecord = fake.calls();
    expect(callsAfterRecord).toBe(3);

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    for (let i = 0; i < 3; i++) {
      const res = await rep(URL_, post({ turn: i }));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-marker")).toBe(`m${i}`);
      expect(await res.text()).toBe(bodies[i]);
    }
    expect(fake.calls()).toBe(callsAfterRecord); // zero new upstream calls
  });

  it("throws ReplayMissError with actionable context for unknown requests", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("x") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ known: true }))).text();

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    const err = await rep(URL_, post({ unknown: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplayMissError);
    const miss = err as ReplayMissError;
    expect(miss.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(miss.message).toContain("strict");
    expect(miss.message).toContain(URL_);
  });

  it("exhausting recorded copies of a request is a miss", async () => {
    const fake = createFakeAnthropic((_r, i) => ({ json: messageJson(`v${i}`) }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ same: true }))).text();

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    await (await rep(URL_, post({ same: true }))).text();
    await expect(rep(URL_, post({ same: true }))).rejects.toBeInstanceOf(ReplayMissError);
  });

  it("replays identical repeated requests in recorded completion order (FIFO)", async () => {
    const fake = createFakeAnthropic((_r, i) => ({ json: messageJson(`attempt-${i}`) }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ retry: "me" }))).text();
    await (await rec(URL_, post({ retry: "me" }))).text();

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    const first = JSON.parse(await (await rep(URL_, post({ retry: "me" }))).text()) as { content: Array<{ text: string }> };
    const second = JSON.parse(await (await rep(URL_, post({ retry: "me" }))).text()) as { content: Array<{ text: string }> };
    expect(first.content[0]!.text).toBe("attempt-0");
    expect(second.content[0]!.text).toBe("attempt-1");
  });

  it("replays recorded error responses as errors", async () => {
    const fake = createFakeAnthropic(() => ({ status: 500, json: { type: "error", error: { type: "api_error", message: "boom" } } }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ q: 1 }))).text();

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    const res = await rep(URL_, post({ q: 1 }));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("boom");
  });

  it("e2e: a scripted multi-turn agent produces a hash-identical transcript on replay", async () => {
    const fake = createFakeAnthropic((_r, i) => ({ json: messageJson(`step-${i}-result`) }));
    const run = journal.createRun({});

    async function agent(f: typeof fetch): Promise<string> {
      let transcript = "";
      let context = "start";
      for (let turn = 0; turn < 4; turn++) {
        const res = await f(URL_, post({ model: "m", messages: [{ role: "user", content: context }] }));
        const parsed = (await res.json()) as { content: Array<{ text: string }> };
        context = parsed.content[0]!.text;
        transcript += `turn${turn}:${context};`;
      }
      return transcript;
    }

    const recorded = await agent(createRecordingFetch(journal, run, fake.fetch));
    const replayed = await agent(createReplayFetch(journal, run, { policy: "strict" }));
    expect(sha256(replayed)).toBe(sha256(recorded));
    expect(fake.calls()).toBe(4); // record only
  });
});
