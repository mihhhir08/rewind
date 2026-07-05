import { createHash } from "node:crypto";

export interface CanonicalInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

// Headers that vary between attempts/environments without changing what the
// API returns. Everything NOT listed here is treated as semantic — e.g.
// anthropic-version and anthropic-beta change response shape and must
// contribute to request identity.
const VOLATILE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-request-id",
  "request-id",
  "date",
  "idempotency-key",
  "user-agent",
  "content-length",
  "accept-encoding",
  "connection",
  "host",
]);

const VOLATILE_HEADER_PREFIXES = ["x-stainless-"];

function isVolatileHeader(name: string): boolean {
  return VOLATILE_HEADERS.has(name) || VOLATILE_HEADER_PREFIXES.some((p) => name.startsWith(p));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalBody(body: string | null): { kind: "null" | "json" | "raw"; value: string | null } {
  if (body === null) return { kind: "null", value: null };
  try {
    return { kind: "json", value: JSON.stringify(sortJsonValue(JSON.parse(body))) };
  } catch {
    return { kind: "raw", value: body };
  }
}

export function canonicalize(input: CanonicalInput): string {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(input.headers).map((n) => n.toLowerCase()).sort()) {
    if (isVolatileHeader(name)) continue;
    const original = Object.keys(input.headers).find((n) => n.toLowerCase() === name);
    if (original !== undefined) headers[name] = input.headers[original]!;
  }

  const body = canonicalBody(input.body);
  return JSON.stringify({
    body: body.value,
    bodyKind: body.kind,
    headers,
    method: input.method.toUpperCase(),
    url: input.url,
  });
}

export function fingerprint(input: CanonicalInput): string {
  return createHash("sha256").update(canonicalize(input), "utf8").digest("hex");
}
