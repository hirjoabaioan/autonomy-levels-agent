import { createApp, type App, type AppOptions } from '../app.js';
import type { Outcome } from '../autonomy/dispatcher.js';
import type { InboundMessage } from '../channel/types.js';
import { MockProvider } from '../providers/mock.js';

/** Monday 2026-10-19; "now" is 08:00 so every seeded appointment is in the future. */
export const ANCHOR = Date.parse('2026-10-19T00:00:00Z');
export const NOW = ANCHOR + 8 * 3600_000;

export const MARIA = '+15550100001';
export const ANDREI = '+15550100002';
export const STRANGER = '+15550999999';
export const FREE_DAY = '2026-10-23';

export interface TestApp {
  app: App;
  provider: MockProvider;
  clock: { t: number };
}

export function makeApp(opts: Partial<AppOptions> = {}): TestApp {
  const clock = { t: NOW };
  const provider = new MockProvider();
  const app = createApp({ provider, model: 'test-model', now: () => clock.t, anchor: ANCHOR, ...opts });
  return { app, provider, clock };
}

let seq = 0;

export function inbound(app: App, body: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'whatsapp', externalId: `t-${++seq}`, from: MARIA, to: app.business.numbers[0] as string,
    body, receivedAt: app.now(), ...over,
  };
}

/** Webhook -> queue -> worker, returning the outcome of the single message. */
export async function say(app: App, body: string, over: Partial<InboundMessage> = {}): Promise<Outcome> {
  app.receive(inbound(app, body, over));
  const { outcomes } = await app.worker.runOnce();
  return outcomes[0] as Outcome;
}
