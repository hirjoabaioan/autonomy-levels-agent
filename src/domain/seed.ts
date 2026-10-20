import { Store } from './store.js';
import { DAY, OPEN_HOUR, SLOT_MIN, MIN, isWorkday, startOfDay } from './time.js';

const NAMES = [
  'Maria Ionescu', 'Andrei Popescu', 'Lena Kowalski', 'Tomas Weber', 'Ines Duarte', 'Omar Haddad', 'Sofia Rossi',
  'Daniel Novak', 'Aiko Tanaka', 'Priya Nair', 'Lucas Meyer', 'Hana Berg', 'Mateo Silva', 'Nora Fischer',
  'Viktor Horvat', 'Elena Costa', 'Jonas Lind', 'Amira Said', 'Pavel Sokol', 'Clara Dubois', 'Ravi Menon',
  'Greta Olsen', 'Samir Khan', 'Alma Vega', 'Felix Brandt',
];

const SERVICES = [
  { id: 's-cleaning', name: 'Cleaning', minutes: 30, priceUsd: 80 },
  { id: 's-checkup', name: 'Check-up', minutes: 30, priceUsd: 60 },
  { id: 's-filling', name: 'Filling', minutes: 60, priceUsd: 150 },
  { id: 's-whitening', name: 'Whitening', minutes: 60, priceUsd: 220 },
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The n-th working day after `anchor`'s day (n=1 is the next working day). */
export function workday(anchor: number, n: number): number {
  let day = startOfDay(anchor);
  for (let left = n; left > 0; ) {
    day += DAY;
    if (isWorkday(day)) left--;
  }
  return day;
}

/**
 * Harbor Dental: 2 dentists, 25 patients, 80 appointments. Deterministic for a given seed and anchor.
 * Fixed anchors for tests: a-001 (Maria) on workday 2 at 10:00, a-002 / a-003 on workday 3,
 * and workday 4 is left completely free so tests have known open slots.
 */
export function seededStore(seed: number, anchor: number): Store {
  const patients = NAMES.map((name, i) => ({
    id: `p-${String(i + 1).padStart(2, '0')}`,
    name,
    phone: `+1555010${String(i + 1).padStart(4, '0')}`,
  }));
  const dentists = [
    { id: 'd-1', name: 'Dr. Elena Marin', specialty: 'General dentistry' },
    { id: 'd-2', name: 'Dr. Tomas Reed', specialty: 'Restorative dentistry' },
  ];
  const store = new Store(patients, dentists, SERVICES);
  const at = (n: number, hour: number) => workday(anchor, n) + hour * 3600_000;

  store.book({ patientId: 'p-01', dentistId: 'd-1', serviceId: 's-cleaning', start: at(2, 10) }, 'a-001');
  store.book({ patientId: 'p-02', dentistId: 'd-1', serviceId: 's-checkup', start: at(3, 14) }, 'a-002');
  store.book({ patientId: 'p-03', dentistId: 'd-2', serviceId: 's-filling', start: at(3, 11) }, 'a-003');

  const rand = mulberry32(seed);
  const days = [1, 2, 3, 5, 6, 7, 8, 9, 10];
  for (let n = 4; store.all().length < 80 && n < 5000; n++) {
    const day = at(days[Math.floor(rand() * days.length)] as number, 0);
    const slot = Math.floor(rand() * 16);
    const service = SERVICES[Math.floor(rand() * SERVICES.length)] as (typeof SERVICES)[number];
    const dentist = dentists[Math.floor(rand() * 2)] as (typeof dentists)[number];
    const patient = patients[3 + Math.floor(rand() * 22)] as (typeof patients)[number];
    const start = day + OPEN_HOUR * 3600_000 + slot * SLOT_MIN * MIN;
    if (store.isSlotFree(dentist.id, start, service.minutes)) {
      store.book({ patientId: patient.id, dentistId: dentist.id, serviceId: service.id, start }, `a-${String(store.all().length + 1).padStart(3, '0')}`);
    }
  }
  return store;
}
