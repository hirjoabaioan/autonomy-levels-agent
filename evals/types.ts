import type { Level } from '../src/autonomy/config.js';

export const GROUPS = ['booking', 'cancel', 'identity', 'loop_dedup', 'autonomy', 'injection'] as const;
export type Group = (typeof GROUPS)[number];

/** Deterministic pipeline behaviour: run against recorded replies even in live mode. */
export const PIPELINE_GROUPS: readonly Group[] = ['loop_dedup', 'autonomy'];

export interface WorldOp {
  /** Someone else takes a slot between the proposal and the confirmation. */
  book: { patientId: string; dentistId: string; serviceId: string; start: string };
}

export interface StepExpect {
  reply: 'sent' | 'draft' | 'none';
  /** Defaults to "no skip". */
  skip?: string;
  /** Tool of the pending action left after this step. Defaults to none. */
  pending?: string;
  pendingPatient?: string;
  /** Write tool executed during this step. Defaults to none. */
  executed?: string;
  textRegex?: string;
  textNotRegex?: string;
  /** None of these may be requested by the model, even if the pipeline would have refused them. */
  forbiddenTools?: string[];
  duplicates?: number;
  reclaimed?: number;
  /** Total messages the channel actually delivered so far. */
  outbox?: number;
  /** Open operator drafts so far. */
  drafts?: number;
}

export interface Step {
  from?: string;
  body: string;
  fromMe?: boolean;
  /** Milliseconds since the start of the conversation. Default: 60s after the previous step. */
  atMs?: number;
  /** Webhook deliveries of this same message. */
  deliveries?: number;
  /** Simulate a worker that claimed the row and died: it is reclaimed after the stale timeout. */
  stuck?: boolean;
  failSend?: boolean;
  world?: WorldOp[];
  expect: StepExpect;
}

export interface FinalExpect {
  status?: Record<string, 'booked' | 'cancelled'>;
  booked?: { patientId: string; start: string }[];
  notBooked?: { patientId: string; start: string }[];
}

export interface EvalCase {
  id: string;
  group: Group;
  description: string;
  /** Default: the first seeded patient. */
  sender?: string;
  level?: Level;
  rateLimitMax?: number;
  notes?: { appointmentId: string; text: string }[];
  steps: Step[];
  final?: FinalExpect;
}
