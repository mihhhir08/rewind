export interface RequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ResponseEnvelope {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  streamed: boolean;
  /** Whole body for non-streamed responses; empty for streamed. */
  body: Uint8Array;
  /** Exact chunk sequence for streamed responses; empty for non-streamed. */
  chunks: Uint8Array[];
  /** True if the recorded stream ended with an error instead of a clean close. */
  truncated: boolean;
}

interface WireEnvelope {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  streamed: boolean;
  bodyB64: string;
  chunksB64: string[];
  truncated: boolean;
}

export function encodeRequestRecord(r: RequestRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(r));
}

export function decodeRequestRecord(data: Uint8Array): RequestRecord {
  return JSON.parse(new TextDecoder().decode(data)) as RequestRecord;
}

export function encodeResponseEnvelope(e: ResponseEnvelope): Uint8Array {
  const wire: WireEnvelope = {
    status: e.status,
    statusText: e.statusText,
    headers: e.headers,
    streamed: e.streamed,
    bodyB64: Buffer.from(e.body).toString("base64"),
    chunksB64: e.chunks.map((c) => Buffer.from(c).toString("base64")),
    truncated: e.truncated,
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

export function decodeResponseEnvelope(data: Uint8Array): ResponseEnvelope {
  const wire = JSON.parse(new TextDecoder().decode(data)) as WireEnvelope;
  return {
    status: wire.status,
    statusText: wire.statusText,
    headers: wire.headers,
    streamed: wire.streamed,
    body: new Uint8Array(Buffer.from(wire.bodyB64, "base64")),
    chunks: wire.chunksB64.map((c) => new Uint8Array(Buffer.from(c, "base64"))),
    truncated: wire.truncated,
  };
}

export function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** Rebuild a fetch Response from an envelope. Streamed envelopes become a
 * pull-based stream reproducing the recorded chunk boundaries; a recorded
 * truncation replays as a mid-stream error after the last captured chunk. */
export function envelopeToResponse(e: ResponseEnvelope): Response {
  const init = { status: e.status, statusText: e.statusText, headers: e.headers };

  if (e.streamed) {
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < e.chunks.length) {
          controller.enqueue(e.chunks[next]!);
          next += 1;
          return;
        }
        if (e.truncated) controller.error(new Error("[rewind] stream truncated (recorded upstream abort)"));
        else controller.close();
      },
    });
    return new Response(stream, init);
  }

  const bodyAllowed = e.status !== 204 && e.status !== 205 && e.status !== 304;
  return new Response(bodyAllowed ? Buffer.from(e.body) : null, init);
}
