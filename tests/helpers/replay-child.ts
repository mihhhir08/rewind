// Subprocess fixture for CLI tests: an "agent" that reads its rewind session
// from the environment. In replay mode its io fn must never execute.
import { fromEnv } from "../../src/session.js";

const session = fromEnv();

const res = await session.fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ turn: 0 }),
});
const parsed = (await res.json()) as { content: Array<{ text: string }> };

const tool = await session.io("lookup", (): { value: number } => {
  throw new Error("io fn executed during replay — determinism boundary broken");
});

console.log(JSON.stringify({ mode: session.mode, llm: parsed.content[0]!.text, tool }));
session.finish();
