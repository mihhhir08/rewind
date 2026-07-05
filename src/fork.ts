import { decodeResponseEnvelope, encodeResponseEnvelope } from "./envelope.js";
import type { Journal, JournalEvent, RunId } from "./journal.js";

export interface ForkOptions {
  from: RunId;
  /** Seq of the event to rewrite. Events before it are copied verbatim;
   * events after it are dropped (the future is unknowable once history changed). */
  atSeq: number;
  label?: string;
  /** Receives the event at atSeq; returns the replacement response bytes
   * (use editResponseBody for llm_call events). */
  edit: (event: JournalEvent) => Uint8Array;
}

/** Create a new run that shares history with `from` up to (not including)
 * atSeq, then diverges with an edited event. Replay the fork under hybrid
 * policy to compute the counterfactual future. */
export function forkRun(journal: Journal, opts: ForkOptions): RunId {
  const events = journal.eventsForRun(opts.from);
  if (!Number.isInteger(opts.atSeq) || opts.atSeq < 0 || opts.atSeq >= events.length) {
    throw new Error(
      `[rewind] fork atSeq ${opts.atSeq} is out of range for run ${opts.from} (${events.length} events, valid: 0..${events.length - 1})`,
    );
  }

  const forkId = journal.createRun({
    parentRunId: opts.from,
    forkedAtSeq: opts.atSeq,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  });

  for (const e of events.slice(0, opts.atSeq)) {
    journal.appendEvent(forkId, {
      kind: e.kind,
      fingerprint: e.fingerprint,
      request: e.request,
      response: e.response,
      streamed: e.streamed,
      meta: e.meta,
    });
  }

  const target = events[opts.atSeq]!;
  const editedResponse = opts.edit(target);
  const streamed = target.kind === "llm_call" ? decodeResponseEnvelope(editedResponse).streamed : false;
  journal.appendEvent(forkId, {
    kind: target.kind,
    fingerprint: target.fingerprint,
    request: target.request,
    response: editedResponse,
    streamed,
    meta: { ...target.meta, edited: true },
  });

  return forkId;
}

/** Rewrite just the assistant text inside a recorded (non-streamed) Anthropic
 * message, keeping ids, usage, stop_reason and the rest of the shape intact —
 * the ergonomic path for "what if the model had said X". */
export function editResponseText(event: JournalEvent, newText: string): Uint8Array {
  const envelope = decodeResponseEnvelope(event.response);
  if (envelope.streamed) {
    throw new Error(
      "[rewind] editResponseText only supports non-streamed responses — for streamed events, pass full SSE text to editResponseBody",
    );
  }
  const message = JSON.parse(new TextDecoder().decode(envelope.body)) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = message.content?.find((b) => b.type === "text");
  if (textBlock === undefined) {
    throw new Error("[rewind] recorded response has no text content block to edit");
  }
  textBlock.text = newText;
  return editResponseBody(event, JSON.stringify(message));
}

/** Rewrite an llm_call event's response body, preserving status and headers.
 * Streamed responses are re-framed: the new SSE text is split back into
 * chunks on event boundaries ("\n\n") so SDK stream parsers can still
 * consume the edited replay incrementally. */
export function editResponseBody(event: JournalEvent, newBody: string): Uint8Array {
  const envelope = decodeResponseEnvelope(event.response);
  const enc = new TextEncoder();

  if (!envelope.streamed) {
    return encodeResponseEnvelope({ ...envelope, body: enc.encode(newBody), chunks: [], truncated: false });
  }

  const chunks: Uint8Array[] = [];
  let rest = newBody;
  while (rest.length > 0) {
    const boundary = rest.indexOf("\n\n");
    if (boundary === -1) {
      chunks.push(enc.encode(rest));
      break;
    }
    chunks.push(enc.encode(rest.slice(0, boundary + 2)));
    rest = rest.slice(boundary + 2);
  }
  return encodeResponseEnvelope({ ...envelope, body: new Uint8Array(0), chunks, truncated: false });
}
