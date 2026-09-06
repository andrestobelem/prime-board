// Cálculos de calendario para la cadencia de Cycles (PRB-388).
// Las fechas se almacenan como instantes ISO. Las operaciones de calendario se
// hacen en la zona horaria del Team para conservar el día local durante DST.

export interface CycleCadenceSettings {
  timezone: string;
  durationWeeks: number;
  startDay: string | number;
  cooldownDays: number;
}

export interface CycleCadenceDates {
  startsAt: string;
  endsAt: string;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function partsFor(value: number, timezone: string): LocalParts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter(timezone).formatToParts(new Date(value))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function timezoneOffset(value: number, timezone: string): number {
  const parts = partsFor(value, timezone);
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(value / 1000) * 1000;
}

function instantFor(parts: LocalParts, timezone: string): string {
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Two passes resolve the usual DST transition and retain the selected local
  // wall time instead of adding a fixed 24-hour duration.
  let instant = wall - timezoneOffset(wall, timezone);
  instant = wall - timezoneOffset(instant, timezone);
  return new Date(instant).toISOString();
}

function dayNumber(value: string | number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7) {
    return value;
  }
  if (typeof value === "string") {
    const index = WEEKDAYS.indexOf(value.trim().toLowerCase() as (typeof WEEKDAYS)[number]);
    if (index >= 0) return index + 1;
  }
  return 1;
}

function localWeekday(parts: LocalParts): number {
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function shiftedDate(parts: LocalParts, days: number): LocalParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function addCalendarDays(value: string, days: number, timezone: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error("Invalid date");
  return instantFor(shiftedDate(partsFor(timestamp, timezone), days), timezone);
}

export function nextCadenceStart(
  settings: Pick<CycleCadenceSettings, "timezone" | "startDay" | "cooldownDays">,
  referenceAt: string,
  previousEndsAt?: string,
): string {
  const reference = Date.parse(referenceAt);
  if (Number.isNaN(reference)) throw new Error("Invalid reference date");
  let candidate: string;
  if (previousEndsAt) {
    candidate = addCalendarDays(previousEndsAt, settings.cooldownDays + 1, settings.timezone);
    // Cycle boundaries always start at local midnight. This also prevents a
    // manually edited end time from leaking its time of day into the cadence.
    const localCandidate = partsFor(Date.parse(candidate), settings.timezone);
    candidate = instantFor({ ...localCandidate, hour: 0, minute: 0, second: 0 }, settings.timezone);
    // A stale completed cycle must not make the planner recreate an already
    // elapsed upcoming boundary. Keep the previous end only when the cooldown
    // still produces a future boundary.
    if (Date.parse(candidate) <= reference) {
      const local = partsFor(reference, settings.timezone);
      candidate = instantFor({ ...local, hour: 0, minute: 0, second: 0 }, settings.timezone);
    }
  } else {
    const local = partsFor(reference, settings.timezone);
    candidate = instantFor({ ...local, hour: 0, minute: 0, second: 0 }, settings.timezone);
  }
  const targetDay = dayNumber(settings.startDay);
  let local = partsFor(Date.parse(candidate), settings.timezone);
  while (localWeekday(local) !== targetDay) {
    candidate = addCalendarDays(candidate, 1, settings.timezone);
    local = partsFor(Date.parse(candidate), settings.timezone);
  }
  // A planner must not create an upcoming cycle that already started. For a
  // first cycle, move to the next occurrence when today's occurrence passed.
  if (Date.parse(candidate) <= reference) {
    candidate = addCalendarDays(candidate, 7, settings.timezone);
  }
  return candidate;
}

export function cadenceDates(
  settings: CycleCadenceSettings,
  referenceAt: string,
  startsAt?: string,
  previousEndsAt?: string,
): CycleCadenceDates {
  const start = startsAt ?? nextCadenceStart(settings, referenceAt, previousEndsAt);
  // Explicit startsAt is still interpreted as an instant. The duration is a
  // local-calendar duration so a DST transition does not change the cycle day.
  const endsAt = addCalendarDays(start, settings.durationWeeks * 7 - 1, settings.timezone);
  return { startsAt: start, endsAt };
}
