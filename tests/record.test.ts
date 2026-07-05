import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint } from "../src/canonical.js";
import { Journal } from "../src/journal.js";
import { createRecordingFetch } from "../src/record.js";
import { decodeResponseEnvelope } from "../src/envelope.js";
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

describe("createRecordingFetch (non-streaming)", () => {
  it("passes the upstream response through unmodified and consumable", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hello"), headers: { "x-custom": "kept" } }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ model: "m", messages: [] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom")).toBe("kept");
    const parsed = (await res.json()) as { content: Array<{ text: string }> };
    expect(parsed.content[0]!.text).toBe("hello");
  });

  it("journals exactly one event per call with correct fingerprint and bytes", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("hi") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const init = post({ model: "m", messages: [{ role: "user", content: "q" }] });
    await (await rec(URL_, init)).text();

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("llm_call");
    expect(e.streamed).toBe(false);
    expect(e.fingerprint).toBe(
      fingerprint({ url: URL_, method: "POST", headers: init.headers as Record<string, string>, body: init.body as string }),
    );

    const req = JSON.parse(new TextDecoder().decode(e.request)) as { url: string; body: string };
    expect(req.url).toBe(URL_);
    expect(req.body).toBe(init.body);

    const env = decodeResponseEnvelope(e.response);
    expect(env.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(env.body)) as { content: Array<{ text: string }> };
    expect(body.content[0]!.text).toBe("hi");
  });

  it("journals sequential calls in order", async () => {
    const fake = createFakeAnthropic((_req, i) => ({ json: messageJson(`reply-${i}`) }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    await (await rec(URL_, post({ n: 1 }))).text();
    await (await rec(URL_, post({ n: 2 }))).text();
    await (await rec(URL_, post({ n: 3 }))).text();

    const events = journal.eventsForRun(run);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    const texts = events.map((e) => {
      const env = decodeResponseEnvelope(e.response);
      return (JSON.parse(new TextDecoder().decode(env.body)) as { content: Array<{ text: string }> }).content[0]!.text;
    });
    expect(texts).toEqual(["reply-0", "reply-1", "reply-2"]);
  });

  it("journals error responses too — failures are part of history", async () => {
    const fake = createFakeAnthropic(() => ({
      status: 429,
      json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ model: "m" }));
    expect(res.status).toBe(429);
    await res.text();

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    expect(decodeResponseEnvelope(events[0]!.response).status).toBe(429);
    expect(events[0]!.meta["status"]).toBe(429);
  });

  it("records meta: url, method, status, durationMs", async () => {
    const fake = createFakeAnthropic(() => ({ json: messageJson("x") }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ model: "m" }))).text();

    const meta = journal.eventsForRun(run)[0]!.meta;
    expect(meta["url"]).toBe(URL_);
    expect(meta["method"]).toBe("POST");
    expect(meta["status"]).toBe(200);
    expect(typeof meta["durationMs"]).toBe("number");
  });
});
