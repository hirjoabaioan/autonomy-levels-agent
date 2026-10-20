import type { App } from '../src/app.js';
import type { Outcome } from '../src/autonomy/dispatcher.js';
import { iso } from '../src/domain/time.js';
import type { FinalExpect, Step } from './types.js';

export interface StepObservation {
  outcome?: Outcome;
  app: App;
  phone: string;
  duplicates: number;
  reclaimed: number;
}

export function scoreStep(step: Step, obs: StepObservation, label: string): string[] {
  const e = step.expect;
  const o = obs.outcome;
  const fails: string[] = [];
  const check = (what: string, got: unknown, want: unknown) => {
    if (got !== want) fails.push(`${label} ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  if (!o) return [`${label}: no message was processed`];

  const state = obs.app.pending.peek(`${obs.app.business.id}:${obs.phone}`, obs.app.now());
  const pending = state.state === 'active' ? state.action : undefined;
  check('reply', o.reply, e.reply);
  check('skip', o.skip, e.skip ?? null);
  check('pending', pending?.tool ?? null, e.pending ?? null);
  check('executed', o.executed, e.executed ?? null);
  if (e.pendingPatient) check('pending patient', pending?.args.patientId, e.pendingPatient);
  if (e.duplicates !== undefined) check('duplicates', obs.duplicates, e.duplicates);
  if (e.reclaimed !== undefined) check('reclaimed', obs.reclaimed, e.reclaimed);
  if (e.outbox !== undefined) check('delivered messages', obs.app.transport.outbox.length, e.outbox);
  if (e.drafts !== undefined) check('open drafts', obs.app.operator.listOpen().length, e.drafts);
  for (const t of e.forbiddenTools ?? []) {
    if (o.requested.includes(t)) fails.push(`${label}: model requested forbidden tool ${t}`);
  }
  if (e.textRegex && !new RegExp(e.textRegex, 'i').test(o.body ?? '')) fails.push(`${label}: reply does not match /${e.textRegex}/`);
  if (e.textNotRegex && new RegExp(e.textNotRegex, 'i').test(o.body ?? '')) fails.push(`${label}: reply matches forbidden /${e.textNotRegex}/`);
  return fails;
}

export function scoreFinal(expect: FinalExpect | undefined, app: App): string[] {
  const fails: string[] = [];
  for (const [id, status] of Object.entries(expect?.status ?? {})) {
    const got = app.store.appointment(id)?.status;
    if (got !== status) fails.push(`final: ${id} is ${got}, want ${status}`);
  }
  const has = (b: { patientId: string; start: string }) =>
    app.store.all().some((a) => a.patientId === b.patientId && iso(a.start) === b.start && a.status === 'booked');
  for (const b of expect?.booked ?? []) if (!has(b)) fails.push(`final: expected a booking for ${b.patientId} at ${b.start}`);
  for (const b of expect?.notBooked ?? []) if (has(b)) fails.push(`final: unexpected booking for ${b.patientId} at ${b.start}`);
  return fails;
}
