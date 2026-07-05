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
    const isEventStream = (res.headers.get("content-type") ?? "").includes("text/event-stream");

    const journalEvent = (envelope: { streamed: boolean; body: Uint8Array; chunks: Uint8Array[]; truncated: boolean }) => {
      journal.appendEvent(run, {
        kind: "llm_call",
        fingerprint: fp,
        request: encodeRequestRecord(record),
        response: encodeResponseEnvelope({
          status: res.status,
          statusText: res.statusText,
          headers: headersToRecord(res.headers),
          ...envelope,
        }),
        streamed: envelope.streamed,
        meta: {
          url: record.url,
          method: record.method,
          status: res.status,
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
          ...(envelope.truncated ? { truncated: true } : {}),
        },
      });
    };

    if (!isEventStream || res.body === null) {
      const bodyBytes = new Uint8Array(await res.clone().arrayBuffer());
      journalEvent({ streamed: false, body: bodyBytes, chunks: [], truncated: false });
      return res;
    }

    // Streaming: tee chunk-by-chunk so the consumer sees the exact upstream
    // framing, and journal the framed chunk log when the stream settles.
    const upstream = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let settled = false;
    const settle = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      journalEvent({ streamed: true, body: new Uint8Array(0), chunks, truncated });
    };

    const tee = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await upstream.read();
          if (done) {
            settle(false);
            controller.close();
            return;
          }
          chunks.push(value);
          controller.enqueue(value);
        } catch (err) {
          settle(true);
          controller.error(err);
        }
      },
      async cancel(reason) {
        settle(true);
        await upstream.cancel(reason);
      },
    });

    return new Response(tee, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}
