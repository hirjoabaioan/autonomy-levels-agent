import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { MIN } from '../domain/time.js';
import { InboundQueue, MAX_ATTEMPTS, STALE_AFTER_MS } from './queue.js';
import { Worker } from './worker.js';

const msg = (id: string, channel = 'whatsapp') => ({
  channel, externalId: id, from: '+1', to: '+2', body: 'hi', receivedAt: 0,
});

function setup() {
  const clock = { t: 1_000_000 };
  const queue = new InboundQueue(openDb(), () => clock.t);
  return { queue, clock };
}

describe('inbound queue', () => {
  it('dedups on (channel, external_message_id)', () => {
    const { queue } = setup();
    expect(queue.enqueue(msg('m1'))).toBe(true);
    expect(queue.enqueue(msg('m1'))).toBe(false);
    expect(queue.enqueue(msg('m1', 'sms'))).toBe(true);
    expect(queue.claim(10).rows).toHaveLength(2);
  });

  it('does not hand out a claimed row twice', () => {
    const { queue } = setup();
    queue.enqueue(msg('m1'));
    expect(queue.claim(10).rows).toHaveLength(1);
    expect(queue.claim(10).rows).toHaveLength(0);
  });

  it('reclaims rows stuck in processing for more than 10 minutes', () => {
    const { queue, clock } = setup();
    queue.enqueue(msg('m1'));
    queue.claim(1);
    clock.t += STALE_AFTER_MS - 1;
    expect(queue.claim(1)).toEqual({ rows: [], reclaimed: 0 });
    clock.t += 1;
    const again = queue.claim(1);
    expect(again.reclaimed).toBe(1);
    expect(again.rows[0]?.attempts).toBe(2);
  });

  it('stops after 5 attempts', () => {
    const { queue } = setup();
    queue.enqueue(msg('m1'));
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const { rows } = queue.claim(1);
      expect(rows).toHaveLength(1);
      queue.fail(rows[0]?.id as number, `boom ${i}`);
    }
    expect(queue.claim(1).rows).toHaveLength(0);
    expect(queue.counts().failed).toBe(1);
  });

  it('marks a stuck row failed when it has no attempts left', () => {
    const { queue, clock } = setup();
    queue.enqueue(msg('m1'));
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      queue.fail(queue.claim(1).rows[0]?.id as number, 'x');
    }
    queue.claim(1);
    clock.t += 11 * MIN;
    expect(queue.claim(1)).toEqual({ rows: [], reclaimed: 0 });
    expect(queue.counts().failed).toBe(1);
  });
});

describe('worker', () => {
  it('completes handled rows and retries ones whose handler throws', async () => {
    const { queue } = setup();
    queue.enqueue(msg('ok'));
    queue.enqueue(msg('bad'));
    let badCalls = 0;
    const worker = new Worker(queue, async (m) => {
      if (m.externalId === 'bad' && ++badCalls < 2) throw new Error('transient');
      return m.externalId;
    });
    const first = await worker.runOnce();
    expect(first.outcomes).toEqual(['ok']);
    expect(first.failed).toBe(1);
    const second = await worker.runOnce();
    expect(second.outcomes).toEqual(['bad']);
    expect(queue.counts()).toMatchObject({ done: 2, pending: 0 });
  });
});
