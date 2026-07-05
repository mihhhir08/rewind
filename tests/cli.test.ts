import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { record } from "../src/session.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = "https://api.anthropic.com/v1/messages";

let dir: string;
let journalPath: string;
let runId: string;

function cli(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rewind-cli-"));
  journalPath = join(dir, "cli.rewind.db");

  const fake = createFakeAnthropic(() => ({ json: messageJson("recorded-answer") }));
  const session = record({ journal: journalPath, label: "cli-fixture", base: fake.fetch });
  runId = session.runId;
  const res = await session.fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ turn: 0 }),
  });
  await res.text();
  await session.io("lookup", () => ({ value: 42 }));
  session.finish();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rewind CLI", () => {
  it("runs: lists runs with label and event count", () => {
    const out = cli(["runs", "--journal", journalPath]);
    expect(out).toContain(runId.slice(0, 8));
    expect(out).toContain("cli-fixture");
    expect(out).toContain("2"); // event count
  });

  it("show: prints the event timeline", () => {
    const out = cli(["show", runId, "--journal", journalPath]);
    expect(out).toContain("llm_call");
    expect(out).toContain("/v1/messages");
    expect(out).toContain("io");
    expect(out).toContain("lookup");
    expect(out).toContain("200");
  });

  it("show: resolves run id prefixes", () => {
    const out = cli(["show", runId.slice(0, 8), "--journal", journalPath]);
    expect(out).toContain("llm_call");
  });

  it("fork: creates a child run with an edited response, visible in runs/show", () => {
    const out = cli([
      "fork",
      runId.slice(0, 8),
      "--at",
      "0",
      "--response",
      JSON.stringify(messageJson("EDITED")),
      "--label",
      "what-if",
      "--journal",
      journalPath,
    ]);
    expect(out).toContain("forked");

    const runsOut = cli(["runs", "--journal", journalPath]);
    expect(runsOut).toContain("what-if");
    expect(runsOut).toContain(`${runId.slice(0, 8)}@0`); // parent lineage

    const forkId = /→ ([0-9a-f]{8})/.exec(out)![1]!;
    const showOut = cli(["show", forkId, "--journal", journalPath]);
    expect(showOut).toContain("llm_call");
  });

  it("replay: re-executes the agent subprocess fully offline via env handshake", () => {
    // options must precede positionals: everything after the run id is
    // passed through to the child command untouched
    const out = cli([
      "replay",
      "--journal",
      journalPath,
      runId,
      "--",
      process.execPath,
      "--import",
      "tsx",
      "tests/helpers/replay-child.ts",
    ]);
    const line = out.split("\n").find((l) => l.startsWith("{"))!;
    const parsed = JSON.parse(line) as { mode: string; llm: string; tool: { value: number } };
    expect(parsed.mode).toBe("replay");
    expect(parsed.llm).toBe("recorded-answer"); // served from journal, no network, io fn not executed
    expect(parsed.tool).toEqual({ value: 42 });
  });
});
