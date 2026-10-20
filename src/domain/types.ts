export interface Patient {
  id: string;
  name: string;
  phone: string;
}

export interface Dentist {
  id: string;
  name: string;
  specialty: string;
}

export interface Service {
  id: string;
  name: string;
  minutes: number;
  priceUsd: number;
}

export type ApptStatus = 'booked' | 'cancelled';

export interface Appointment {
  id: string;
  patientId: string;
  dentistId: string;
  serviceId: string;
  /** epoch ms, UTC */
  start: number;
  minutes: number;
  status: ApptStatus;
  note?: string;
}
