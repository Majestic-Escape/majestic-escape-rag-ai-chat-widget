// Calendar-date helpers. Stays are booked in India, so "today" is always the
// Asia/Kolkata date — never the server's (Railway and Vercel run in UTC, which
// is still yesterday in India until 05:30).

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const MAX_NIGHTS = 366; // server.me's own ceiling (bookingLifecycleController validateStay)

export function istToday(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

/** A real calendar date in YYYY-MM-DD: rejects 2026-02-30, 2027-02-29, "tomorrow". */
export function isRealDate(d: unknown): d is string {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return new Date(utc(d)).toISOString().slice(0, 10) === d;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((utc(checkOut) - utc(checkIn)) / DAY_MS);
}

export function weekdayOf(d: string): string {
  return WEEKDAYS[new Date(utc(d)).getUTCDay()]!;
}

export type DateProblem = "half" | "invalid" | "order" | "past" | "too_long";

/** null when the pair is usable (or absent altogether). Check-out is exclusive. */
export function dateProblem(checkIn: unknown, checkOut: unknown, today: string): DateProblem | null {
  if (checkIn === undefined && checkOut === undefined) return null;
  if (checkIn === undefined || checkOut === undefined) return "half";
  if (!isRealDate(checkIn) || !isRealDate(checkOut)) return "invalid";
  if (checkOut <= checkIn) return "order";
  if (checkIn < today) return "past";
  if (nightsBetween(checkIn, checkOut) > MAX_NIGHTS) return "too_long";
  return null;
}

/** "24–27 Dec", "30 Dec – 2 Jan", with the year only when it is not this year. */
export function formatDates(checkIn: string, checkOut: string, today: string): string {
  const part = (d: string, withMonth: boolean) => `${Number(d.slice(8, 10))}${withMonth ? ` ${MONTHS[Number(d.slice(5, 7)) - 1]}` : ""}`;
  const sameMonth = checkIn.slice(0, 7) === checkOut.slice(0, 7);
  const year = checkOut.slice(0, 4) !== today.slice(0, 4) ? ` ${checkOut.slice(0, 4)}` : "";
  return sameMonth
    ? `${part(checkIn, false)}–${part(checkOut, true)}${year}`
    : `${part(checkIn, true)} – ${part(checkOut, true)}${year}`;
}
