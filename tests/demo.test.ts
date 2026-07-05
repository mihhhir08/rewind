import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudit } from "../demo/agent.js";
import { record, replay } from "../src/session.js";
import { createFakeAnthropic, messageJson } from "./helpers/fake-anthropic.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-demo-"));
  path = join(dir, "demo.rewind.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeModel() {
  return createFakeAnthropic((r) => {
    const prompt = JSON.stringify(JSON.parse(r.body!));
    if (prompt.includes("ONLY a JSON object")) {
      return { json: messageJson('{"total_usd": 5522.61, "flagged": ["e4", "e5"]}') };
    }
    if (prompt.includes("Flag suspicious")) {
      return { json: messageJson("e4: unusually large\ne5: not clearly business-related") };
    }
    return { json: messageJson("e1: food\ne2: equipment\ne3: travel\ne4: other\ne5: equipment") };
  });
}

describe("demo agent", () => {
  it("crashes at the LAST step during record, and the crash reproduces offline at zero API calls", async () => {
    const fake = fakeModel();

    const rec = record({ journal: path, base: fake.fetch, label: "expense-audit" });
    await expect(runAudit(rec)).rejects.toThrow(TypeError); // the deliberate bug
    rec.finish();
    expect(fake.calls()).toBe(3); // the crash cost three live LLM calls

    // Reproduce offline: same crash, same step, zero network.
    const strict = replay({ journal: path, run: rec.runId });
    await expect(runAudit(strict)).rejects.toThrow(/summary|total_usd/);
    strict.finish();
    expect(fake.calls()).toBe(3);
  });
});
