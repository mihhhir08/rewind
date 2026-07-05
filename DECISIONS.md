# Design Decisions

Every architectural fork in the road, what was chosen, what was rejected, and why. Newest last.

## D1 — Intercept at SDK transport (`fetch` injection), not HTTP proxy

**Chose:** inject a custom `fetch` into the Anthropic SDK client.
**Rejected:** MITM HTTP proxy — requires cert trust, sees post-retry traffic (SDK retries would journal as duplicate events), and forces TLS handling that has nothing to do with the problem. Also rejected monkey-patching global fetch — invisible action at a distance, breaks when two libraries patch the same global.
**Consequence:** integration requires passing one option to the client constructor. Explicit > magic.

## D2 — SQLite journal with content-addressed blobs, not JSONL

**Chose:** better-sqlite3, single-file journal per project; request/response bodies stored in a `blobs` table keyed by SHA-256, events reference blobs.
**Rejected:** JSONL append logs — no indexed lookup by fingerprint (replay matching needs it), no safe concurrent writers, repeated system prompts stored N times. Content addressing dedups the system prompt that appears in all 50 steps of a run.
**Consequence:** journals are queryable artifacts (`rewind` CLI reads them directly) and stay small.

## D3 — Canonical request fingerprinting

**Chose:** SHA-256 over canonicalized request: JSON with recursively sorted keys, volatile headers (request IDs, dates, auth) stripped before hashing.
**Rejected:** hashing the raw body bytes — identical requests serialize with different key order across SDK versions; auth/idempotency headers differ per attempt.
**Consequence:** "same request" has a defined, testable meaning. This definition is load-bearing for replay matching.

## D3a — Volatile headers are a blocklist, not an allowlist

**Chose:** strip a known-volatile blocklist (`authorization`, `x-api-key`, `x-request-id`, `date`, `idempotency-key`, `user-agent`, transport headers, `x-stainless-*` SDK telemetry — including `x-stainless-retry-count`, which differs per attempt) and treat every remaining header as semantic.
**Rejected:** allowlisting semantic headers (`anthropic-version`, `anthropic-beta`, `content-type`) — an unknown header that *does* change API behavior would then be silently ignored and two genuinely different requests would collide on one fingerprint. Wrong-response bugs are worse than missed-match bugs: a blocklist miss causes a replay MISS (loud, debuggable); an allowlist miss causes a wrong HIT (silent corruption).
**Consequence:** fingerprints fail loud rather than lie. Arrays are never sorted during body canonicalization — message order is semantic.

## D5 — Concurrent identical requests pair by ARRIVAL order, not completion order

**Chose:** the journal keeps `seq` as completion order (append-on-settle is the only honest append point), but each event also records an `arrivalIndex` captured when the request was issued. Replay hands out responses per fingerprint in arrival order.
**Rejected:** pairing by completion (`seq`) order — when identical requests race and complete in a different order than they were issued, seq-order pairing gives caller 0 the response caller 3 received during record. Values would still be deterministic, but transcripts would diverge from the recorded run, breaking the byte-exactness guarantee for concurrent agents.
**Consequence:** for a deterministic agent (same code, same replay inputs), request-issue order is reproducible even under concurrency, so arrival-order pairing reproduces the exact original assignment. The precise guarantee: replay reproduces recorded VALUES and their original caller-assignment; it does not reproduce wall-clock interleaving (and does not need to).

## D4 — Explicit `io()` wrapper for tools, not automatic interception

**Chose:** side effects outside the LLM call (tool executions, `Date.now`, `Math.random`) are journaled via an explicit `io("name", fn)` wrapper.
**Rejected:** automatic syscall/module interception (rr-style) — that is a different, much larger project, and half-automatic capture would create a false sense of coverage.
**Consequence:** the determinism boundary is explicit and honest: what flows through the wrapped client and `io()` replays deterministically; nothing else is claimed.

## D6 — Hybrid replay re-journals EVERYTHING into a new run (the closure property)

**Chose:** hybrid policy never mutates or extends the source run. It creates a child run and journals every event it serves — journal hits are copied (with a fresh `arrivalIndex` and a `replayedFromSeq` back-pointer), live fallbacks go through the exact same code path as plain recording (`performAndJournal` is shared, not duplicated).
**Rejected:** appending only the live misses to the source run — the source run stops being an immutable record of what actually happened, and the combined run is not replayable (its event order interleaves two different executions). Also rejected journaling only misses into the child run — then the child is a fragment that needs its parent plus consumption bookkeeping to replay; nothing downstream can treat runs uniformly.
**Consequence:** the invariant every workflow leans on: **any run in the journal — original, hybrid, or forked — replays fully offline under strict policy.** Runs are closed under replay. This is what makes "fork the past, compute the counterfactual future, then step through that future offline as many times as you want" a one-liner instead of a special case.

## D7 — Fork = copy prefix, rewrite one event, drop the future

**Chose:** `forkRun(journal, {from, atSeq, edit})` copies events `[0, atSeq)` verbatim into a child run (recording `parentRunId`/`forkedAtSeq` lineage), appends the event at `atSeq` with an edited response (same fingerprint, same request, `meta.edited: true`), and copies nothing after it.
**Rejected:** copying post-fork events too — once history changed at `atSeq`, the recorded future is a lie: later requests embedded the *original* response in their context, so their fingerprints can never match the diverged execution, and any that accidentally did match (context-independent requests) would serve stale answers for the wrong reason. The old future must be recomputed, not replayed. Also rejected editing in place — destroys the original run.
**Consequence:** replaying a fork under hybrid does exactly the right thing with zero fork-specific logic: prefix hits the journal, the edited event hits the journal, the first post-divergence request misses (its context now embeds the edit) and falls through live, and D6 guarantees the diverged future is captured as a new replayable run. Edited SSE responses are re-framed into chunks on `\n\n` event boundaries so SDK stream parsers still consume them incrementally.

## D5a — Copied events keep their original `arrivalIndex`; hybrid assigns fresh ones

**Chose:** fork-copied prefix events keep original meta untouched (they ARE the original events); hybrid-journaled events get the replaying session's own arrival counter, shared between hits and misses.
**Rejected:** reusing source arrivalIndexes during hybrid replay — hits and live misses would draw from two unrelated counters, producing collisions/gaps, and the child run would violate D5's pairing invariant on its next replay.
**Consequence:** every run in the journal satisfies the same D5 invariant by construction, so `EventCursor` needs no knowledge of where a run came from.
