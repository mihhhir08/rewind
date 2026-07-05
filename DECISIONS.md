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

## D4 — Explicit `io()` wrapper for tools, not automatic interception

**Chose:** side effects outside the LLM call (tool executions, `Date.now`, `Math.random`) are journaled via an explicit `io("name", fn)` wrapper.
**Rejected:** automatic syscall/module interception (rr-style) — that is a different, much larger project, and half-automatic capture would create a false sense of coverage.
**Consequence:** the determinism boundary is explicit and honest: what flows through the wrapped client and `io()` replays deterministically; nothing else is claimed.
