export interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type FakeReply =
  | { status?: number; headers?: Record<string, string>; json: unknown }
  | { status?: number; headers?: Record<string, string>; sseChunks: string[] }
  | { status?: number; headers?: Record<string, string>; sseChunks: string[]; truncateAfterChunk: number };

export interface FakeAnthropic {
  fetch: typeof fetch;
  calls: () => number;
  requests: FakeRequest[];
}

let messageCounter = 0;

/** An Anthropic-shaped non-streaming /v1/messages response body. */
export function messageJson(text: string): unknown {
  messageCounter += 1;
  return {
    id: `msg_fake_${messageCounter}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** Anthropic-shaped SSE chunks for a streamed text response, deliberately
 * splitting one event across two chunks to exercise boundary fidelity. */
export function sseChunksForText(text: string): string[] {
  const mid = Math.ceil(text.length / 2);
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const startEvents =
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake_stream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }) + ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const delta1 = ev("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: text.slice(0, mid) },
  });
  const delta2 = ev("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: text.slice(mid) },
  });
  const endEvents =
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    ev("message_stop", { type: "message_stop" });

  // Split mid-event: delta1 is cut partway through its data line.
  const cut = Math.floor(delta1.length / 2);
  return [startEvents + delta1.slice(0, cut), delta1.slice(cut) + delta2, endEvents];
}

export function createFakeAnthropic(respond: (req: FakeRequest, callIndex: number) => FakeReply): FakeAnthropic {
  let count = 0;
  const requests: FakeRequest[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const fakeReq: FakeRequest = { url: req.url, method: req.method, headers, body };
    const callIndex = count;
    count += 1;
    requests.push(fakeReq);

    const reply = respond(fakeReq, callIndex);

    if ("json" in reply) {
      return new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", "request-id": `req_fake_${callIndex}`, ...reply.headers },
      });
    }

    const chunks = reply.sseChunks.map((c) => new TextEncoder().encode(c));
    const truncateAfter = "truncateAfterChunk" in reply ? reply.truncateAfterChunk : null;
    // Deliver via pull: erroring a stream discards its queue, so chunks must
    // be handed out one read at a time before the truncation error fires.
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (truncateAfter !== null && next > truncateAfter) {
          controller.error(new Error("connection reset (fake)"));
          return;
        }
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[next]!);
        next += 1;
      },
    });
    return new Response(stream, {
      status: reply.status ?? 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "request-id": `req_fake_${callIndex}`, ...reply.headers },
    });
  }) as typeof fetch;

  return { fetch: fakeFetch, calls: () => count, requests };
}
