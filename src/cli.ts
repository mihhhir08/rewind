#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { diffRuns, eventWhat } from "./diff.js";
import { editResponseBody, forkRun } from "./fork.js";
import { Journal, type RunSummary } from "./journal.js";

const program = new Command();
program
  .name("rewind")
  .description("Deterministic record/replay debugger for LLM agents")
  .enablePositionalOptions();

const DEFAULT_JOURNAL = "default.rewind.db";

function openJournal(path: string): Journal {
  return Journal.open(path);
}

function resolveRun(journal: Journal, prefix: string): RunSummary {
  const matches = journal.runs().filter((r) => r.id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no run matches "${prefix}"`);
  throw new Error(`ambiguous run prefix "${prefix}" (${matches.length} matches)`);
}

function fail(err: unknown): never {
  console.error(`rewind: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

program
  .command("runs")
  .description("List recorded runs")
  .option("-j, --journal <path>", "journal database", DEFAULT_JOURNAL)
  .action((opts: { journal: string }) => {
    try {
      const journal = openJournal(opts.journal);
      const runs = journal.runs();
      if (runs.length === 0) {
        console.log("no runs recorded");
      } else {
        console.log(["RUN", "LABEL", "CREATED", "EVENTS", "PARENT"].join("\t"));
        for (const r of runs) {
          console.log(
            [
              r.id.slice(0, 8),
              r.label ?? "-",
              r.createdAt,
              String(r.eventCount),
              r.parentRunId === null ? "-" : `${r.parentRunId.slice(0, 8)}@${r.forkedAtSeq ?? "?"}`,
            ].join("\t"),
          );
        }
      }
      journal.close();
    } catch (err) {
      fail(err);
    }
  });

program
  .command("show")
  .description("Show the event timeline of a run")
  .argument("<run>", "run id (prefix ok)")
  .option("-j, --journal <path>", "journal database", DEFAULT_JOURNAL)
  .action((runPrefix: string, opts: { journal: string }) => {
    try {
      const journal = openJournal(opts.journal);
      const run = resolveRun(journal, runPrefix);
      console.log(`run ${run.id}${run.label === null ? "" : ` (${run.label})`} — ${run.eventCount} events`);
      console.log(["SEQ", "KIND", "WHAT", "STATUS", "STREAM", "MS"].join("\t"));
      for (const e of journal.eventsForRun(run.id)) {
        const what = eventWhat(e);
        const status = e.kind === "io" ? (e.meta["ok"] === true ? "ok" : "err") : String(e.meta["status"] ?? "?");
        const stream = e.streamed ? (e.meta["truncated"] === true ? "sse!" : "sse") : "-";
        console.log([String(e.seq), e.kind, what, status, stream, String(e.meta["durationMs"] ?? "?")].join("\t"));
      }
      journal.close();
    } catch (err) {
      fail(err);
    }
  });

program
  .command("diff")
  .description("Compare two runs event-by-event")
  .argument("<a>", "run id (prefix ok)")
  .argument("<b>", "run id (prefix ok)")
  .option("-j, --journal <path>", "journal database", DEFAULT_JOURNAL)
  .action((aPrefix: string, bPrefix: string, opts: { journal: string }) => {
    try {
      const journal = openJournal(opts.journal);
      const a = resolveRun(journal, aPrefix);
      const b = resolveRun(journal, bPrefix);
      const diff = diffRuns(journal, a.id, b.id);
      journal.close();

      console.log(`diff ${a.id.slice(0, 8)}${a.label === null ? "" : ` (${a.label})`} vs ${b.id.slice(0, 8)}${b.label === null ? "" : ` (${b.label})`}`);
      if (diff.firstDivergenceSeq === null) {
        console.log(`runs are identical (${diff.entries.length} events)`);
        return;
      }
      console.log(`first divergence at seq ${diff.firstDivergenceSeq}`);
      console.log(["SEQ", "STATUS", "KIND", "WHAT"].join("\t"));
      for (const e of diff.entries) {
        const status = e.status === "changed" && e.sameRequest ? "changed (same request, different response)" : e.status;
        console.log([String(e.seq), status, e.kind, e.what].join("\t"));
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("fork")
  .description("Fork a run at an event, rewriting the recorded response (\"what if the model had said…\")")
  .argument("<run>", "run id (prefix ok)")
  .requiredOption("--at <seq>", "seq of the event to rewrite")
  .option("--response <text>", "replacement response body (SSE text for streamed events)")
  .option("--response-file <path>", "read the replacement body from a file")
  .option("--label <label>", "label for the forked run")
  .option("-j, --journal <path>", "journal database", DEFAULT_JOURNAL)
  .action((runPrefix: string, opts: { at: string; response?: string; responseFile?: string; label?: string; journal: string }) => {
    try {
      const body = opts.responseFile !== undefined ? readFileSync(opts.responseFile, "utf8") : opts.response;
      if (body === undefined) throw new Error("provide --response <text> or --response-file <path>");
      const journal = openJournal(opts.journal);
      const run = resolveRun(journal, runPrefix);
      const forkId = forkRun(journal, {
        from: run.id,
        atSeq: Number(opts.at),
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        edit: (event) => editResponseBody(event, body),
      });
      journal.close();
      console.log(`forked ${run.id.slice(0, 8)}@${opts.at} → ${forkId.slice(0, 8)} (${forkId})`);
      console.log(`compute the counterfactual future:`);
      console.log(`  rewind replay ${forkId.slice(0, 8)} --policy hybrid -j ${opts.journal} -- <your agent command>`);
    } catch (err) {
      fail(err);
    }
  });

function spawnWithEnv(rawCmd: string[], env: Record<string, string>): never {
  const cmd = rawCmd[0] === "--" ? rawCmd.slice(1) : rawCmd;
  if (cmd.length === 0) fail(new Error("no command given — usage: rewind <record|replay> [run] -- <cmd...>"));
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) fail(result.error);
  process.exit(result.status ?? 1);
}

program
  .command("record")
  .description("Run a command with recording enabled (agent must use rewind.fromEnv())")
  .option("-j, --journal <path>", "journal database", DEFAULT_JOURNAL)
  .argument("[cmd...]", "command to run")
  .passThroughOptions()
  .action((cmd: string[], opts: { journal: string }) => {
    spawnWithEnv(cmd, { REWIND_MODE: "record", REWIND_JOURNAL: opts.journal });
  });

program
  .command("replay")
  .description("Re-run a command offline against a recorded run (agent must use rewind.fromEnv())")
  .argument("<run>", "run id (prefix ok)")
  .option("-j, --journal <path>", "journal database", DEFAULT_JOURNAL)
  .option("--policy <policy>", "strict (offline, miss = error) or hybrid (miss falls through live, re-records into a new run)", "strict")
  .argument("[cmd...]", "command to run")
  .passThroughOptions()
  .action((runPrefix: string, cmd: string[], opts: { journal: string; policy: string }) => {
    try {
      if (opts.policy !== "strict" && opts.policy !== "hybrid") {
        throw new Error(`unknown policy "${opts.policy}" (expected strict or hybrid)`);
      }
      const journal = openJournal(opts.journal);
      const run = resolveRun(journal, runPrefix);
      journal.close();
      spawnWithEnv(cmd, {
        REWIND_MODE: "replay",
        REWIND_RUN: run.id,
        REWIND_JOURNAL: opts.journal,
        REWIND_POLICY: opts.policy,
      });
    } catch (err) {
      fail(err);
    }
  });

program.parse();
