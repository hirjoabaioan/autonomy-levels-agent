import { PendingStore } from './agent/pending.js';
import { ConfigStore, harborDental, type BusinessConfig, type Level } from './autonomy/config.js';
import { Dispatcher, type Outcome } from './autonomy/dispatcher.js';
import { MessageLog } from './channel/log.js';
import { SimChannel } from './channel/sim.js';
import type { InboundMessage } from './channel/types.js';
import { openDb } from './db.js';
import { seededStore } from './domain/seed.js';
import type { MeterSink } from './metering/meter.js';
import { OperatorQueue } from './operator/queue.js';
import { InboundQueue } from './queue/queue.js';
import { Worker } from './queue/worker.js';
import type { Provider } from './providers/types.js';

export interface AppOptions {
  provider: Provider;
  model: string;
  level?: Level;
  business?: Partial<BusinessConfig>;
  now?: () => number;
  /** Seed data is generated relative to this instant. */
  anchor?: number;
  seed?: number;
  meter?: MeterSink;
  timer?: () => number;
  dbPath?: string;
}

/** Wires the whole pipeline around one SQLite handle, a simulated channel and the seeded clinic. */
export function createApp(o: AppOptions) {
  const now = o.now ?? Date.now;
  const db = openDb(o.dbPath);
  const business = harborDental({ ...o.business, ...(o.level ? { level: o.level } : {}) });
  const config = new ConfigStore([business]);
  const store = seededStore(o.seed ?? 42, o.anchor ?? now());
  const log = new MessageLog(db);
  const operator = new OperatorQueue(db, now);
  const queue = new InboundQueue(db, now);
  const pending = new PendingStore();
  const transport = new SimChannel();
  const dispatcher = new Dispatcher({
    config, log, operator, store, pending, transport, provider: o.provider, model: o.model, now, meter: o.meter, timer: o.timer,
  });
  const worker = new Worker<Outcome>(queue, (m) => dispatcher.handle(m));
  return {
    business, config, store, log, operator, queue, pending, transport, dispatcher, worker, now,
    /** The webhook entry point: false means the delivery was a duplicate. */
    receive: (msg: InboundMessage): boolean => queue.enqueue(msg),
  };
}

export type App = ReturnType<typeof createApp>;
