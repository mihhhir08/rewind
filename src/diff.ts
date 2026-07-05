import type { EventKind, Journal, JournalEvent, RunId } from "./journal.js";

export type DiffStatus = "same" | "changed" | "only-in-a" | "only-in-b";

export interface DiffEntry {
  seq: number;
  status: DiffStatus;
  kind: EventKind;
  /** Human-readable identity: "POST https://…" or "io(name)". */
  what: string;
  /** True when the request fingerprints match but responses differ —
   * distinguishes "same question, different answer" from full divergence. */
  sameRequest: boolean;
}

export interface RunDiff {
  a: RunId;
  b: RunId;
  /** Seq of the first non-`same` entry, or null when runs are identical. */
  firstDivergenceSeq: number | null;
  entries: DiffEntry[];
}

export function eventWhat(e: JournalEvent): string {
  if (e.kind === "io") return `io(${String(e.meta["name"] ?? "?")})`;
  return `${String(e.meta["method"] ?? "?")} ${String(e.meta["url"] ?? "?")}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Positional diff of two runs. Events are compared seq-by-seq: same
 * fingerprint + same response bytes → `same`; anything else → `changed`.
 * Positional comparison is the honest choice — event order IS the execution,
 * so aligning "similar" events across positions would hide reordering bugs. */
export function diffRuns(journal: Journal, a: RunId, b: RunId): RunDiff {
  const eventsA = journal.eventsForRun(a);
  const eventsB = journal.eventsForRun(b);
  const entries: DiffEntry[] = [];

  for (let seq = 0; seq < Math.max(eventsA.length, eventsB.length); seq++) {
    const ea = eventsA[seq];
    const eb = eventsB[seq];
    if (ea !== undefined && eb !== undefined) {
      const sameRequest = ea.fingerprint === eb.fingerprint;
      const status: DiffStatus = sameRequest && bytesEqual(ea.response, eb.response) ? "same" : "changed";
      entries.push({ seq, status, kind: ea.kind, what: eventWhat(ea), sameRequest });
    } else if (ea !== undefined) {
      entries.push({ seq, status: "only-in-a", kind: ea.kind, what: eventWhat(ea), sameRequest: false });
    } else {
      const e = eb!;
      entries.push({ seq, status: "only-in-b", kind: e.kind, what: eventWhat(e), sameRequest: false });
    }
  }

  const firstDivergence = entries.find((e) => e.status !== "same");
  return { a, b, firstDivergenceSeq: firstDivergence?.seq ?? null, entries };
}
