import { executeAction, UserError, type ToolContext } from '../agent/tools.js';
import { runAgent } from '../agent/loop.js';
import { matchConfirmation, PendingStore, type WriteToolName } from '../agent/pending.js';
import { systemPrompt } from '../agent/prompts.js';
import type { MessageLog } from '../channel/log.js';
import type { InboundMessage, Transport } from '../channel/types.js';
import type { Store } from '../domain/store.js';
import { firstSkip, NOT_STORED, type GuardContext } from '../guards/guards.js';
import type { MeterSink } from '../metering/meter.js';
import { wantsHuman } from '../operator/handoff.js';
import type { OperatorQueue } from '../operator/queue.js';
import type { Message, Provider } from '../providers/types.js';
import type { BusinessConfig, ConfigStore } from './config.js';

export interface Outcome {
  externalId: string;
  skip: string | null;
  reply: 'sent' | 'draft' | 'none';
  body?: string;
  draftId?: number;
  executed: WriteToolName | null;
  /** Tools the model asked for, including ones that were refused. */
  requested: string[];
}

export interface DispatcherDeps {
  config: ConfigStore;
  log: MessageLog;
  operator: OperatorQueue;
  store: Store;
  pending: PendingStore;
  transport: Transport;
  provider: Provider;
  model: string;
  now: () => number;
  meter?: MeterSink;
  timer?: () => number;
}

interface Composed {
  text: string;
  executed?: WriteToolName;
  requested?: string[];
  /** Set when the bot could not produce a reply; the reason goes to the operator. */
  failure?: string;
}

const HISTORY = 12;
const T = {
  handoff: 'Thanks for your message. I have passed this to a member of our team, who will reply to you personally.',
  rateLimited: 'Thanks for your patience. A member of our team will reply to you personally.',
  loop: 'Auto-replies to this number were paused: the last messages looked like an automated sender repeating itself. Review before replying.',
  agentError: 'Sorry, I could not process that just now. A member of our team will follow up.',
  declined: 'No problem, nothing was changed.',
  expired: 'That request expired after 15 minutes. Tell me again what you would like and I will set it up.',
  secondConfirm: (summary: string) => `This cannot be undone: ${summary}. Reply YES once more to cancel it, or send anything else to keep it.`,
  stale: (why: string) => `Sorry, that is no longer possible: ${why} Nothing was changed.`,
  propose: (summary: string, required: number) =>
    required === 2 ? `${summary}. Reply YES to continue.` : `${summary}. Reply YES to confirm.`,
};

/** Glues guards, the agent, the autonomy level and the transport / operator queue together. */
export class Dispatcher {
  constructor(private d: DispatcherDeps) {}

  async handle(msg: InboundMessage): Promise<Outcome> {
    const { log, operator, config } = this.d;
    const now = this.d.now();
    const base = { externalId: msg.externalId, executed: null, requested: [] as string[] };
    const business = config.forNumber(msg.to);
    if (!business) return { ...base, skip: 'unknown_business', reply: 'none' };

    const ctx: GuardContext = {
      msg, business, now,
      processed: log.isProcessed(msg.channel, msg.externalId),
      handoffActive: operator.isHandedOff(msg.from),
      recentInbound: log.recentInbound(msg.from, business.loop.k, msg.externalId),
      botReplyTimes: log.botReplyTimes(msg.from, now - business.rateLimit.windowMs),
    };
    const skip = firstSkip(ctx);
    if (skip && NOT_STORED.has(skip)) return { ...base, skip, reply: 'none' };
    log.addInbound(msg.channel, msg.externalId, msg.from, msg.body, msg.receivedAt);

    let out: Outcome;
    if (skip === 'rate_limited') {
      operator.startHandoff(msg.from, 'rate_limit');
      out = { ...base, skip, ...(await this.deliver(business, msg, T.rateLimited, 'rate_limited', true)) };
    } else if (skip === 'loop_detected') {
      operator.startHandoff(msg.from, 'loop');
      const d = operator.addDraft({ channel: msg.channel, from: msg.to, phone: msg.from, body: T.loop, reason: 'loop_detected', kind: 'escalation' });
      log.add('bot_draft', msg.from, d.body, now);
      out = { ...base, skip, reply: 'draft', body: d.body, draftId: d.id };
    } else if (skip) {
      out = { ...base, skip, reply: 'none' };
    } else if (wantsHuman(msg.body)) {
      operator.startHandoff(msg.from, 'requested');
      out = { ...base, skip: null, ...(await this.deliver(business, msg, T.handoff, 'suggest')) };
    } else {
      const c = await this.compose(business, msg);
      const delivery = c.failure
        ? await this.deliver(business, msg, T.agentError, c.failure, true)
        : await this.deliver(business, msg, c.text, 'suggest');
      out = { ...base, skip: null, executed: c.executed ?? null, requested: c.requested ?? [], ...delivery };
    }
    log.markProcessed(msg.channel, msg.externalId);
    return out;
  }

  private async compose(business: BusinessConfig, msg: InboundMessage): Promise<Composed> {
    const { pending, store } = this.d;
    const now = this.d.now();
    const key = `${business.id}:${msg.from}`;
    const sender = store.patientByPhone(msg.from);
    const ctx: ToolContext = { store, now, sender };
    const verdict = matchConfirmation(msg.body);

    const state = pending.peek(key, now);
    if (state.state === 'expired' && verdict === 'confirm') return { text: T.expired };
    if (state.state === 'active') {
      const action = state.action;
      if (verdict === 'decline') {
        pending.clear(key);
        return { text: T.declined };
      }
      if (verdict === 'confirm') {
        action.confirmations++;
        if (action.confirmations < action.required) return { text: T.secondConfirm(action.summary) };
        pending.clear(key);
        try {
          return { text: executeAction(action, ctx), executed: action.tool };
        } catch (e) {
          if (e instanceof UserError) return { text: T.stale(e.message) };
          throw e;
        }
      }
      pending.clear(key);
    }

    const result = await runAgent({
      provider: this.d.provider, model: this.d.model, system: systemPrompt(now, sender), messages: this.history(msg.from),
      ctx, conversationId: `${business.id}:${msg.from}`, meter: this.d.meter, timer: this.d.timer,
    });
    if (result.kind === 'pending') {
      pending.create(key, result.action, now);
      return { text: T.propose(result.action.summary, result.action.required), requested: result.requested };
    }
    if (result.kind === 'error') return { text: '', failure: result.reason, requested: result.requested };
    if (!result.text.trim()) return { text: '', failure: 'empty_reply', requested: result.requested };
    return { text: result.text, requested: result.requested };
  }

  private history(phone: string): Message[] {
    // Drafts nobody sent are not part of what the customer saw.
    const msgs = this.d.log
      .recent(phone, HISTORY)
      .filter((e) => e.kind !== 'bot_draft')
      .map((e): Message => (e.kind === 'in' ? { role: 'user', content: e.body } : { role: 'assistant', content: e.body }));
    while (msgs[0]?.role === 'assistant') msgs.shift();
    return msgs;
  }

  /**
   * The autonomy level decides what happens to a reply: `auto` sends it (and falls back to a draft if
   * sending fails), `suggest` parks it for a human. `draftOnly` is for replies that must never be sent.
   */
  private async deliver(
    business: BusinessConfig, msg: InboundMessage, body: string, reason: string, draftOnly = false,
  ): Promise<{ reply: 'sent' | 'draft'; body: string; draftId?: number }> {
    const { transport, operator, log } = this.d;
    const now = this.d.now();
    if (business.level === 'auto' && !draftOnly) {
      try {
        await transport.send({ channel: msg.channel, from: msg.to, to: msg.from, body });
        log.add('bot_out', msg.from, body, now);
        return { reply: 'sent', body };
      } catch (e) {
        reason = `send_failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const draft = operator.addDraft({ channel: msg.channel, from: msg.to, phone: msg.from, body, reason });
    log.add('bot_draft', msg.from, body, now);
    return { reply: 'draft', body, draftId: draft.id };
  }

  /** Operator path: send a draft (optionally edited) and record it in the conversation. */
  async approve(id: number, editedBody?: string): Promise<void> {
    const { operator, transport, log } = this.d;
    await operator.approve(
      id,
      async (d, body) => {
        await transport.send({ channel: d.channel, from: d.from, to: d.phone, body });
        log.add('operator_out', d.phone, body, this.d.now());
      },
      editedBody,
    );
  }
}
