// Разбор кодов. Только чистые функции над текстом страницы или телом ответа:
// сеть и выбор источника живут в registry.ts.

import type { Code, GameId } from "../types.ts";
import { atOffset, inTimeZone, parseEnglishDate, parseIsoLike } from "../time.ts";
import { rewardsFits } from "../validate.ts";
import { findTemplates, rewardsText, templateParams } from "../wikitext.ts";

export interface ParsedCodes {
  found: boolean;
  codes: Code[];
  parsed: number;
  dropped: number;
}

export const ENNEAD_SOURCE = "https://github.com/torikushiii/hoyoverse-api";

export const CODE_PATTERN = /^[A-Za-z0-9]{4,40}$/;

// "" сюда не входит: пустая или отсутствующая ячейка срока — это не «бессрочный код»,
// а признак того, что позиционные поля сместились (например, редактор вики убрал
// колонку даты обнаружения). Такая строка должна быть выброшена, а не тихо
// превращена в код без срока — см. hoyoExpiry и вызывающий код ниже.
const NO_EXPIRY = new Set(["unknown", "indef", "indefinite", "tba"]);

/** Срок из ячейки страницы HoYoverse: null — без срока, undefined — не разобрать. */
function hoyoExpiry(value: string): number | null | undefined {
  const text = value.trim();
  if (NO_EXPIRY.has(text.toLowerCase())) return null;
  const parts = parseIsoLike(text);
  return parts ? atOffset(parts, 0) : undefined;
}

export function parseRowCodes(
  wikitext: string,
  template: "Code Row" | "Redemption Code Row",
  gameId: GameId,
  source: string,
): ParsedCodes {
  const rows = findTemplates(wikitext, template);
  const found = rows.length > 0 || wikitext.includes(`{{${template}/Header}}`);
  const codes: Code[] = [];
  let parsed = 0;
  let dropped = 0;
  for (const row of rows) {
    const { positional, named } = templateParams(row);
    const [cell = "", server = "", rewards = "", , expiry = ""] = positional;
    const expiryNorm = expiry.trim().toLowerCase();
    // CN-сервер, отмеченные не-коды, уже истёкшие строки (`exp`/`expired`) и старые
    // кросс-промо в ячейке кода (ссылка вида `[[...]]`/`[https://...]`) — не коды:
    // пропускаются целиком, как CN, а не считаются разобранными и выброшенными,
    // иначе доля «выброшенного» росла бы на совершенно здоровой странице.
    if (
      server.trim().toUpperCase() === "CN" ||
      named.get("notacode")?.toLowerCase() === "yes" ||
      expiryNorm === "exp" ||
      expiryNorm === "expired" ||
      cell.trim().startsWith("[")
    ) {
      continue;
    }
    parsed++;
    const expiresAt = hoyoExpiry(expiry);
    const group = cell.split(";").map((code) => code.trim());
    const rewardsValue = rewardsText(rewards);
    if (expiresAt === undefined || group.some((code) => !CODE_PATTERN.test(code)) || !rewardsFits(rewardsValue)) {
      dropped++;
      continue;
    }
    for (const code of group) {
      codes.push({ gameId, code, rewards: rewardsValue, expiresAt, region: "all", source });
    }
  }
  return { found, codes, parsed, dropped };
}

// Голова строки: код, колонка сервера и начало списка наград. Серия пробелов между
// `||` покрыта одним `[^|]*` и не пересекается с соседними `\s*` — иначе движок на
// длинной серии перебирает все способы её разделить.
const WUWA_HEAD = /<code>([^<]+)<\/code>\s*\|\|[^|]*\|\|\s*(?=\{\{Card List)/g;
// Значение срока после «Valid until:». Липкое: проверяется ровно с заданной позиции.
const WUWA_UNTIL = /\s*([^'<\n]+)/y;
const CARD_LIST = "{{Card List";
const VALID_UNTIL = "Valid until:";

/** Первое «Valid until:» со значением начиная с from: само значение и позиция за ним. */
function validUntil(section: string, from: number): { value: string; end: number } | null {
  for (let at = section.indexOf(VALID_UNTIL, from); at !== -1; at = section.indexOf(VALID_UNTIL, at + VALID_UNTIL.length)) {
    WUWA_UNTIL.lastIndex = at + VALID_UNTIL.length;
    const m = WUWA_UNTIL.exec(section);
    if (m) return { value: m[1]!, end: WUWA_UNTIL.lastIndex };
  }
  return null;
}

/**
 * Строки таблицы активных кодов: [код, `{{Card List…}}`, срок]. Раньше это делало
 * одно выражение с двумя ленивыми `[\s\S]*?`, и на строках без срока оно перебирало
 * сочетания (почти куб от числа строк). Результат тот же, но вперёд идём один раз:
 * первая `}}` после начала списка, за ней первое «Valid until:» со значением. Если
 * для строки нет ни того ни другого, то нет и для любой следующей: их `}}` и срок
 * лежат не раньше. Поэтому на первой такой строке разбор заканчивается.
 */
function wuwaRows(section: string): [string, string, string][] {
  const rows: [string, string, string][] = [];
  WUWA_HEAD.lastIndex = 0;
  for (let head = WUWA_HEAD.exec(section); head !== null; head = WUWA_HEAD.exec(section)) {
    const cardStart = WUWA_HEAD.lastIndex;
    const cardEnd = section.indexOf("}}", cardStart + CARD_LIST.length);
    const until = cardEnd === -1 ? null : validUntil(section, cardEnd + 2);
    if (until === null) break;
    rows.push([head[1]!, section.slice(cardStart, cardEnd + 2), until.value]);
    WUWA_HEAD.lastIndex = until.end;
  }
  return rows;
}

export function parseWuwaCodes(wikitext: string, source: string): ParsedCodes {
  const start = wikitext.indexOf("===Active===");
  if (start === -1) return { found: false, codes: [], parsed: 0, dropped: 0 };
  const rest = wikitext.slice(start + "===Active===".length);
  const next = rest.search(/\n===[^=]/);
  const section = next === -1 ? rest : rest.slice(0, next);
  const codes: Code[] = [];
  let parsed = 0;
  let dropped = 0;
  for (const [rawCode, card, rawUntil] of wuwaRows(section)) {
    parsed++;
    const code = rawCode.trim();
    const until = rawUntil.replace(/\(PT\)/, "").trim();
    let expiresAt: number | null = null;
    if (until.toLowerCase() !== "unknown") {
      const parts = parseEnglishDate(until);
      if (!parts) {
        dropped++;
        continue;
      }
      expiresAt = inTimeZone(parts, "America/Los_Angeles");
    }
    const rewardsValue = rewardsText(card);
    if (!CODE_PATTERN.test(code) || !rewardsFits(rewardsValue)) {
      dropped++;
      continue;
    }
    codes.push({ gameId: "wuthering", code, rewards: rewardsValue, expiresAt, region: "all", source });
  }
  return { found: true, codes, parsed, dropped };
}

export function parseEnneadCodes(json: unknown, gameId: GameId): ParsedCodes {
  const active = (json as { active?: unknown } | null)?.active;
  if (!Array.isArray(active)) return { found: false, codes: [], parsed: 0, dropped: 0 };
  const codes: Code[] = [];
  let dropped = 0;
  for (const entry of active) {
    // Испорченная запись (не объект) — не код, но не повод падать: просто выброшена.
    if (typeof entry !== "object" || entry === null) {
      dropped++;
      continue;
    }
    const item = entry as { code?: unknown; rewards?: unknown };
    const code = typeof item.code === "string" ? item.code.trim() : "";
    const rewardsList = Array.isArray(item.rewards) ? item.rewards.filter((r) => typeof r === "string") : [];
    const rewardsValue = rewardsList.join(", ");
    if (!CODE_PATTERN.test(code) || !rewardsFits(rewardsValue)) {
      dropped++;
      continue;
    }
    codes.push({ gameId, code, rewards: rewardsValue, expiresAt: null, region: "all", source: ENNEAD_SOURCE });
  }
  return { found: true, codes, parsed: active.length, dropped };
}
