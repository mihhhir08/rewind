import { describe, expect, it } from "vitest";
import { canonicalize, fingerprint, type CanonicalInput } from "../src/canonical.js";

function req(overrides: Partial<CanonicalInput> = {}): CanonicalInput {
  return {
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
    ...overrides,
  };
}

describe("fingerprint: JSON body canonicalization", () => {
  it("is insensitive to JSON key order in the body", () => {
    const a = req({ body: '{"model":"m","max_tokens":64,"messages":[]}' });
    const b = req({ body: '{"max_tokens":64,"messages":[],"model":"m"}' });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("canonicalizes nested objects recursively", () => {
    const a = req({ body: '{"a":{"x":1,"y":{"p":1,"q":2}},"b":2}' });
    const b = req({ body: '{"b":2,"a":{"y":{"q":2,"p":1},"x":1}}' });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("preserves array order (message order is semantic)", () => {
    const a = req({
      body: JSON.stringify({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
      }),
    });
    const b = req({
      body: JSON.stringify({
        messages: [
          { role: "assistant", content: "second" },
          { role: "user", content: "first" },
        ],
      }),
    });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("differs when semantic body content differs", () => {
    const a = req();
    const b = req({
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        messages: [{ role: "user", content: "bye" }],
      }),
    });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("is insensitive to insignificant JSON whitespace", () => {
    const a = req({ body: '{"model": "m",  "max_tokens": 64}' });
    const b = req({ body: '{"model":"m","max_tokens":64}' });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe("fingerprint: headers", () => {
  it("ignores volatile headers", () => {
    const a = req();
    const b = req({
      headers: {
        ...req().headers,
        authorization: "Bearer sk-different",
        "x-api-key": "sk-ant-other",
        "x-request-id": "req_abc123",
        date: "Sat, 05 Jul 2026 00:00:00 GMT",
        "idempotency-key": "idem-999",
        "user-agent": "anthropic-sdk/0.99.0",
        "x-stainless-retry-count": "2",
        "x-stainless-runtime-version": "v22.1.0",
      },
    });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("is header-name case-insensitive", () => {
    const a = req({ headers: { "Content-Type": "application/json", "Anthropic-Version": "2023-06-01" } });
    const b = req({ headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" } });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("differs when semantic headers differ (anthropic-version changes response shape)", () => {
    const a = req();
    const b = req({ headers: { ...req().headers, "anthropic-version": "2024-01-01" } });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("differs when anthropic-beta features differ", () => {
    const a = req();
    const b = req({ headers: { ...req().headers, "anthropic-beta": "prompt-caching-2024-07-31" } });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("fingerprint: method, url, non-JSON and null bodies", () => {
  it("differs across urls", () => {
    expect(fingerprint(req())).not.toBe(fingerprint(req({ url: "https://api.anthropic.com/v1/complete" })));
  });

  it("is method case-insensitive but method-sensitive", () => {
    expect(fingerprint(req({ method: "post" }))).toBe(fingerprint(req({ method: "POST" })));
    expect(fingerprint(req({ method: "GET" }))).not.toBe(fingerprint(req({ method: "POST" })));
  });

  it("falls back to raw comparison for non-JSON bodies", () => {
    const a = req({ body: "not json" });
    const b = req({ body: "not json " });
    const c = req({ body: "not json" });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    expect(fingerprint(a)).toBe(fingerprint(c));
  });

  it("handles null body", () => {
    const a = req({ method: "GET", body: null });
    const b = req({ method: "GET", body: null });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint(req({ method: "GET", body: "" })));
  });
});

describe("canonicalize", () => {
  it("is deterministic and stable across calls", () => {
    expect(canonicalize(req())).toBe(canonicalize(req()));
  });

  it("produces parseable JSON (journal debuggability)", () => {
    expect(() => JSON.parse(canonicalize(req()))).not.toThrow();
  });
});
