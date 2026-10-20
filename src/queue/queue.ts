import type Database from 'better-sqlite3';
import type { InboundMessage } from '../channel/types.js';
import { MIN } from '../domain/time.js';

export const STALE_AFTER_MS = 10 * MIN;
export const MAX_ATTEMPTS = 5;

export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface QueueRow {
  id: number;
  status: QueueStatus;
  attempts: number;
  lastError: string | null;
  message: InboundMessage;
}

interface RawRow {
  id: number;
  status: QueueStatus;
  attempts: number;
  last_error: string | null;
  payload: string;
}

const toRow = (r: RawRow): QueueRow => ({
  id: r.id, status: r.status, attempts: r.attempts, lastError: r.last_error, message: JSON.parse(r.payload) as InboundMessage,
});

/** Webhook -> queue. Dedup is the UNIQUE key; crash recovery is the stale-claim reclaim. */
export class InboundQueue {
  constructor(
    private db: Database.Database,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (channel, external_message_id)
    )`);
  }

  /** Returns false when this delivery is a duplicate of one already queued. */
  enqueue(msg: InboundMessage): boolean {
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO inbound (channel, external_message_id, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(msg.channel, msg.externalId, JSON.stringify(msg), this.now());
    return res.changes === 1;
  }

  claim(limit: number): { rows: QueueRow[]; reclaimed: number } {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const stale = `status = 'processing' AND claimed_at <= ?`;
      this.db
        .prepare(`UPDATE inbound SET status = 'failed', last_error = 'stuck in processing, max attempts reached' WHERE ${stale} AND attempts >= ?`)
        .run(now - STALE_AFTER_MS, MAX_ATTEMPTS);
      const reclaimed = this.db
        .prepare(`UPDATE inbound SET status = 'pending', last_error = 'reclaimed after stuck in processing' WHERE ${stale} AND attempts < ?`)
        .run(now - STALE_AFTER_MS, MAX_ATTEMPTS).changes;
      const raw = this.db
        .prepare(`SELECT * FROM inbound WHERE status = 'pending' AND attempts < ? ORDER BY id LIMIT ?`)
        .all(MAX_ATTEMPTS, limit) as RawRow[];
      const mark = this.db.prepare(`UPDATE inbound SET status = 'processing', attempts = attempts + 1, claimed_at = ? WHERE id = ?`);
      for (const r of raw) mark.run(now, r.id);
      return { rows: raw.map((r) => toRow({ ...r, status: 'processing', attempts: r.attempts + 1 })), reclaimed };
    });
    return tx();
  }

  complete(id: number): void {
    this.db.prepare(`UPDATE inbound SET status = 'done' WHERE id = ?`).run(id);
  }

  /** Back to pending for a retry, or failed for good once attempts are used up. */
  fail(id: number, error: string): void {
    this.db
      .prepare(`UPDATE inbound SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, last_error = ? WHERE id = ?`)
      .run(MAX_ATTEMPTS, error, id);
  }

  get(id: number): QueueRow | undefined {
    const r = this.db.prepare(`SELECT * FROM inbound WHERE id = ?`).get(id) as RawRow | undefined;
    return r && toRow(r);
  }

  counts(): Record<QueueStatus, number> {
    const out: Record<QueueStatus, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const r of this.db.prepare(`SELECT status, COUNT(*) AS n FROM inbound GROUP BY status`).all() as { status: QueueStatus; n: number }[]) {
      out[r.status] = r.n;
    }
    return out;
  }
}
