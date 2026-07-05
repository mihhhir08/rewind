import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";
import { createRecordingFetch } from "../src/record.js";
import { createReplayFetch } from "../src/replay.js";
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

describe("streaming replay", () => {
  it("replays SSE with byte-identical chunks in identical order, zero network", async () => {
    const sent = sseChunksForText("replay me exactly");
    const fake = createFakeAnthropic(() => ({ sseChunks: sent }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    const recordedChunks = await readChunks(await rec(URL_, post({ stream: true })));

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    const res = await rep(URL_, post({ stream: true }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const replayedChunks = await readChunks(res);

    expect(replayedChunks).toEqual(recordedChunks);
    expect(replayedChunks).toEqual(sent);
    expect(fake.calls()).toBe(1);
  });

  it("replays a recorded truncation as a mid-stream error", async () => {
    const sent = sseChunksForText("cut off");
    const fake = createFakeAnthropic(() => ({ sseChunks: sent, truncateAfterChunk: 0 }));
    const run = journal.createRun({});
    const rec = createRecordingFetch(journal, run, fake.fetch);
    const recRes = await rec(URL_, post({ stream: true }));
    const recReader = recRes.body!.getReader();
    await recReader.read();
    await expect(recReader.read()).rejects.toThrow();

    const rep = createReplayFetch(journal, run, { policy: "strict" });
    const res = await rep(URL_, post({ stream: true }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe(sent[0]);
    await expect(reader.read()).rejects.toThrow(/truncated/i);
  });

  it("the real Anthropic SDK consumes a replayed stream end-to-end", async () => {
    const sent = sseChunksForText("sdk sees this text");
    const fake = createFakeAnthropic(() => ({ sseChunks: sent }));
    const run = journal.createRun({});

    async function streamText(f: typeof fetch): Promise<string> {
      const client = new Anthropic({ apiKey: "test-key", fetch: f as never, maxRetries: 0 });
      const stream = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
        }
      }
      return text;
    }

    const recorded = await streamText(createRecordingFetch(journal, run, fake.fetch));
    expect(recorded).toBe("sdk sees this text");
    const callsAfterRecord = fake.calls();

    const replayed = await streamText(createReplayFetch(journal, run, { policy: "strict" }));
    expect(replayed).toBe("sdk sees this text");
    expect(fake.calls()).toBe(callsAfterRecord);
  });
});
