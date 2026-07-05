import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeResponseEnvelope } from "../src/envelope.js";
import { Journal } from "../src/journal.js";
import { createRecordingFetch } from "../src/record.js";
import { createFakeAnthropic, sseChunksForText } from "./helpers/fake-anthropic.js";

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
const dec = new TextDecoder();

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  };
}

async function readChunks(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(dec.decode(value));
  }
  return chunks;
}

describe("streaming record", () => {
  it("passes SSE through with chunk boundaries exactly as upstream sent them", async () => {
    const sent = sseChunksForText("streamed hello world");
    expect(sent.length).toBe(3); // sanity: fixture splits an event across chunks
    const fake = createFakeAnthropic(() => ({ sseChunks: sent }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ stream: true }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const received = await readChunks(res);
    expect(received).toEqual(sent);
  });

  it("journals the exact chunk framing with streamed=true", async () => {
    const sent = sseChunksForText("frame me");
    const fake = createFakeAnthropic(() => ({ sseChunks: sent }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    await readChunks(await rec(URL_, post({ stream: true })));

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    expect(events[0]!.streamed).toBe(true);
    const env = decodeResponseEnvelope(events[0]!.response);
    expect(env.streamed).toBe(true);
    expect(env.truncated).toBe(false);
    expect(env.chunks.map((c) => dec.decode(c))).toEqual(sent);
    expect(events[0]!.meta["status"]).toBe(200);
  });

  it("journals a mid-stream upstream abort as a truncated event and errors the consumer", async () => {
    const sent = sseChunksForText("dies midway");
    const fake = createFakeAnthropic(() => ({ sseChunks: sent, truncateAfterChunk: 0 }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);

    const res = await rec(URL_, post({ stream: true }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe(sent[0]);
    await expect(reader.read()).rejects.toThrow();

    const events = journal.eventsForRun(run);
    expect(events).toHaveLength(1);
    const env = decodeResponseEnvelope(events[0]!.response);
    expect(env.truncated).toBe(true);
    expect(env.chunks.map((c) => dec.decode(c))).toEqual([sent[0]]);
  });

  it("still records non-streaming responses through the same fetch", async () => {
    const fake = createFakeAnthropic(() => ({ json: { plain: true } }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    await (await rec(URL_, post({ stream: false }))).text();
    expect(journal.eventsForRun(run)[0]!.streamed).toBe(false);
  });
});
