/**
 * Time zones without a library: Intl gives the wall clock, the offset follows from it. Days
 * are stepped on the local calendar, so a week back is the same weekday and the same clock
 * time even when daylight saving changed in between.
 */

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function wallClock(date: Date, timeZone: string): WallClock {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const c = wallClock(date, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a local wall-clock time names in `timeZone`. */
export function zonedInstant(
  local: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
    ms?: number;
  },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
    local.ms ?? 0,
  );
  // The offset at the target can differ from the first guess when daylight saving changes.
  const guess = asUtc - offsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - offsetMs(new Date(guess), timeZone));
}

/** Local midnight of the day `date` falls on, in `timeZone`, as an instant. */
export function startOfDay(date: Date, timeZone: string): Date {
  const c = wallClock(date, timeZone);
  return zonedInstant({ year: c.year, month: c.month, day: c.day }, timeZone);
}

/** The same local clock time `days` calendar days later (negative: earlier). */
export function shiftDays(date: Date, days: number, timeZone: string): Date {
  const c = wallClock(date, timeZone);
  const target = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return zonedInstant(
    {
      year: target.getUTCFullYear(),
      month: target.getUTCMonth() + 1,
      day: target.getUTCDate(),
      hour: c.hour,
      minute: c.minute,
      second: c.second,
      ms: date.getUTCMilliseconds(),
    },
    timeZone,
  );
}

/** The local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(date: Date, timeZone: string): string {
  const c = wallClock(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}

/** Local midnight of a YYYY-MM-DD date in `timeZone`. */
export function midnightOf(date: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return zonedInstant({ year: year ?? 1970, month: month ?? 1, day: day ?? 1 }, timeZone);
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const defaultTimeZone = (): string =>
  process.env.TZ && isTimeZone(process.env.TZ)
    ? process.env.TZ
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
