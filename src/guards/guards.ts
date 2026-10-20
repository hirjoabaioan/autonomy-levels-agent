import type { BusinessConfig } from '../autonomy/config.js';
import type { InboundMessage } from '../channel/types.js';
import { looksLikeLoop, type TimedText } from './loopBreaker.js';
import { rateLimitExceeded } from './rateLimit.js';

export interface GuardContext {
  msg: InboundMessage;
  business: BusinessConfig;
  now: number;
  processed: boolean;
  handoffActive: boolean;
  /** Earlier inbound messages from this sender, oldest first, excluding `msg`. */
  recentInbound: TimedText[];
  /** Timestamps of recent bot replies (sent or drafted) to this sender. */
  botReplyTimes: number[];
}

/** A guard is a pure function: a skip reason, or null to let the message through. */
export type Guard = (c: GuardContext) => string | null;

export const fromMeOrSystem: Guard = (c) => (c.msg.fromMe || c.msg.system ? 'from_me_or_system' : null);
export const selfEcho: Guard = (c) => (c.business.numbers.includes(c.msg.from) ? 'self_echo' : null);
export const alreadyProcessed: Guard = (c) => (c.processed ? 'already_processed' : null);
export const channelDisabled: Guard = (c) => (c.business.channels[c.msg.channel]?.enabled ? null : 'channel_disabled');
export const autonomyOff: Guard = (c) => (c.business.level === 'off' ? 'autonomy_off' : null);
export const handoffActive: Guard = (c) => (c.handoffActive ? 'handoff_active' : null);

export const loopDetected: Guard = (c) => {
  const { k, gapMs, similarity } = c.business.loop;
  const current = { body: c.msg.body, ts: c.msg.receivedAt };
  return looksLikeLoop([...c.recentInbound, current], k, gapMs, similarity) ? 'loop_detected' : null;
};

export const rateLimited: Guard = (c) => {
  const { maxReplies, windowMs } = c.business.rateLimit;
  return rateLimitExceeded(c.botReplyTimes, c.now, maxReplies, windowMs) ? 'rate_limited' : null;
};

/** Order matters: the cheap structural checks come first, per-sender behaviour checks last. */
export const GUARDS: Guard[] = [
  fromMeOrSystem, selfEcho, alreadyProcessed, channelDisabled, autonomyOff, handoffActive, loopDetected, rateLimited,
];

/** These are dropped without being stored: they are not conversation. */
export const NOT_STORED = new Set(['from_me_or_system', 'self_echo', 'already_processed']);

export function firstSkip(c: GuardContext, guards: Guard[] = GUARDS): string | null {
  for (const g of guards) {
    const reason = g(c);
    if (reason) return reason;
  }
  return null;
}
