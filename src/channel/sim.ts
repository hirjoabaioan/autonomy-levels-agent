import type { OutboundMessage, Transport } from './types.js';

/** In-memory transport: records what was sent and can be told to fail. */
export class SimChannel implements Transport {
  readonly outbox: OutboundMessage[] = [];
  failSends = false;
  onSend?: (msg: OutboundMessage) => void;

  async send(msg: OutboundMessage): Promise<void> {
    if (this.failSends) throw new Error('simulated send failure');
    this.outbox.push(msg);
    this.onSend?.(msg);
  }
}
