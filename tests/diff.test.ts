import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffRuns } from "../src/diff.js";
import { editResponseBody, forkRun } from "../src/fork.js";
import { Journal } from "../src/journal.js";
import { record, replay } from "../src/session.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = "https://api.anthropic.com/v1/messages";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-diff-"));
  path = join(dir, "t.rewind.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  };
}

async function recordThreeEventRun(): Promise<string> {
  const fake = createFakeAnthropic((r) => {
    const parsed = JSON.parse(r.body!) as { turn: number };
    return { json: messageJson(`ans-${parsed.turn}`) };
  });
  const rec = record({ journal: path, base: fake.fetch });
  await (await rec.fetch(URL_, post({ turn: 0 }))).text();
  await (await rec.fetch(URL_, post({ turn: 1 }))).text();
  await rec.io("clock", () => 12345);
  rec.finish();
  return rec.runId;
}

describe("diffRuns", () => {
  it("a non-diverging hybrid replay diffs as identical to its parent", async () => {
    // Two LIVE recordings are never byte-identical (message ids differ, like
    // the real API) — but a hybrid replay that never misses copies responses
    // verbatim, so parent and child diff as all-same.
    const a = await recordThreeEventRun();
    const hyb = replay({ journal: path, run: a, policy: "hybrid" });
    await (await hyb.fetch(URL_, post({ turn: 0 }))).text();
    await (await hyb.fetch(URL_, post({ turn: 1 }))).text();
    await hyb.io("clock", () => 12345);
    hyb.finish();

    const journal = Journal.open(path);
    const diff = diffRuns(journal, a, hyb.runId);
    journal.close();

    expect(diff.firstDivergenceSeq).toBeNull();
    expect(diff.entries.map((e) => e.status)).toEqual(["same", "same", "same"]);
  });

  it("fork diff: shared prefix same, edited event changed, dropped future only-in-a", async () => {
    const a = await recordThreeEventRun();
    const journal = Journal.open(path);
    const forkId = forkRun(journal, {
      from: a,
      atSeq: 1,
      edit: (e) => editResponseBody(e, JSON.stringify(messageJson("EDITED"))),
    });
    const diff = diffRuns(journal, a, forkId);
    journal.close();

    expect(diff.firstDivergenceSeq).toBe(1);
    expect(diff.entries.map((e) => e.status)).toEqual(["same", "changed", "only-in-a"]);
    expect(diff.entries[2]!.kind).toBe("io");
  });

  it("longer b reports only-in-b entries and divergence at first extra seq", async () => {
    const a = await recordThreeEventRun();
    const fake = createFakeAnthropic((r) => {
      const parsed = JSON.parse(r.body!) as { turn: number };
      return { json: messageJson(`ans-${parsed.turn}`) };
    });
    // Hybrid replay that asks one extra question → child run has 4 events.
    const hyb = replay({ journal: path, run: a, policy: "hybrid", base: fake.fetch });
    await (await hyb.fetch(URL_, post({ turn: 0 }))).text();
    await (await hyb.fetch(URL_, post({ turn: 1 }))).text();
    await hyb.io("clock", () => 12345);
    await (await hyb.fetch(URL_, post({ turn: 2 }))).text();
    hyb.finish();

    const journal = Journal.open(path);
    const diff = diffRuns(journal, a, hyb.runId);
    journal.close();

    expect(diff.entries.map((e) => e.status)).toEqual(["same", "same", "same", "only-in-b"]);
    expect(diff.firstDivergenceSeq).toBe(3);
    expect(diff.entries[3]!.what).toContain("/v1/messages");
  });
});

describe("rewind diff CLI", () => {
  it("renders per-event statuses and the first divergence", async () => {
    const a = await recordThreeEventRun();
    const journal = Journal.open(path);
    const forkId = forkRun(journal, {
      from: a,
      atSeq: 1,
      label: "what-if",
      edit: (e) => editResponseBody(e, JSON.stringify(messageJson("EDITED"))),
    });
    journal.close();

    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "diff", a.slice(0, 8), forkId.slice(0, 8), "--journal", path],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(out).toContain("first divergence at seq 1");
    expect(out).toContain("same");
    expect(out).toContain("changed");
    expect(out).toContain("only-in-a");
  });
});
