import type Database from 'better-sqlite3';

export type DraftStatus = 'open' | 'sent' | 'discarded';
export type DraftKind = 'reply' | 'escalation';

export interface Draft {
  id: number;
  channel: string;
  /** The business number the reply goes out from. */
  from: string;
  phone: string;
  body: string;
  reason: string;
  kind: DraftKind;
  status: DraftStatus;
  createdAt: number;
}

interface RawDraft {
  id: number; channel: string; sender: string; phone: string; body: string; reason: string; kind: DraftKind; status: DraftStatus; created_at: number;
}

const toDraft = (r: RawDraft): Draft => ({
  id: r.id, channel: r.channel, from: r.sender, phone: r.phone, body: r.body, reason: r.reason, kind: r.kind, status: r.status, createdAt: r.created_at,
});

/** Drafts waiting for a human, plus the set of senders switched to operator-only. */
export class OperatorQueue {
  constructor(
    private db: Database.Database,
    private now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, sender TEXT NOT NULL, phone TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs (phone TEXT PRIMARY KEY, reason TEXT NOT NULL, since INTEGER NOT NULL);
    `);
  }

  addDraft(d: { channel: string; from: string; phone: string; body: string; reason: string; kind?: DraftKind }): Draft {
    const res = this.db
      .prepare(`INSERT INTO drafts (channel, sender, phone, body, reason, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(d.channel, d.from, d.phone, d.body, d.reason, d.kind ?? 'reply', this.now());
    return this.get(Number(res.lastInsertRowid)) as Draft;
  }

  get(id: number): Draft | undefined {
    const r = this.db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id) as RawDraft | undefined;
    return r && toDraft(r);
  }

  listOpen(): Draft[] {
    return (this.db.prepare(`SELECT * FROM drafts WHERE status = 'open' ORDER BY id`).all() as RawDraft[]).map(toDraft);
  }

  /** Sends the draft (optionally edited). It stays open if sending throws. */
  async approve(id: number, send: (draft: Draft, body: string) => Promise<void>, editedBody?: string): Promise<Draft> {
    const d = this.get(id);
    if (!d || d.status !== 'open') throw new Error(`draft ${id} is not open`);
    if (d.kind === 'escalation' && !editedBody) throw new Error(`draft ${id} is an escalation note; give it a reply text or discard it`);
    const body = editedBody ?? d.body;
    await send(d, body);
    this.db.prepare(`UPDATE drafts SET status = 'sent', body = ? WHERE id = ?`).run(body, id);
    return this.get(id) as Draft;
  }

  discard(id: number): void {
    this.db.prepare(`UPDATE drafts SET status = 'discarded' WHERE id = ? AND status = 'open'`).run(id);
  }

  startHandoff(phone: string, reason: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO handoffs (phone, reason, since) VALUES (?, ?, ?)`).run(phone, reason, this.now());
  }

  isHandedOff(phone: string): boolean {
    return this.db.prepare(`SELECT 1 FROM handoffs WHERE phone = ?`).get(phone) !== undefined;
  }

  release(phone: string): boolean {
    return this.db.prepare(`DELETE FROM handoffs WHERE phone = ?`).run(phone).changes > 0;
  }

  handoffs(): { phone: string; reason: string; since: number }[] {
    return this.db.prepare(`SELECT phone, reason, since FROM handoffs ORDER BY since`).all() as { phone: string; reason: string; since: number }[];
  }
}
