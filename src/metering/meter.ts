import type Database from 'better-sqlite3';
import { openDb } from '../db.js';

export interface CallRecord {
  conversationId: string;
  iteration: number;
  provider: string;
  model: string;
  success: boolean;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  durationMs: number;
}

export interface CallRow {
  id: number;
  ts: number;
  conversation_id: string;
  iteration: number;
  provider: string;
  model: string;
  success: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number | null;
  duration_ms: number;
}

export interface MeterSink {
  record(call: CallRecord): void;
}

export const DEFAULT_DB_PATH = process.env.METER_DB ?? './data/meter.db';

export class Meter implements MeterSink {
  private db: Database.Database;

  constructor(
    path = DEFAULT_DB_PATH,
    private now: () => number = Date.now,
  ) {
    this.db = openDb(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      success INTEGER NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      cost_usd REAL,
      duration_ms INTEGER NOT NULL
    )`);
  }

  record(c: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO calls (ts, conversation_id, iteration, provider, model, success, tokens_in, tokens_out, cost_usd, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.now(), c.conversationId, c.iteration, c.provider, c.model, c.success ? 1 : 0, c.tokensIn, c.tokensOut, c.costUsd, Math.round(c.durationMs));
  }

  rows(): CallRow[] {
    return this.db.prepare('SELECT * FROM calls ORDER BY id').all() as CallRow[];
  }

  close(): void {
    this.db.close();
  }
}
