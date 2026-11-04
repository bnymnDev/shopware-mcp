/**
 * Public holidays that change how a shop sells: nationwide ones in Germany, Austria and
 * Switzerland, plus Christmas Eve and New Year's Eve, which are no holidays but no normal
 * shopping days either. Regional holidays are left out on purpose: they move a shop's numbers
 * far less than a national one, and guessing the region would be wrong more often than right.
 */
export const HOLIDAY_COUNTRIES = ["DE", "AT", "CH"] as const;
export type HolidayCountry = (typeof HOLIDAY_COUNTRIES)[number];

/** Easter Sunday of a year (Gregorian computus), as month and day. */
export function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** Every holiday of a country in a year, keyed by YYYY-MM-DD. */
export function holidaysOf(country: HolidayCountry, year: number): Map<string, string> {
  const { month, day } = easter(year);
  const fromEaster = (offset: number) => iso(new Date(Date.UTC(year, month - 1, day + offset)));
  const fixed = (m: number, d: number) => iso(new Date(Date.UTC(year, m - 1, d)));
  const days: Array<[string, string]> = [
    [fixed(1, 1), "New Year's Day"],
    [fromEaster(1), "Easter Monday"],
    [fromEaster(39), "Ascension Day"],
    [fromEaster(50), "Whit Monday"],
    [fixed(12, 24), "Christmas Eve"],
    [fixed(12, 25), "Christmas Day"],
    [fixed(12, 26), "St Stephen's Day"],
    [fixed(12, 31), "New Year's Eve"],
  ];
  if (country === "DE") {
    days.push(
      [fromEaster(-2), "Good Friday"],
      [fixed(5, 1), "Labour Day"],
      [fixed(10, 3), "German Unity Day"],
    );
  }
  if (country === "AT") {
    days.push(
      [fixed(1, 6), "Epiphany"],
      [fixed(5, 1), "Labour Day"],
      [fromEaster(60), "Corpus Christi"],
      [fixed(8, 15), "Assumption Day"],
      [fixed(10, 26), "National Day"],
      [fixed(11, 1), "All Saints' Day"],
      [fixed(12, 8), "Immaculate Conception"],
    );
  }
  if (country === "CH") {
    days.push(
      [fixed(1, 2), "Berchtold's Day"],
      [fromEaster(-2), "Good Friday"],
      [fixed(8, 1), "Swiss National Day"],
    );
  }
  return new Map(days);
}

/** The holiday on a local date (YYYY-MM-DD), or null. */
export function holidayOn(date: string, country: HolidayCountry | null): string | null {
  if (!country) return null;
  const year = Number(date.slice(0, 4));
  return holidaysOf(country, year).get(date) ?? null;
}

/** The country a shop's time zone points to, for a sensible default. */
export function holidayCountryOf(timeZone: string): HolidayCountry | null {
  if (timeZone === "Europe/Berlin" || timeZone === "Europe/Busingen") return "DE";
  if (timeZone === "Europe/Vienna") return "AT";
  if (timeZone === "Europe/Zurich") return "CH";
  return null;
}
