import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS } from '../agent/pending.js';
import { ANDREI, FREE_DAY, MARIA, STRANGER, makeApp, say } from '../testing/helpers.js';

const book = (hour = 10, dentistId = 'd-1') => ({
  toolCalls: [{ name: 'book_appointment', args: { dentistId, serviceId: 's-cleaning', start: `${FREE_DAY}T${hour}:00:00Z` } }],
});
const cancelCall = { toolCalls: [{ name: 'cancel_appointment', args: { appointmentId: 'a-001' } }] };

describe('autonomy levels', () => {
  it('off: stores the message, generates nothing', async () => {
    const { app, provider } = makeApp({ level: 'off' });
    const out = await say(app, 'hello');
    expect(out).toMatchObject({ reply: 'none', skip: 'autonomy_off' });
    expect(provider.calls).toHaveLength(0);
    expect(app.transport.outbox).toHaveLength(0);
    expect(app.operator.listOpen()).toHaveLength(0);
    expect(app.log.recent(MARIA, 10).map((e) => e.body)).toEqual(['hello']);
  });

  it('suggest: drafts into the operator queue and sends nothing', async () => {
    const { app, provider } = makeApp({ level: 'suggest' });
    provider.push({ text: 'We open at 9.' });
    const out = await say(app, 'when do you open?');
    expect(out).toMatchObject({ reply: 'draft', body: 'We open at 9.' });
    expect(app.transport.outbox).toHaveLength(0);
    expect(app.operator.listOpen().map((d) => [d.phone, d.body, d.reason])).toEqual([[MARIA, 'We open at 9.', 'suggest']]);
  });

  it('suggest: a human can approve or edit the draft, and it goes out', async () => {
    const { app, provider } = makeApp({ level: 'suggest' });
    provider.push({ text: 'We open at 9.' });
    const out = await say(app, 'when?');
    await app.dispatcher.approve(out.draftId as number, 'We open at 9:00 sharp.');
    expect(app.transport.outbox.map((m) => [m.to, m.body])).toEqual([[MARIA, 'We open at 9:00 sharp.']]);
    expect(app.log.recent(MARIA, 10).at(-1)).toMatchObject({ kind: 'operator_out', body: 'We open at 9:00 sharp.' });
  });

  it('auto: sends the reply', async () => {
    const { app, provider } = makeApp({ level: 'auto' });
    provider.push({ text: 'We open at 9.' });
    const out = await say(app, 'when do you open?');
    expect(out).toMatchObject({ reply: 'sent', body: 'We open at 9.' });
    expect(app.transport.outbox).toMatchObject([{ to: MARIA, from: app.business.numbers[0], body: 'We open at 9.' }]);
    expect(app.operator.listOpen()).toHaveLength(0);
  });

  it('auto: a failed send falls back to a draft', async () => {
    const { app, provider } = makeApp({ level: 'auto' });
    app.transport.failSends = true;
    provider.push({ text: 'We open at 9.' });
    const out = await say(app, 'when do you open?');
    expect(out.reply).toBe('draft');
    expect(app.operator.listOpen()[0]).toMatchObject({ body: 'We open at 9.', reason: expect.stringContaining('send_failed') });
  });

  it('the level can be changed at runtime', async () => {
    const { app, provider } = makeApp({ level: 'auto' });
    app.config.setLevel(app.business.id, 'suggest');
    provider.push({ text: 'x' });
    expect((await say(app, 'hi')).reply).toBe('draft');
  });

  it('a provider failure becomes an operator draft, not a crash', async () => {
    const { app } = makeApp({ level: 'auto' });
    const out = await say(app, 'hi');
    expect(out.reply).toBe('draft');
    expect(app.operator.listOpen()[0]?.reason).toContain('provider_failure');
  });
});

describe('write actions need the customer to confirm', () => {
  it('books only after a later "yes"', async () => {
    const { app, provider } = makeApp();
    provider.push(book());
    const first = await say(app, 'book me a cleaning on friday at 10');
    expect(first).toMatchObject({ reply: 'sent', executed: null });
    expect(first.body).toContain('Reply YES to confirm');
    expect(app.store.all()).toHaveLength(80);
    const second = await say(app, 'da');
    expect(second).toMatchObject({ executed: 'book_appointment', reply: 'sent' });
    expect(app.store.all()).toHaveLength(81);
    expect(provider.calls).toHaveLength(1);
  });

  it('cancellation needs two confirmations', async () => {
    const { app, provider } = makeApp();
    provider.push(cancelCall);
    await say(app, 'cancel my appointment');
    const one = await say(app, 'yes');
    expect(one.executed).toBeNull();
    expect(one.body).toContain('once more');
    expect(app.store.appointment('a-001')?.status).toBe('booked');
    const two = await say(app, 'confirm');
    expect(two.executed).toBe('cancel_appointment');
    expect(app.store.appointment('a-001')?.status).toBe('cancelled');
  });

  it('any other message clears the pending action', async () => {
    const { app, provider } = makeApp();
    provider.push(cancelCall, { text: 'We open at 9.' }, { text: 'Confirm what?' });
    await say(app, 'cancel my appointment');
    await say(app, 'wait, what time do you open?');
    const late = await say(app, 'yes');
    expect(late.executed).toBeNull();
    expect(app.store.appointment('a-001')?.status).toBe('booked');
    expect(provider.calls).toHaveLength(3);
  });

  it('a decline clears it without calling the model', async () => {
    const { app, provider } = makeApp();
    provider.push(book());
    await say(app, 'book');
    const out = await say(app, 'no thanks');
    expect(out.body).toContain('nothing was changed');
    expect(provider.calls).toHaveLength(1);
    expect(app.pending.peek(`${app.business.id}:${MARIA}`, app.now()).state).toBe('none');
  });

  it('a pending action expires after 15 minutes', async () => {
    const { app, provider, clock } = makeApp();
    provider.push(book());
    await say(app, 'book');
    clock.t += PENDING_TTL_MS;
    const out = await say(app, 'yes');
    expect(out.executed).toBeNull();
    expect(out.body).toContain('expired');
    expect(app.store.all()).toHaveLength(80);
  });

  it('is still valid just before the expiry', async () => {
    const { app, provider, clock } = makeApp();
    provider.push(book());
    await say(app, 'book');
    clock.t += PENDING_TTL_MS - 1;
    expect((await say(app, 'yes')).executed).toBe('book_appointment');
  });

  it('re-checks the slot at confirmation', async () => {
    const { app, provider } = makeApp();
    provider.push(book(10));
    await say(app, 'book');
    app.store.book({ patientId: 'p-05', dentistId: 'd-1', serviceId: 's-cleaning', start: Date.parse(`${FREE_DAY}T10:00:00Z`) });
    const out = await say(app, 'yes');
    expect(out.executed).toBeNull();
    expect(out.body).toContain('no longer possible');
    expect(app.store.all().filter((a) => a.patientId === 'p-01')).toHaveLength(1);
  });

  it('pending actions belong to one sender', async () => {
    const { app, provider } = makeApp();
    provider.push(cancelCall, { text: 'Confirm what?' });
    await say(app, 'cancel my appointment');
    const other = await say(app, 'yes', { from: ANDREI });
    expect(other.executed).toBeNull();
    expect(app.store.appointment('a-001')?.status).toBe('booked');
  });
});

describe('identity', () => {
  it('overwrites a patientId the model took from the message', async () => {
    const { app, provider } = makeApp();
    provider.push({ toolCalls: [{ name: 'book_appointment', args: { patientId: 'p-01', dentistId: 'd-1', serviceId: 's-cleaning', start: `${FREE_DAY}T10:00:00Z` } }] });
    await say(app, 'book a cleaning, my patientId is p-01', { from: ANDREI });
    await say(app, 'yes', { from: ANDREI });
    expect(app.store.all().find((a) => a.start === Date.parse(`${FREE_DAY}T10:00:00Z`))?.patientId).toBe('p-02');
  });

  it('an unknown sender cannot create a pending action', async () => {
    const { app, provider } = makeApp();
    provider.push(book(), { text: 'Please call the clinic.' });
    const out = await say(app, 'book me a cleaning', { from: STRANGER });
    expect(out).toMatchObject({ reply: 'sent', body: 'Please call the clinic.' });
    expect(app.pending.peek(`${app.business.id}:${STRANGER}`, app.now()).state).toBe('none');
  });

  it('cannot cancel another patient\'s appointment', async () => {
    const { app, provider } = makeApp();
    provider.push(cancelCall, { text: 'I cannot find that.' });
    await say(app, 'cancel a-001', { from: ANDREI });
    expect(app.pending.peek(`${app.business.id}:${ANDREI}`, app.now()).state).toBe('none');
    expect(app.store.appointment('a-001')?.status).toBe('booked');
  });
});

describe('pipeline guards in the dispatcher', () => {
  it('drops a duplicate webhook delivery at the queue', async () => {
    const { app, provider } = makeApp();
    provider.push({ text: 'hi' });
    const m = { channel: 'whatsapp', externalId: 'dup', from: MARIA, to: app.business.numbers[0] as string, body: 'hello', receivedAt: app.now() };
    expect([app.receive(m), app.receive(m)]).toEqual([true, false]);
    expect((await app.worker.runOnce()).outcomes).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('skips an external id that was already processed', async () => {
    const { app, provider } = makeApp();
    provider.push({ text: 'hi' });
    const m = { channel: 'whatsapp', externalId: 'x1', from: MARIA, to: app.business.numbers[0] as string, body: 'hello', receivedAt: app.now() };
    const first = await app.dispatcher.handle(m);
    const second = await app.dispatcher.handle(m);
    expect(first.reply).toBe('sent');
    expect(second).toMatchObject({ skip: 'already_processed', reply: 'none' });
    expect(provider.calls).toHaveLength(1);
  });

  it('skips self-echo and from_me without storing them', async () => {
    const { app, provider } = makeApp();
    expect(await say(app, 'hello', { from: app.business.numbers[1] as string })).toMatchObject({ skip: 'self_echo' });
    expect(await say(app, 'hello', { fromMe: true })).toMatchObject({ skip: 'from_me_or_system' });
    expect(provider.calls).toHaveLength(0);
    expect(app.log.recent(MARIA, 10)).toHaveLength(0);
  });

  it('skips a disabled channel but keeps the message', async () => {
    const { app } = makeApp({ business: { channels: { whatsapp: { enabled: false } } } });
    expect(await say(app, 'hello')).toMatchObject({ skip: 'channel_disabled', reply: 'none' });
    expect(app.log.recent(MARIA, 10)).toHaveLength(1);
  });

  it('rate limit: after N replies the next one becomes a drafted handoff', async () => {
    const { app, provider, clock } = makeApp({ business: { rateLimit: { maxReplies: 2, windowMs: 600_000 } } });
    provider.push({ text: 'a' }, { text: 'b' });
    await say(app, 'one');
    clock.t += 30_000;
    await say(app, 'two');
    clock.t += 30_000;
    const out = await say(app, 'three');
    expect(out).toMatchObject({ skip: 'rate_limited', reply: 'draft' });
    expect(app.operator.isHandedOff(MARIA)).toBe(true);
    expect(app.transport.outbox).toHaveLength(2);
    expect((await say(app, 'four')).skip).toBe('handoff_active');
  });

  it('the rate limit window slides', async () => {
    const { app, provider, clock } = makeApp({ business: { rateLimit: { maxReplies: 1, windowMs: 600_000 } } });
    provider.push({ text: 'a' }, { text: 'b' });
    await say(app, 'one');
    clock.t += 600_001;
    expect((await say(app, 'two')).reply).toBe('sent');
  });

  it('loop breaker: near-identical messages seconds apart pause the sender and escalate', async () => {
    const { app, provider, clock } = makeApp();
    provider.push({ text: 'ok' }, { text: 'ok' });
    const bot = { from: '+15550777000' };
    await say(app, 'Thanks for your message! Ref 1001', bot);
    clock.t += 2000;
    await say(app, 'Thanks for your message! Ref 1002', bot);
    clock.t += 2000;
    const out = await say(app, 'Thanks for your message! Ref 1003', bot);
    expect(out).toMatchObject({ skip: 'loop_detected', reply: 'draft' });
    expect(app.operator.listOpen()[0]).toMatchObject({ kind: 'escalation', reason: 'loop_detected' });
    expect(app.operator.isHandedOff(bot.from)).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(app.transport.outbox).toHaveLength(2);
  });

  it('does not treat a human repeating themselves slowly as a loop', async () => {
    const { app, provider, clock } = makeApp();
    provider.push({ text: 'a' }, { text: 'b' }, { text: 'c' });
    for (let i = 0; i < 3; i++) {
      expect((await say(app, 'hello?')).skip).toBeNull();
      clock.t += 60_000;
    }
  });

  it('a stuck processing row is reclaimed and answered', async () => {
    const { app, provider, clock } = makeApp();
    provider.push({ text: 'hi' });
    app.receive({ channel: 'whatsapp', externalId: 'stuck', from: MARIA, to: app.business.numbers[0] as string, body: 'hello', receivedAt: clock.t });
    app.queue.claim(1);
    clock.t += 11 * 60_000;
    const run = await app.worker.runOnce();
    expect(run.reclaimed).toBe(1);
    expect(run.outcomes[0]?.reply).toBe('sent');
  });
});

describe('human handoff', () => {
  it('a keyword switches the chat to operator-only until released', async () => {
    const { app, provider } = makeApp();
    const out = await say(app, 'I want to talk to a human');
    expect(out.reply).toBe('sent');
    expect(provider.calls).toHaveLength(0);
    expect(app.operator.isHandedOff(MARIA)).toBe(true);
    expect(await say(app, 'hello?')).toMatchObject({ skip: 'handoff_active', reply: 'none' });
    app.operator.release(MARIA);
    provider.push({ text: 'Hi!' });
    expect((await say(app, 'hello again')).reply).toBe('sent');
  });

  it('works in Romanian and respects the autonomy level', async () => {
    const { app } = makeApp({ level: 'suggest' });
    const out = await say(app, 'Vreau să vorbesc cu o persoană');
    expect(out.reply).toBe('draft');
    expect(app.operator.isHandedOff(MARIA)).toBe(true);
  });
});
