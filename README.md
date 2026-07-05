# rewind

**Deterministic record/replay debugging for LLM agents.** Record an agent run once; replay it byte-exact, offline, free, forever. Fork from any step to explore what *would have* happened.

> `rr` for agents. Observability tools show you what happened — rewind lets you run it again.

## Why

Your agent crashed on step 47 of 50. Reproducing that today means re-running 46 steps, paying for every token, and hoping the model takes the same path (it won't). With rewind:

```
rewind replay <run-id>        # exact reproduction, zero network, $0
rewind fork <run-id> --at 46  # edit step 46, see the alternate future
```

## Status

Under active development. Not yet released.

## Quick start

```ts
// TODO(task 4): 3-line integration example
```

## How it works

rewind intercepts at the SDK transport boundary and journals every non-deterministic input — LLM responses (including exact SSE chunk boundaries), tool results, time, randomness — into a content-addressed SQLite journal. Replay serves the journal instead of the network.

**Determinism guarantee (precise):** replay is deterministic at the SDK I/O boundary. If your agent's only non-determinism flows through the wrapped client and `io()`, replay is byte-exact. rewind does not (and does not claim to) control instruction-level or OS-level non-determinism.

## Why this is hard

<!-- TODO(step 4): 3-sentence hard-part section — the journal-matching problem -->

## Design decisions

See [DECISIONS.md](./DECISIONS.md) for every architectural fork in the road and what was rejected.

## License

MIT
