import { describe, expect, it } from 'vitest';
import { seededStore } from '../domain/seed.js';
import { iso } from '../domain/time.js';
import { ANCHOR, ANDREI, FREE_DAY, MARIA, NOW, STRANGER } from '../testing/helpers.js';
import { TOOL_BY_NAME, UserError, bindIdentity, executeAction, toolSpecs, type ToolContext, type WriteTool } from './tools.js';

const store = () => seededStore(42, ANCHOR);
const ctxFor = (s = store(), phone = MARIA, now = NOW): ToolContext => ({ store: s, now, sender: s.patientByPhone(phone) });
const write = (name: string) => TOOL_BY_NAME.get(name) as WriteTool;
const slot = (h: number) => `${FREE_DAY}T${String(h).padStart(2, '0')}:00:00Z`;

describe('identity', () => {
  it('overwrites a model-supplied patientId with the resolved sender', () => {
    const s = store();
    expect(bindIdentity({ patientId: 'p-09', start: 'x' }, s.patientByPhone(MARIA))).toEqual({ start: 'x', patientId: 'p-01' });
  });

  it('removes patientId when the sender is unknown', () => {
    expect(bindIdentity({ patientId: 'p-01' }, undefined)).toEqual({});
  });

  it('exposes patientId to the model as ignored, never as required', () => {
    const book = toolSpecs().find((t) => t.name === 'book_appointment');
    expect((book?.parameters.required as string[]) ?? []).not.toContain('patientId');
  });
});

describe('seed', () => {
  it('has 2 dentists, 25 patients with phones and 80 appointments', () => {
    const s = store();
    expect(s.dentists).toHaveLength(2);
    expect(s.patients).toHaveLength(25);
    expect(new Set(s.patients.map((p) => p.phone)).size).toBe(25);
    expect(s.all()).toHaveLength(80);
  });

  it('is deterministic and keeps the free day free', () => {
    expect(store().all()).toEqual(store().all());
    expect(store().all().some((a) => iso(a.start).startsWith(FREE_DAY))).toBe(false);
  });
});

describe('prepare()', () => {
  const args = { dentistId: 'd-1', serviceId: 's-cleaning', start: slot(10) };

  it('accepts a free future slot and binds the sender', () => {
    const a = write('book_appointment').prepare({ ...args, patientId: 'p-09' } as never, ctxFor());
    expect(a.args).toMatchObject({ patientId: 'p-01', start: slot(10) });
    expect(a.required).toBe(1);
  });

  it('rejects an unknown sender', () => {
    expect(() => write('book_appointment').prepare(args as never, ctxFor(store(), STRANGER))).toThrow(UserError);
  });

  it('rejects a time in the past', () => {
    expect(() => write('book_appointment').prepare({ ...args, start: '2026-10-18T10:00:00Z' } as never, ctxFor())).toThrow(/past/);
  });

  it('rejects a taken, off-grid, weekend or out-of-hours slot', () => {
    const s = store();
    const taken = s.all().find((a) => a.dentistId === 'd-1' && a.status === 'booked');
    const t = (start: string) => () => write('book_appointment').prepare({ ...args, start } as never, ctxFor(s));
    expect(t(iso(taken?.start as number))).toThrow(/not available/);
    expect(t(`${FREE_DAY}T10:10:00Z`)).toThrow(/not available/);
    expect(t('2026-10-24T10:00:00Z')).toThrow(/not available/);
    expect(t(`${FREE_DAY}T17:00:00Z`)).toThrow(/not available/);
  });

  it('only lets a patient touch their own appointments', () => {
    const s = store();
    expect(() => write('cancel_appointment').prepare({ appointmentId: 'a-001' } as never, ctxFor(s, ANDREI))).toThrow(/not found/);
    expect(() => write('cancel_appointment').prepare({ appointmentId: 'a-999' } as never, ctxFor(s))).toThrow(/not found/);
    expect(write('cancel_appointment').prepare({ appointmentId: 'a-001' } as never, ctxFor(s)).required).toBe(2);
  });

  it('get_appointment hides appointments of other patients', () => {
    const get = TOOL_BY_NAME.get('get_appointment');
    expect(() => get?.run({ appointmentId: 'a-001' } as never, ctxFor(store(), ANDREI))).toThrow(/not found/);
  });
});

describe('re-check at execution', () => {
  it('refuses to book a slot that was taken after the proposal', () => {
    const s = store();
    const action = write('book_appointment').prepare({ dentistId: 'd-1', serviceId: 's-cleaning', start: slot(10) } as never, ctxFor(s));
    s.book({ patientId: 'p-05', dentistId: 'd-1', serviceId: 's-cleaning', start: Date.parse(slot(10)) });
    expect(() => executeAction(action, ctxFor(s))).toThrow(/not available/);
  });

  it('refuses to cancel an appointment that is already gone', () => {
    const s = store();
    const action = write('cancel_appointment').prepare({ appointmentId: 'a-001' } as never, ctxFor(s));
    s.cancel('a-001');
    expect(() => executeAction(action, ctxFor(s))).toThrow(/no longer/);
  });

  it('refuses when the time has passed by confirmation', () => {
    const s = store();
    const action = write('book_appointment').prepare({ dentistId: 'd-1', serviceId: 's-cleaning', start: slot(10) } as never, ctxFor(s));
    expect(() => executeAction(action, ctxFor(s, MARIA, Date.parse(slot(11))))).toThrow(/past/);
  });

  it('re-binds the identity: a tampered patientId in the stored action is overwritten', () => {
    const s = store();
    const action = write('book_appointment').prepare({ dentistId: 'd-1', serviceId: 's-cleaning', start: slot(10) } as never, ctxFor(s));
    executeAction({ ...action, args: { ...action.args, patientId: 'p-09' } }, ctxFor(s));
    expect(s.all().find((a) => a.start === Date.parse(slot(10)))?.patientId).toBe('p-01');
  });

  it('executes when still valid', () => {
    const s = store();
    const action = write('reschedule_appointment').prepare({ appointmentId: 'a-001', start: slot(10) } as never, ctxFor(s));
    executeAction(action, ctxFor(s));
    expect(s.appointment('a-001')?.start).toBe(Date.parse(slot(10)));
  });
});
