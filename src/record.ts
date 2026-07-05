import { fingerprint } from "./canonical.js";
import {
  encodeRequestRecord,
  encodeResponseEnvelope,
  headersToRecord,
  type RequestRecord,
} from "./envelope.js";
import type { Journal, RunId } from "./journal.js";

export async function requestFromFetchArgs(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<RequestRecord> {
  const req = new Request(input, init);
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.clone().text();
  return {
    url: req.url,
    method: req.method,
    headers: headersToRecord(req.headers),
    body: body === "" && init?.body === undefined ? null : body,
  };
}

export function createRecordingFetch(journal: Journal, run: RunId, base: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record = await requestFromFetchArgs(input, init);
    const fp = fingerprint(record);
    const started = performance.now();

    const res = await base(input, init);
    // Streamed responses are handled in the streaming path (Task 6/7).
    const bodyBytes = new Uint8Array(await res.clone().arrayBuffer());
    const durationMs = performance.now() - started;

    journal.appendEvent(run, {
      kind: "llm_call",
      fingerprint: fp,
      request: encodeRequestRecord(record),
      response: encodeResponseEnvelope({
        status: res.status,
        statusText: res.statusText,
        headers: headersToRecord(res.headers),
        streamed: false,
        body: bodyBytes,
        chunks: [],
        truncated: false,
      }),
      streamed: false,
      meta: {
        url: record.url,
        method: record.method,
        status: res.status,
        durationMs: Math.round(durationMs * 1000) / 1000,
      },
    });

    return res;
  }) as typeof fetch;
}
