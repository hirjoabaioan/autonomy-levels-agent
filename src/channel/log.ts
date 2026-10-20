import type Database from 'better-sqlite3';

export type LogKind = 'in' | 'bot_out' | 'bot_draft' | 'operator_out';

export interface LogEntry {
  kind: LogKind;
  phone: string;
  body: string;
  ts: number;
  externalId: string | null;
}

/** Conversation history plus the "already processed" ledger. */
export class MessageLog {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, phone TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL,
        channel TEXT, external_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_in_uniq ON messages(channel, external_id) WHERE kind = 'in';
      CREATE TABLE IF NOT EXISTS processed (
        channel TEXT NOT NULL, external_id TEXT NOT NULL, PRIMARY KEY (channel, external_id)
      );
    `);
  }

  /** Idempotent for inbound rows, so a retried message is not stored twice. */
  addInbound(channel: string, externalId: string, phone: string, body: string, ts: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO messages (kind, phone, body, ts, channel, external_id) VALUES ('in', ?, ?, ?, ?, ?)`)
      .run(phone, body, ts, channel, externalId);
  }

  add(kind: Exclude<LogKind, 'in'>, phone: string, body: string, ts: number): void {
    this.db.prepare(`INSERT INTO messages (kind, phone, body, ts) VALUES (?, ?, ?, ?)`).run(kind, phone, body, ts);
  }

  markProcessed(channel: string, externalId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO processed (channel, external_id) VALUES (?, ?)`).run(channel, externalId);
  }

  isProcessed(channel: string, externalId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM processed WHERE channel = ? AND external_id = ?`).get(channel, externalId) !== undefined;
  }

  /** Oldest first. */
  recent(phone: string, limit: number): LogEntry[] {
    const rows = this.db
      .prepare(`SELECT kind, phone, body, ts, external_id AS externalId FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?`)
      .all(phone, limit) as LogEntry[];
    return rows.reverse();
  }

  recentInbound(phone: string, limit: number, excludeExternalId?: string): { body: string; ts: number }[] {
    const rows = this.db
      .prepare(
        `SELECT body, ts FROM messages WHERE phone = ? AND kind = 'in' AND (external_id IS NOT ? ) ORDER BY id DESC LIMIT ?`,
      )
      .all(phone, excludeExternalId ?? null, limit) as { body: string; ts: number }[];
    return rows.reverse();
  }

  botReplyTimes(phone: string, since: number): number[] {
    const rows = this.db
      .prepare(`SELECT ts FROM messages WHERE phone = ? AND kind IN ('bot_out', 'bot_draft') AND ts > ? ORDER BY ts`)
      .all(phone, since) as { ts: number }[];
    return rows.map((r) => r.ts);
  }
}
