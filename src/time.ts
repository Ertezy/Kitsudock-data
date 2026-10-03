// Даты из источников приходят в пяти видах: ISO со смещением фандома, ISO
// серверного времени, английская дата с тихоокеанским временем, короткая
// английская дата Endfield и unix-число ennead.cc. Всё сводится к unix-секундам.

/** Серверное время европейских серверов HoYoverse и Kuro: UTC+1, без летнего времени. */
export const EUROPE_SERVER_OFFSET_MINUTES = 60;

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isValid(p: DateParts): boolean {
  if (p.month < 1 || p.month > 12 || p.day < 1 || p.hour > 23 || p.minute > 59 || p.second > 59) {
    return false;
  }
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDate() === p.day;
}

/**
 * «2026-09-23 11:00:00», «2026-09-28 3:59:59», «2026-08-20 10:00», «2026-08-15».
 * Дата без времени означает конец дня: так страницы кодов пишут последний день.
 */
export function parseIsoLike(text: string): DateParts | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(text);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  const parts: DateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: hasTime ? Number(m[4]) : 23,
    minute: hasTime ? Number(m[5]) : 59,
    second: hasTime ? Number(m[6] ?? 0) : 59,
  };
  return isValid(parts) ? parts : null;
}

/** «August 9, 2026 08:59» (фандом Wuthering Waves) и «Sep 01, 2026, 23:00» (wiki.gg). */
export function parseEnglishDate(text: string): DateParts | null {
  const m = /^\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const month = MONTHS.findIndex((short) => name.startsWith(short)) + 1;
  if (month === 0) return null;
  const parts: DateParts = {
    year: Number(m[3]),
    month,
    day: Number(m[2]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: 0,
  };
  return isValid(parts) ? parts : null;
}

/** «GMT+8», «UTC+1», «UTC−5», «UTC&minus;5» — в минутах; иначе null. */
export function parseOffset(text: string): number | null {
  const m = /^\s*(?:GMT|UTC)\s*(\+|-|−|&minus;)\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? 0);
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === "+" ? 1 : -1) * (hours * 60 + minutes);
}

/** Момент для даты, записанной со смещением от UTC. */
export function atOffset(p: DateParts, offsetMinutes: number): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - offsetMinutes * 60;
}

// Форматтер Intl дорог в создании, а на каждую дату нужно два вызова: он один на пояс. Пояса не растут —
// их единицы (America/Los_Angeles), поэтому таблица не разрастается.
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(timeZone);
  if (format === undefined) {
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
    zoneFormats.set(timeZone, format);
  }
  return format;
}

/** Смещение часового пояса в минутах в данный момент — через Intl, без таблиц. */
function zoneOffsetAt(unix: number, timeZone: string): number {
  const format = zoneFormat(timeZone);
  const fields: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(unix * 1000))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const asUtc =
    Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour!, fields.minute!, fields.second!) / 1000;
  return Math.round((asUtc - unix) / 60);
}

/**
 * Момент для местной даты в поясе с летним временем. Смещение уточняется
 * вторым проходом: у границы перевода часов первая догадка может промахнуться.
 */
export function inTimeZone(p: DateParts, timeZone: string): number {
  const naive = atOffset(p, 0);
  const first = zoneOffsetAt(naive, timeZone);
  const guess = naive - first * 60;
  const second = zoneOffsetAt(guess, timeZone);
  return second === first ? guess : naive - second * 60;
}
