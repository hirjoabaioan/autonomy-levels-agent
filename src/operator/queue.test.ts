import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { OperatorQueue } from './queue.js';

const draft = { channel: 'whatsapp', from: '+2', phone: '+1', body: 'hello', reason: 'suggest' };

describe('operator queue', () => {
  it('sends a draft as written, and records it as sent', async () => {
    const q = new OperatorQueue(openDb());
    const d = q.addDraft(draft);
    const sent: string[] = [];
    await q.approve(d.id, async (dr, body) => void sent.push(`${dr.phone}:${body}`));
    expect(sent).toEqual(['+1:hello']);
    expect(q.listOpen()).toHaveLength(0);
    await expect(q.approve(d.id, async () => {})).rejects.toThrow(/not open/);
  });

  it('sends the edited text instead of the draft', async () => {
    const q = new OperatorQueue(openDb());
    const d = q.addDraft(draft);
    let out = '';
    await q.approve(d.id, async (_d, body) => void (out = body), 'edited');
    expect(out).toBe('edited');
    expect(q.get(d.id)?.body).toBe('edited');
  });

  it('keeps the draft open when sending fails', async () => {
    const q = new OperatorQueue(openDb());
    const d = q.addDraft(draft);
    await expect(q.approve(d.id, async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect(q.listOpen()).toHaveLength(1);
  });

  it('refuses to send an escalation note verbatim', async () => {
    const q = new OperatorQueue(openDb());
    const d = q.addDraft({ ...draft, kind: 'escalation' });
    await expect(q.approve(d.id, async () => {})).rejects.toThrow(/escalation/);
    q.discard(d.id);
    expect(q.listOpen()).toHaveLength(0);
  });

  it('tracks handoffs until released', () => {
    const q = new OperatorQueue(openDb());
    q.startHandoff('+1', 'requested');
    expect(q.isHandedOff('+1')).toBe(true);
    expect(q.isHandedOff('+9')).toBe(false);
    expect(q.release('+1')).toBe(true);
    expect(q.isHandedOff('+1')).toBe(false);
    expect(q.release('+1')).toBe(false);
  });
});
