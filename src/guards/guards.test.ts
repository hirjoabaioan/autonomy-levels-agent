import { describe, expect, it } from 'vitest';
import { harborDental } from '../autonomy/config.js';
import type { InboundMessage } from '../channel/types.js';
import {
  alreadyProcessed, autonomyOff, channelDisabled, firstSkip, fromMeOrSystem, handoffActive, loopDetected, rateLimited,
  selfEcho, type GuardContext,
} from './guards.js';
import { looksLikeLoop, similarity } from './loopBreaker.js';
import { rateLimitExceeded } from './rateLimit.js';

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: 'whatsapp', externalId: 'm1', from: '+15550100001', to: '+15550190000', body: 'hello', receivedAt: 1_000_000, ...over,
});

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  msg: msg(), business: harborDental(), now: 1_000_000, processed: false, handoffActive: false, recentInbound: [], botReplyTimes: [], ...over,
});

describe('guards', () => {
  it('lets a normal message through', () => {
    expect(firstSkip(ctx())).toBeNull();
  });

  it('skips from_me and system messages', () => {
    expect(fromMeOrSystem(ctx({ msg: msg({ fromMe: true }) }))).toBe('from_me_or_system');
    expect(fromMeOrSystem(ctx({ msg: msg({ system: true }) }))).toBe('from_me_or_system');
    expect(fromMeOrSystem(ctx())).toBeNull();
  });

  it('skips self-echo from any of the business numbers', () => {
    for (const n of harborDental().numbers) expect(selfEcho(ctx({ msg: msg({ from: n }) }))).toBe('self_echo');
    expect(selfEcho(ctx())).toBeNull();
  });

  it('skips an already processed external id', () => {
    expect(alreadyProcessed(ctx({ processed: true }))).toBe('already_processed');
    expect(alreadyProcessed(ctx())).toBeNull();
  });

  it('skips a disabled or unknown channel', () => {
    const business = harborDental({ channels: { whatsapp: { enabled: false } } });
    expect(channelDisabled(ctx({ business }))).toBe('channel_disabled');
    expect(channelDisabled(ctx({ msg: msg({ channel: 'sms' }) }))).toBe('channel_disabled');
    expect(channelDisabled(ctx())).toBeNull();
  });

  it('skips when the level is off', () => {
    expect(autonomyOff(ctx({ business: harborDental({ level: 'off' }) }))).toBe('autonomy_off');
    expect(autonomyOff(ctx())).toBeNull();
  });

  it('skips while a handoff is active', () => {
    expect(handoffActive(ctx({ handoffActive: true }))).toBe('handoff_active');
  });

  it('flags the rate limit and the loop', () => {
    const times = Array.from({ length: 6 }, (_, i) => 1_000_000 - i * 1000);
    expect(rateLimited(ctx({ botReplyTimes: times }))).toBe('rate_limited');
    const prior = [{ body: 'Reply STOP to opt out', ts: 990_000 }, { body: 'Reply STOP to opt out', ts: 995_000 }];
    expect(loopDetected(ctx({ recentInbound: prior, msg: msg({ body: 'Reply STOP to opt out', receivedAt: 999_000 }) }))).toBe('loop_detected');
  });

  it('reports the first applicable reason in order', () => {
    expect(firstSkip(ctx({ msg: msg({ fromMe: true, from: '+15550190000' }), processed: true }))).toBe('from_me_or_system');
  });
});

describe('rate limit', () => {
  const now = 10 * 60_000;
  it('allows fewer than max replies in the window', () => {
    expect(rateLimitExceeded([now - 1000, now - 2000], now, 3, 600_000)).toBe(false);
  });
  it('blocks at max replies', () => {
    expect(rateLimitExceeded([now - 1000, now - 2000, now - 3000], now, 3, 600_000)).toBe(true);
  });
  it('ignores replies older than the window', () => {
    expect(rateLimitExceeded([1, 2, 3], now + 1_000_000, 3, 600_000)).toBe(false);
  });
});

describe('loop breaker', () => {
  const same = (n: number, gap: number, body = 'Thanks for contacting us! Ticket 123') =>
    Array.from({ length: n }, (_, i) => ({ body: body.replace('123', String(100 + i)), ts: i * gap }));

  it('detects K near-identical messages seconds apart', () => {
    expect(looksLikeLoop(same(3, 2000), 3, 10_000, 0.8)).toBe(true);
  });
  it('needs at least K messages', () => {
    expect(looksLikeLoop(same(2, 2000), 3, 10_000, 0.8)).toBe(false);
  });
  it('does not fire when messages are far apart', () => {
    expect(looksLikeLoop(same(3, 60_000), 3, 10_000, 0.8)).toBe(false);
  });
  it('does not fire for different messages', () => {
    const mixed = [{ body: 'Hi', ts: 0 }, { body: 'Can I book a cleaning on Friday?', ts: 1000 }, { body: 'Also what are your prices', ts: 2000 }];
    expect(looksLikeLoop(mixed, 3, 10_000, 0.8)).toBe(false);
  });
  it('ignores digits and punctuation when comparing', () => {
    expect(similarity('Order #12 received!', 'Order #99 received?')).toBe(1);
    expect(similarity('apples and pears', 'completely different words')).toBe(0);
  });
});
