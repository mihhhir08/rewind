/** Demo: an expense-audit agent with a bug that manifests at the LAST step —
 * after three paid LLM calls. Record it once, then reproduce, debug, and
 * verify the fix offline at $0 with `rewind replay`.
 *
 *   npx tsx src/cli.ts record -j demo.rewind.db -- npx tsx demo/agent.ts
 *   npx tsx src/cli.ts runs -j demo.rewind.db
 *   npx tsx src/cli.ts replay -j demo.rewind.db <run> -- npx tsx demo/agent.ts
 */
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { fromEnv, type Session } from "../src/index.js";

const MODEL = "claude-haiku-4-5-20251001";

export async function runAudit(session: Session): Promise<string> {
  const client = new Anthropic({
    // Replay never touches the network, so no key is needed offline.
    apiKey: process.env["ANTHROPIC_API_KEY"] ?? "rewind-offline-replay",
    fetch: session.fetch as never,
    maxRetries: 0,
  });

  const ask = async (prompt: string): Promise<string> => {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    const first = msg.content[0];
    return first !== undefined && first.type === "text" ? first.text : "";
  };

  const expenses = await session.io("load_expenses", () => [
    { id: "e1", desc: "Team dinner — Berlin offsite", amount: 412.5, currency: "EUR" },
    { id: "e2", desc: "Cloud GPU credits", amount: 1800, currency: "USD" },
    { id: "e3", desc: "Airport taxi", amount: 95, currency: "EUR" },
    { id: "e4", desc: "Conference tickets x3", amount: 2100, currency: "USD" },
    { id: "e5", desc: "Espresso machine for the office", amount: 640, currency: "EUR" },
  ]);
  console.log(`[agent] loaded ${expenses.length} expenses`);

  const categories = await ask(
    `Categorize each expense as travel/equipment/food/other. One line per expense, format "<id>: <category>".\n` +
      `Expenses: ${JSON.stringify(expenses)}`,
  );
  console.log(`[agent] categories:\n${categories}`);

  // Nondeterminism goes through io() so replay freezes it.
  const rate = await session.io("eur_usd_rate", () => 1.05 + Math.random() * 0.08);
  console.log(`[agent] EUR→USD rate: ${rate}`);

  const flags = await ask(
    `Flag suspicious expenses (unusually large, or not clearly business-related). Answer with ids and one-line reasons.\n` +
      `Categorized expenses:\n${categories}`,
  );
  console.log(`[agent] flags:\n${flags}`);

  const final = await ask(
    `Produce the final audit report. Convert EUR amounts using rate ${rate}.\n` +
      `Expenses: ${JSON.stringify(expenses)}\nFlagged:\n${flags}\n` +
      `Respond with ONLY a JSON object, no markdown fences: {"total_usd": number, "flagged": ["id", ...]}`,
  );
  const report = JSON.parse(final.replace(/^```(?:json)?\s*|\s*```\s*$/g, "")) as {
    total_usd: number;
    flagged: string[];
  };

  // BUG: there is no "summary" wrapper in the report — this crashes at the
  // very last step, after all three paid LLM calls succeeded.
  // Fix: const total = report.total_usd.toFixed(2);
  const total = (report as unknown as { summary: { total_usd: number } }).summary.total_usd.toFixed(2);

  const summary = `audit complete — total $${total}, flagged: ${report.flagged.join(", ")}`;
  console.log(`[agent] ${summary}`);
  return summary;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const session = fromEnv({ journal: "demo.rewind.db", label: "expense-audit" });
  try {
    await runAudit(session);
  } finally {
    session.finish();
  }
}
