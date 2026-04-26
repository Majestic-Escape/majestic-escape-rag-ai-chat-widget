// Heuristic date-range extraction for chatbot queries. Conservative on purpose —
// returning null is safe (we just skip the booking-availability filter).

export interface DateRange {
  from: Date;
  to: Date;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const HOLIDAYS: Record<string, [number, number, number]> = {
  // [month, day, durationNights]
  christmas: [11, 24, 3],          // Dec 24 → 27
  "new year": [11, 30, 3],         // Dec 30 → Jan 2
  "new year's eve": [11, 30, 3],
  diwali: [9, 25, 3],              // approx — varies yearly; conservative default
  holi: [2, 12, 2],                // approx
};

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function nightsAfter(date: Date, nights: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + nights);
  return out;
}

export function extractDateRange(rawText: string): DateRange | null {
  if (!rawText) return null;
  const text = rawText.toLowerCase();
  const now = startOfDay(new Date());

  // "tonight" / "today"
  if (/\btonight\b|\btoday\b/.test(text)) {
    return { from: now, to: nightsAfter(now, 1) };
  }
  // "tomorrow"
  if (/\btomorrow\b/.test(text)) {
    const t = nightsAfter(now, 1);
    return { from: t, to: nightsAfter(t, 1) };
  }
  // "day after tomorrow"
  if (/\bday\s+after\s+tomorrow\b/.test(text)) {
    const t = nightsAfter(now, 2);
    return { from: t, to: nightsAfter(t, 1) };
  }

  // "next weekend" / "this weekend"
  const weekendMatch = text.match(/\b(this|next|coming)\s+weekend\b/);
  if (weekendMatch) {
    const day = now.getDay();
    let daysToSat = (6 - day + 7) % 7;
    if (weekendMatch[1] === "next" && daysToSat < 7) daysToSat += 7;
    if (daysToSat === 0) daysToSat = weekendMatch[1] === "next" ? 7 : 0;
    const sat = nightsAfter(now, daysToSat);
    return { from: sat, to: nightsAfter(sat, 2) };
  }

  // "this/next <weekday>" → that weekday
  const weekdayMatch = text.match(
    /\b(this|next|coming)?\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/
  );
  if (weekdayMatch) {
    const target = WEEKDAYS[weekdayMatch[2]!];
    if (target !== undefined) {
      let delta = (target - now.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      if (weekdayMatch[1] === "next" && delta < 7) delta += 7;
      const start = nightsAfter(now, delta);
      return { from: start, to: nightsAfter(start, 1) };
    }
  }

  // Holidays
  for (const [name, [month, day, nights]] of Object.entries(HOLIDAYS)) {
    if (text.includes(name)) {
      let year = now.getFullYear();
      let from = new Date(year, month, day);
      if (from < now) from = new Date(++year, month, day);
      return { from, to: nightsAfter(from, nights) };
    }
  }

  // "Dec 20 to Dec 25" / "Dec 20-25" / "December 20 to 25"
  const monthsAlt = Object.keys(MONTHS).join("|");
  const reMonthRange = new RegExp(
    `\\b(${monthsAlt})\\s+(\\d{1,2})\\s*(?:[-to]+\\s*)(?:(${monthsAlt})\\s+)?(\\d{1,2})\\b`,
    "i"
  );
  const m = text.match(reMonthRange);
  if (m) {
    const month1 = MONTHS[m[1]!.toLowerCase()];
    const day1 = parseInt(m[2]!, 10);
    const month2 = m[3] ? MONTHS[m[3]!.toLowerCase()] : month1;
    const day2 = parseInt(m[4]!, 10);
    if (month1 !== undefined && month2 !== undefined) {
      let year = now.getFullYear();
      let from = new Date(year, month1, day1);
      if (from < now) from = new Date(++year, month1, day1);
      const to = new Date(from.getFullYear() + (month2 < month1 ? 1 : 0), month2, day2);
      if (to >= from) return { from, to };
    }
  }

  // "from Dec 20 for 3 nights" / "Dec 20 for 5 days"
  const forNights = text.match(
    new RegExp(
      `\\b(${monthsAlt})\\s+(\\d{1,2}).{0,30}for\\s+(\\d{1,2})\\s+(night|day|nights|days)\\b`,
      "i"
    )
  );
  if (forNights) {
    const month = MONTHS[forNights[1]!.toLowerCase()];
    const day = parseInt(forNights[2]!, 10);
    const nights = parseInt(forNights[3]!, 10);
    if (month !== undefined && nights > 0) {
      let year = now.getFullYear();
      let from = new Date(year, month, day);
      if (from < now) from = new Date(++year, month, day);
      return { from, to: nightsAfter(from, nights) };
    }
  }

  // Numeric "20/12" or "20-12" (DD/MM, Indian convention)
  const numericRange = text.match(/\b(\d{1,2})[\/\-](\d{1,2})\s*(?:to|-)\s*(\d{1,2})[\/\-](\d{1,2})\b/);
  if (numericRange) {
    const d1 = parseInt(numericRange[1]!, 10);
    const m1 = parseInt(numericRange[2]!, 10) - 1;
    const d2 = parseInt(numericRange[3]!, 10);
    const m2 = parseInt(numericRange[4]!, 10) - 1;
    if (m1 >= 0 && m1 <= 11 && m2 >= 0 && m2 <= 11) {
      let year = now.getFullYear();
      let from = new Date(year, m1, d1);
      if (from < now) from = new Date(++year, m1, d1);
      const to = new Date(from.getFullYear() + (m2 < m1 ? 1 : 0), m2, d2);
      if (to >= from) return { from, to };
    }
  }

  return null;
}
