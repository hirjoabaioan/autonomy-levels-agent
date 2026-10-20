import { z } from 'zod';
import type { Store } from '../domain/store.js';
import { SLOT_MIN, fmtWhen, iso, startOfDay } from '../domain/time.js';
import type { Appointment, Patient } from '../domain/types.js';
import type { ToolSpec } from '../providers/types.js';
import type { PreparedAction, WriteToolName } from './pending.js';

export interface ToolContext {
  store: Store;
  now: number;
  /** Resolved server-side from the channel sender. Undefined for unknown numbers. */
  sender?: Patient;
}

/** A refusal that is safe to show to the customer and to the model. */
export class UserError extends Error {}

interface ToolBase {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  run(args: never, ctx: ToolContext): unknown;
}

export interface ReadTool extends ToolBase {
  kind: 'read';
}

export interface WriteTool extends ToolBase {
  kind: 'write';
  name: WriteToolName;
  /** Dry-run. Throws UserError when the action must not be offered or executed. */
  prepare(args: never, ctx: ToolContext): PreparedAction;
  /** Performs the change. Always called after prepare() succeeded again. */
  apply(action: PreparedAction, ctx: ToolContext): string;
}

export type Tool = ReadTool | WriteTool;

/** The patientId a model supplies is never trusted: it is replaced by the resolved sender. */
export function bindIdentity(args: Record<string, unknown>, sender?: Patient): Record<string, unknown> {
  const { patientId: _ignored, ...rest } = args;
  return sender ? { ...rest, patientId: sender.id } : rest;
}

function requireSender(ctx: ToolContext): Patient {
  if (!ctx.sender) throw new UserError('This phone number is not linked to a patient record, so I cannot access or change appointments. Please call the clinic.');
  return ctx.sender;
}

/** Same message for "missing" and "not yours", so ids of other patients cannot be probed. */
function ownAppointment(ctx: ToolContext, id: string): Appointment {
  const sender = requireSender(ctx);
  const a = ctx.store.appointment(id);
  if (!a || a.patientId !== sender.id) throw new UserError(`Appointment ${id} was not found for this patient.`);
  return a;
}

function parseStart(s: string, ctx: ToolContext): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new UserError(`"${s}" is not a valid date and time (use ISO 8601, e.g. 2026-01-15T10:00:00Z).`);
  if (t <= ctx.now) throw new UserError('That time is in the past.');
  return t;
}

const describeAppt = (a: Appointment, store: Store) =>
  `${store.service(a.serviceId)?.name ?? a.serviceId} with ${store.dentist(a.dentistId)?.name ?? a.dentistId} on ${fmtWhen(a.start)}`;

const patientId = z.string().optional().describe('Ignored: the patient is identified from the chat sender.');

const findFreeSlots = z.object({
  fromDate: z.string().optional().describe('YYYY-MM-DD, default today'),
  dentistId: z.string().optional(),
  serviceId: z.string().optional().describe('Slot length depends on the service'),
});
const noArgs = z.object({});
const apptId = z.object({ patientId, appointmentId: z.string() });
const bookIn = z.object({ patientId, dentistId: z.string(), serviceId: z.string(), start: z.string().describe('ISO 8601 UTC, e.g. 2026-01-15T10:00:00Z') });
const rescheduleIn = z.object({ patientId, appointmentId: z.string(), start: z.string().describe('New start, ISO 8601 UTC') });

const readTools: ReadTool[] = [
  {
    kind: 'read', name: 'find_free_slots', input: findFreeSlots,
    description: 'List the next free appointment slots (max 8) from a date, optionally for one dentist and service.',
    run(args: z.infer<typeof findFreeSlots>, ctx) {
      const minutes = args.serviceId ? ctx.store.service(args.serviceId)?.minutes : SLOT_MIN;
      if (!minutes) throw new UserError(`Unknown service ${args.serviceId}.`);
      const from = args.fromDate ? Date.parse(`${args.fromDate}T00:00:00Z`) : startOfDay(ctx.now);
      if (Number.isNaN(from)) throw new UserError('fromDate must be YYYY-MM-DD.');
      const slots = ctx.store.freeSlots({ fromDay: from, minutes, now: ctx.now, dentistId: args.dentistId, limit: 8 });
      return { slots: slots.map((s) => ({ dentistId: s.dentistId, start: iso(s.start) })) };
    },
  },
  {
    kind: 'read', name: 'list_services', input: noArgs,
    description: 'List services with duration and price.',
    run: (_a: never, ctx) => ({ services: ctx.store.services }),
  },
  {
    kind: 'read', name: 'clinic_info', input: noArgs,
    description: 'Opening hours, address and contact details.',
    run: () => ({
      name: 'Harbor Dental', address: '12 Quay Street, Harborview', hours: 'Mon-Fri 09:00-17:00 UTC, closed weekends',
      emergency: 'For emergencies outside hours, call the clinic line and follow the recorded instructions.',
    }),
  },
  {
    kind: 'read', name: 'my_appointments', input: noArgs,
    description: "The sender's upcoming appointments.",
    run(_a: never, ctx) {
      const sender = requireSender(ctx);
      return {
        appointments: ctx.store.upcomingOf(sender.id, ctx.now).map((a) => ({
          id: a.id, service: ctx.store.service(a.serviceId)?.name, dentist: ctx.store.dentist(a.dentistId)?.name, start: iso(a.start),
        })),
      };
    },
  },
  {
    kind: 'read', name: 'get_appointment', input: z.object({ appointmentId: z.string() }),
    description: 'Details of one of the sender\'s own appointments, including the clinic note.',
    run(args: { appointmentId: string }, ctx) {
      const a = ownAppointment(ctx, args.appointmentId);
      return { id: a.id, status: a.status, description: describeAppt(a, ctx.store), start: iso(a.start), note: a.note ?? null };
    },
  },
  {
    kind: 'read', name: 'practitioner_info', input: z.object({ dentistId: z.string().optional() }),
    description: 'The dentists and their specialties.',
    run: (args: { dentistId?: string }, ctx) => ({
      dentists: ctx.store.dentists.filter((d) => !args.dentistId || d.id === args.dentistId),
    }),
  },
];

const pendingAction = (action: PreparedAction) => ({
  pending_action: action,
  note: 'Nothing has been changed yet. The customer must confirm in their next message.',
});

const writeTools: WriteTool[] = [
  {
    kind: 'write', name: 'book_appointment', input: bookIn,
    description: 'Request a new booking. Returns a pending_action; it is only executed after the customer confirms.',
    prepare(args: z.infer<typeof bookIn>, ctx) {
      const sender = requireSender(ctx);
      const dentist = ctx.store.dentist(args.dentistId);
      const service = ctx.store.service(args.serviceId);
      if (!dentist || !service) throw new UserError('Unknown dentist or service.');
      const start = parseStart(args.start, ctx);
      if (!ctx.store.isSlotFree(dentist.id, start, service.minutes)) throw new UserError('That slot is not available.');
      return {
        tool: 'book_appointment', required: 1,
        args: { patientId: sender.id, dentistId: dentist.id, serviceId: service.id, start: iso(start) },
        summary: `Book ${service.name} with ${dentist.name} on ${fmtWhen(start)}`,
      };
    },
    apply(action, ctx) {
      const a = action.args as z.infer<typeof bookIn> & { patientId: string };
      const appt = ctx.store.book({ patientId: a.patientId, dentistId: a.dentistId, serviceId: a.serviceId, start: Date.parse(a.start) });
      return `Done: you are booked for ${describeAppt(appt, ctx.store)} (${appt.id}).`;
    },
    run(args, ctx) {
      return pendingAction(this.prepare(args, ctx));
    },
  },
  {
    kind: 'write', name: 'reschedule_appointment', input: rescheduleIn,
    description: 'Request moving one of the sender\'s appointments. Returns a pending_action; it is only executed after the customer confirms.',
    prepare(args: z.infer<typeof rescheduleIn>, ctx) {
      const sender = requireSender(ctx);
      const appt = ownAppointment(ctx, args.appointmentId);
      if (appt.status !== 'booked' || appt.start <= ctx.now) throw new UserError('That appointment can no longer be changed.');
      const start = parseStart(args.start, ctx);
      if (!ctx.store.isSlotFree(appt.dentistId, start, appt.minutes, appt.id)) throw new UserError('That slot is not available.');
      return {
        tool: 'reschedule_appointment', required: 1,
        args: { patientId: sender.id, appointmentId: appt.id, start: iso(start) },
        summary: `Move ${describeAppt(appt, ctx.store)} to ${fmtWhen(start)}`,
      };
    },
    apply(action, ctx) {
      const a = action.args as z.infer<typeof rescheduleIn>;
      ctx.store.reschedule(a.appointmentId, Date.parse(a.start));
      return `Done: your appointment ${a.appointmentId} is now on ${fmtWhen(Date.parse(a.start))}.`;
    },
    run(args, ctx) {
      return pendingAction(this.prepare(args, ctx));
    },
  },
  {
    kind: 'write', name: 'cancel_appointment', input: apptId,
    description: 'Request cancelling one of the sender\'s appointments. Returns a pending_action; it needs two customer confirmations.',
    prepare(args: z.infer<typeof apptId>, ctx) {
      const sender = requireSender(ctx);
      const appt = ownAppointment(ctx, args.appointmentId);
      if (appt.status !== 'booked' || appt.start <= ctx.now) throw new UserError('That appointment can no longer be cancelled.');
      return {
        tool: 'cancel_appointment', required: 2,
        args: { patientId: sender.id, appointmentId: appt.id },
        summary: `Cancel ${describeAppt(appt, ctx.store)}`,
      };
    },
    apply(action, ctx) {
      const a = action.args as z.infer<typeof apptId>;
      ctx.store.cancel(a.appointmentId);
      return `Done: appointment ${a.appointmentId} is cancelled.`;
    },
    run(args, ctx) {
      return pendingAction(this.prepare(args, ctx));
    },
  },
];

export const TOOLS: Tool[] = [...readTools, ...writeTools];
export const TOOL_BY_NAME = new Map<string, Tool>(TOOLS.map((t) => [t.name, t]));

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

export function isPendingResult(x: unknown): x is { pending_action: PreparedAction } {
  return typeof x === 'object' && x !== null && 'pending_action' in x;
}

/**
 * Executes a confirmed action. The identity is re-bound to the current sender and prepare() runs
 * again, so a slot taken since the proposal (or an appointment cancelled meanwhile) is caught here.
 */
export function executeAction(action: PreparedAction, ctx: ToolContext): string {
  const tool = TOOL_BY_NAME.get(action.tool);
  if (!tool || tool.kind !== 'write') throw new UserError('Unknown action.');
  const args = tool.input.parse(bindIdentity(action.args, ctx.sender));
  const fresh = tool.prepare(args as never, ctx);
  return tool.apply(fresh, ctx);
}
