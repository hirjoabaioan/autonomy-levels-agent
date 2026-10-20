import { CLOSE_HOUR, DAY, MIN, OPEN_HOUR, SLOT_MIN, isWorkday, startOfDay } from './time.js';
import type { Appointment, Dentist, Patient, Service } from './types.js';

export interface FreeSlot {
  dentistId: string;
  start: number;
}

export class Store {
  private appts = new Map<string, Appointment>();
  private seq = 0;

  constructor(
    readonly patients: Patient[],
    readonly dentists: Dentist[],
    readonly services: Service[],
  ) {}

  patientByPhone(phone: string): Patient | undefined {
    return this.patients.find((p) => p.phone === phone);
  }

  dentist(id: string): Dentist | undefined {
    return this.dentists.find((d) => d.id === id);
  }

  service(id: string): Service | undefined {
    return this.services.find((s) => s.id === id);
  }

  appointment(id: string): Appointment | undefined {
    return this.appts.get(id);
  }

  all(): Appointment[] {
    return [...this.appts.values()];
  }

  upcomingOf(patientId: string, now: number): Appointment[] {
    return this.all()
      .filter((a) => a.patientId === patientId && a.status === 'booked' && a.start > now)
      .sort((a, b) => a.start - b.start);
  }

  /** Inside opening hours, on the slot grid, and not overlapping another booked appointment. */
  isSlotFree(dentistId: string, start: number, minutes: number, ignoreId?: string): boolean {
    if (!this.dentist(dentistId) || !Number.isFinite(start)) return false;
    if (start % (SLOT_MIN * MIN) !== 0 || !isWorkday(start)) return false;
    const dayStart = startOfDay(start);
    const end = start + minutes * MIN;
    if (start < dayStart + OPEN_HOUR * 3600_000 || end > dayStart + CLOSE_HOUR * 3600_000) return false;
    return !this.all().some(
      (a) =>
        a.status === 'booked' && a.dentistId === dentistId && a.id !== ignoreId &&
        start < a.start + a.minutes * MIN && a.start < end,
    );
  }

  freeSlots(opts: { fromDay: number; minutes: number; now: number; dentistId?: string; limit: number; days?: number }): FreeSlot[] {
    const out: FreeSlot[] = [];
    const dentists = opts.dentistId ? this.dentists.filter((d) => d.id === opts.dentistId) : this.dentists;
    for (let d = 0; d < (opts.days ?? 14) && out.length < opts.limit; d++) {
      const day = startOfDay(opts.fromDay) + d * DAY;
      for (let t = day + OPEN_HOUR * 3600_000; t < day + CLOSE_HOUR * 3600_000 && out.length < opts.limit; t += SLOT_MIN * MIN) {
        if (t <= opts.now) continue;
        for (const dn of dentists) {
          if (out.length < opts.limit && this.isSlotFree(dn.id, t, opts.minutes)) out.push({ dentistId: dn.id, start: t });
        }
      }
    }
    return out;
  }

  book(a: { patientId: string; dentistId: string; serviceId: string; start: number; note?: string }, id?: string): Appointment {
    const service = this.service(a.serviceId);
    if (!service) throw new Error(`unknown service ${a.serviceId}`);
    const appt: Appointment = {
      id: id ?? `a-${String(++this.seq + 1000)}`,
      patientId: a.patientId, dentistId: a.dentistId, serviceId: a.serviceId,
      start: a.start, minutes: service.minutes, status: 'booked', note: a.note,
    };
    this.appts.set(appt.id, appt);
    return appt;
  }

  reschedule(id: string, start: number): void {
    const a = this.appts.get(id);
    if (a) a.start = start;
  }

  cancel(id: string): void {
    const a = this.appts.get(id);
    if (a) a.status = 'cancelled';
  }

  setNote(id: string, note: string): void {
    const a = this.appts.get(id);
    if (a) a.note = note;
  }
}
