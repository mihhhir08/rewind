import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export type RunId = string;
export type EventKind = "llm_call" | "io";

export type EventMeta = Record<string, unknown>;

export interface NewEvent {
  kind: EventKind;
  fingerprint: string;
  request: Uint8Array;
  response: Uint8Array;
  streamed: boolean;
  meta: EventMeta;
}

export interface JournalEvent extends NewEvent {
  seq: number;
  runId: RunId;
  createdAt: string;
}

export interface RunSummary {
  id: RunId;
  label: string | null;
  parentRunId: RunId | null;
  forkedAtSeq: number | null;
  createdAt: string;
  eventCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  label TEXT,
  parent_run_id TEXT REFERENCES runs(id),
  forked_at_seq INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  request_hash TEXT NOT NULL REFERENCES blobs(hash),
  response_hash TEXT NOT NULL REFERENCES blobs(hash),
  streamed INTEGER NOT NULL,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events(run_id, fingerprint, seq);
`;

function blobHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export class Journal {
  private constructor(private readonly db: Database.Database) {}

  static open(path: string): Journal {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    return new Journal(db);
  }

  createRun(meta: { label?: string; parentRunId?: RunId; forkedAtSeq?: number }): RunId {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO runs (id, label, parent_run_id, forked_at_seq) VALUES (?, ?, ?, ?)")
      .run(id, meta.label ?? null, meta.parentRunId ?? null, meta.forkedAtSeq ?? null);
    return id;
  }

  private putBlob(data: Uint8Array): string {
    const hash = blobHash(data);
    this.db
      .prepare("INSERT INTO blobs (hash, data) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING")
      .run(hash, Buffer.from(data));
    return hash;
  }

  appendEvent(run: RunId, e: NewEvent): number {
    const append = this.db.transaction((): number => {
      const requestHash = this.putBlob(e.request);
      const responseHash = this.putBlob(e.response);
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE run_id = ?")
        .get(run) as { next: number };
      this.db
        .prepare(
          `INSERT INTO events (run_id, seq, kind, fingerprint, request_hash, response_hash, streamed, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(run, row.next, e.kind, e.fingerprint, requestHash, responseHash, e.streamed ? 1 : 0, JSON.stringify(e.meta));
      return row.next;
    });
    return append();
  }

  eventsForRun(run: RunId): JournalEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.kind, e.fingerprint, e.streamed, e.meta, e.created_at,
                req.data AS request, res.data AS response
         FROM events e
         JOIN blobs req ON req.hash = e.request_hash
         JOIN blobs res ON res.hash = e.response_hash
         WHERE e.run_id = ?
         ORDER BY e.seq ASC`,
      )
      .all(run) as Array<{
      seq: number;
      kind: string;
      fingerprint: string;
      streamed: number;
      meta: string;
      created_at: string;
      request: Buffer;
      response: Buffer;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      runId: run,
      kind: r.kind as EventKind,
      fingerprint: r.fingerprint,
      request: new Uint8Array(r.request),
      response: new Uint8Array(r.response),
      streamed: r.streamed === 1,
      meta: JSON.parse(r.meta) as EventMeta,
      createdAt: r.created_at,
    }));
  }

  runs(): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.label, r.parent_run_id, r.forked_at_seq, r.created_at,
                (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id) AS event_count
         FROM runs r ORDER BY r.created_at ASC, r.id ASC`,
      )
      .all() as Array<{
      id: string;
      label: string | null;
      parent_run_id: string | null;
      forked_at_seq: number | null;
      created_at: string;
      event_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      parentRunId: r.parent_run_id,
      forkedAtSeq: r.forked_at_seq,
      createdAt: r.created_at,
      eventCount: r.event_count,
    }));
  }

  stats(): { runs: number; events: number; blobs: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      runs: one("SELECT COUNT(*) AS n FROM runs"),
      events: one("SELECT COUNT(*) AS n FROM events"),
      blobs: one("SELECT COUNT(*) AS n FROM blobs"),
    };
  }

  close(): void {
    this.db.close();
  }
}
