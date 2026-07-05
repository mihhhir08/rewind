import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { record, replay } from "../src/session.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

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

describe("io(): record and replay side effects", () => {
  it("executes and journals in record mode; returns without executing in replay", async () => {
    const rec = record({ journal: path, label: "io-test" });
    const weather = vi.fn(() => Promise.resolve({ tempC: 31, city: "Ahmedabad" }));
    const recorded = await rec.io("get_weather", weather);
    expect(recorded).toEqual({ tempC: 31, city: "Ahmedabad" });
    expect(weather).toHaveBeenCalledTimes(1);
    rec.finish();

    const rep = replay({ journal: path, run: rec.runId });
    const notCalled = vi.fn(() => Promise.resolve({ tempC: -99, city: "WRONG" }));
    const replayed = await rep.io("get_weather", notCalled);
    expect(replayed).toEqual({ tempC: 31, city: "Ahmedabad" });
    expect(notCalled).not.toHaveBeenCalled();
    rep.finish();
  });

  it("replays thrown errors with identical name and message, without executing fn", async () => {
    const rec = record({ journal: path });
    class ToolError extends Error {
      override name = "ToolError";
    }
    await expect(
      rec.io("flaky_tool", () => {
        throw new ToolError("upstream 503");
      }),
    ).rejects.toThrow("upstream 503");
    rec.finish();

    const rep = replay({ journal: path, run: rec.runId });
    const spy = vi.fn();
    const err = await rep.io("flaky_tool", spy).catch((e: unknown) => e as Error);
    expect(spy).not.toHaveBeenCalled();
    expect((err as Error).message).toBe("upstream 503");
    expect((err as Error).name).toBe("ToolError");
    rep.finish();
  });

  it("replays same-name calls in FIFO order", async () => {
    const rec = record({ journal: path });
    await rec.io("roll", () => 4);
    await rec.io("roll", () => 17);
    rec.finish();

    const rep = replay({ journal: path, run: rec.runId });
    expect(await rep.io("roll", () => -1)).toBe(4);
    expect(await rep.io("roll", () => -1)).toBe(17);
    rep.finish();
  });

  it("fails loudly at record time for non-serializable results", async () => {
    const rec = record({ journal: path });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(rec.io("bad_tool", () => circular)).rejects.toThrow(/bad_tool.*serializ|serializ.*bad_tool/i);
    rec.finish();
  });

  it("replay misses loudly when io was never recorded", async () => {
    const rec = record({ journal: path });
    await rec.io("known", () => 1);
    rec.finish();

    const rep = replay({ journal: path, run: rec.runId });
    await expect(rep.io("never_recorded", () => 2)).rejects.toThrow(/never_recorded/);
    rep.finish();
  });
});

describe("session: fetch + io end-to-end", () => {
  it("records an agent mixing LLM calls and tools, then replays it fully offline", async () => {
    const fake = createFakeAnthropic((_r, i) => ({ json: messageJson(`llm-${i}`) }));

    async function agent(s: { fetch: typeof fetch; io: <T>(n: string, f: () => T | Promise<T>) => Promise<T> }): Promise<string> {
      const r1 = (await (await s.fetch(URL_, post({ turn: 0 }))).json()) as { content: Array<{ text: string }> };
      const tool = await s.io("lookup", () => ({ value: 42 }));
      const r2 = (await (await s.fetch(URL_, post({ turn: 1, tool }))).json()) as { content: Array<{ text: string }> };
      return `${r1.content[0]!.text}|${tool.value}|${r2.content[0]!.text}`;
    }

    const rec = record({ journal: path, base: fake.fetch });
    const recorded = await agent(rec);
    rec.finish();
    expect(fake.calls()).toBe(2);

    const rep = replay({ journal: path, run: rec.runId });
    const replayed = await agent(rep);
    rep.finish();

    expect(replayed).toBe(recorded);
    expect(fake.calls()).toBe(2); // replay hit the network zero times
  });

  it("exposes mode and runId", () => {
    const rec = record({ journal: path });
    expect(rec.mode).toBe("record");
    expect(rec.runId).toMatch(/[0-9a-f-]{36}/);
    rec.finish();

    const rep = replay({ journal: path, run: rec.runId });
    expect(rep.mode).toBe("replay");
    expect(rep.runId).toBe(rec.runId);
    rep.finish();
  });
});
