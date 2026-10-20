import type { InboundMessage } from '../channel/types.js';
import type { InboundQueue } from './queue.js';

export interface RunSummary<T> {
  outcomes: T[];
  reclaimed: number;
  failed: number;
}

/** Claims a batch and handles it in order; a throwing handler sends the row back for retry. */
export class Worker<T> {
  private timer?: NodeJS.Timeout;

  constructor(
    private queue: InboundQueue,
    private handler: (msg: InboundMessage) => Promise<T>,
    private batchSize = 10,
  ) {}

  async runOnce(): Promise<RunSummary<T>> {
    const { rows, reclaimed } = this.queue.claim(this.batchSize);
    const outcomes: T[] = [];
    let failed = 0;
    for (const row of rows) {
      try {
        outcomes.push(await this.handler(row.message));
        this.queue.complete(row.id);
      } catch (e) {
        failed++;
        this.queue.fail(row.id, e instanceof Error ? e.message : String(e));
      }
    }
    return { outcomes, reclaimed, failed };
  }

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
