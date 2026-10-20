export const MIN = 60_000;
export const DAY = 86_400_000;
export const SLOT_MIN = 30;
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 17;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
export const startOfDay = (ms: number): number => Math.floor(ms / DAY) * DAY;
export const isWorkday = (ms: number): boolean => {
  const d = new Date(ms).getUTCDay();
  return d >= 1 && d <= 5;
};

export function fmtWhen(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
