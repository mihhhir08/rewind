# rewind

**Deterministic record/replay debugging for LLM agents.** Record an agent run once; replay it byte-exact, offline, free, forever. Fork any step to compute the future that *would have* happened.

> `rr` for agents. Observability tools show you what happened — rewind lets you run it again.

## Why

Your agent crashed on step 47 of 50. Reproducing that today means re-running 46 steps, paying for every token, and hoping the model takes the same path (it won't). With rewind:

```
rewind replay <run> -- node agent.js    # exact reproduction, zero network, $0
rewind fork <run> --at 46 --response …  # rewrite step 46, compute the alternate future
rewind diff <run> <fork>                # see exactly where and how the futures diverge
```

## Quick start

```ts
import Anthropic from "@anthropic-ai/sdk";
import { fromEnv } from "rewind";

const session = fromEnv();
const client = new Anthropic({ fetch: session.fetch });
```

That's the whole integration. Wrap tool calls and other non-determinism in `session.io("name", fn)`, then drive everything from the CLI:

```bash
rewind record -- node agent.js       # run live, journal everything
rewind runs                          # list recorded runs
rewind show <run>                    # event timeline: every LLM call, tool, io
rewind replay <run> -- node agent.js # re-run offline: recorded responses, no key needed
```

Unwired environments fall back to plain live recording — agent code never branches on mode.

## The demo

[`demo/agent.ts`](./demo/agent.ts) is an expense-audit agent with a bug that only manifests at the **last** step — after three paid LLM calls:

```bash
export ANTHROPIC_API_KEY=sk-...   # needed exactly once
npx tsx src/cli.ts record -j demo.rewind.db -- npx tsx demo/agent.ts   # 💥 crashes at the final step
```

Everything after this is offline, instant, and free:

```bash
npx tsx src/cli.ts runs -j demo.rewind.db
npx tsx src/cli.ts replay -j demo.rewind.db <run> -- npx tsx demo/agent.ts  # 💥 same crash, $0
# open demo/agent.ts, fix the marked one-line bug, then:
npx tsx src/cli.ts replay -j demo.rewind.db <run> -- npx tsx demo/agent.ts  # ✅ passes — fix verified offline
```

(Options go before the run id — everything after it is passed through to your command untouched.)

And the counterfactual — *what if the model had reported a different total?* — still offline, still $0:

```bash
npx tsx src/cli.ts fork <run> --at 4 --text '{"total_usd": 0, "flagged": []}' --label what-if -j demo.rewind.db
npx tsx src/cli.ts replay -j demo.rewind.db <fork> -- npx tsx demo/agent.ts   # the agent lives the edited history
npx tsx src/cli.ts diff <run> <fork> -j demo.rewind.db                        # first divergence at seq 4
```

If the edit changes what the agent *asks next*, replay the fork with `--policy hybrid`: recorded history is served from the journal, the diverged future goes live once, and the result is a new run that itself replays offline. Runs are closed under replay.

## How it works

rewind injects a recording `fetch` at the SDK transport boundary (no proxy, no cert tricks, no global monkey-patching) and journals every non-deterministic input — LLM responses **including exact SSE chunk boundaries**, tool results, time, randomness — into a content-addressed SQLite journal. Replay serves the journal instead of the network. The real Anthropic SDK consumes replayed streams without knowing the difference.

**Determinism guarantee (precise):** replay is deterministic at the SDK I/O boundary. If your agent's only non-determinism flows through the wrapped client and `io()`, replay reproduces recorded values byte-exact — including which racing caller got which response. rewind does not (and does not claim to) control instruction-level or OS-level non-determinism.

## Why this is hard

- **"Same request" has no obvious definition.** Bodies serialize with unstable key order; headers carry per-attempt noise (request ids, retry counters, auth). rewind canonicalizes and fingerprints requests, stripping a curated volatile-header blocklist — chosen over an allowlist because a fingerprint that fails loud (replay miss) is debuggable, and one that lies (wrong hit) is corruption.
- **Concurrency breaks naive matching.** When identical requests race, journal order is completion order but callers need *their* response back. rewind records arrival order separately and pairs by it, keeping transcripts byte-exact under concurrency (verified across repeated replay iterations in tests).
- **Streams are not bodies.** SDK parsers are sensitive to SSE chunk framing, so rewind records and replays the exact chunk boundaries — and when you *edit* a streamed response in a fork, it re-frames the new text into valid SSE events so the SDK can still consume it.
- **Forking needs a closure property.** A forked run's future can't come from the recording (its context now contains the edit). Hybrid replay serves the journal until divergence, falls through live after it, and journals *everything* into a new run — so every run in the journal, original or forked, replays fully offline. Runs are closed under replay.

## Design decisions

Every architectural fork in the road, what was rejected, and why: [DECISIONS.md](./DECISIONS.md).

## Development

```bash
npm install
npm test        # 68 tests, incl. real-SDK stream integration and concurrency races
npx tsc --noEmit
```

## License

MIT
