// Разбор баннеров персонажей. Страницы фандома у HoYoverse и Wuthering Waves
// устроены одинаково: шаблон со сроками и шаблон пула с главным персонажем.

import type { Banner, GameId } from "../types.ts";
import { EUROPE_SERVER_OFFSET_MINUTES, atOffset, parseEnglishDate, parseIsoLike, parseOffset } from "../time.ts";
import { bannerFits } from "../validate.ts";
import { findTemplates, templateParams } from "../wikitext.ts";
import { ENNEAD_SOURCE } from "./codes.ts";

export interface BannerPageSpec {
  gameId: GameId;
  wiki: string;
  category: string;
  template: string;
  poolTemplate: string;
  featuredKey: string;
  rarity: number;
  /** Нужный вид баннера, если категория смешанная (у Wuthering Waves — вместе с оружием). */
  type?: string;
}

export const BANNER_PAGES: Record<"genshin" | "hsr" | "zzz" | "wuthering", BannerPageSpec> = {
  genshin: { gameId: "genshin", wiki: "genshin-impact", category: "Character_Event_Wishes", template: "Wish", poolTemplate: "Wish Pool", featuredKey: "character_5_F", rarity: 5 },
  hsr: { gameId: "hsr", wiki: "honkai-star-rail", category: "Character_Event_Warps", template: "Warp", poolTemplate: "Warp Pool", featuredKey: "character_5_F", rarity: 5 },
  zzz: { gameId: "zzz", wiki: "zenless-zone-zero", category: "Exclusive_Channel_Signal_Searches", template: "Signal Search Infobox", poolTemplate: "Signal Search Pool", featuredKey: "agent_S_F", rarity: 5 },
  wuthering: { gameId: "wuthering", wiki: "wutheringwaves", category: "Convene", template: "Convene", poolTemplate: "Convene/Pool", featuredKey: "resonator_5_F", rarity: 5, type: "Featured Resonator" },
};

export interface BannerDraft {
  banner: Banner;
  imageFile: string | null;
}

export type PageOutcome = { kind: "banner"; draft: BannerDraft } | { kind: "skip" } | { kind: "bad"; reason: string };

/** Непустое смещение — глобальный момент; пустое — серверное время Европы. undefined — не разобрать. */
function moment(value: string, offsetText: string | undefined): number | undefined {
  const parts = parseIsoLike(value);
  if (!parts) return undefined;
  const offset = offsetText && offsetText.trim() !== "" ? parseOffset(offsetText) : EUROPE_SERVER_OFFSET_MINUTES;
  return offset === null ? undefined : atOffset(parts, offset);
}

export function parseBannerPage(wikitext: string, spec: BannerPageSpec, title: string, pageUrl: string): PageOutcome {
  const call = findTemplates(wikitext, spec.template)[0];
  if (call === undefined) return { kind: "bad", reason: `нет шаблона ${spec.template}` };
  const { named } = templateParams(call);
  if (spec.type && named.get("type") !== spec.type) return { kind: "skip" };
  const endText = named.get("time_end") ?? "";
  if (endText === "" || endText.toUpperCase() === "TBA") return { kind: "skip" };
  const startsAt = moment(named.get("time_start") ?? "", named.get("time_start_offset"));
  const endsAt = moment(endText, named.get("time_end_offset"));
  if (startsAt === undefined || endsAt === undefined) return { kind: "bad", reason: "сроки не разбираются" };
  if (startsAt >= endsAt) return { kind: "bad", reason: "конец раньше начала" };
  const pool = findTemplates(wikitext, spec.poolTemplate)[0];
  const featured = (pool === undefined ? "" : (templateParams(pool).named.get(spec.featuredKey) ?? ""))
    .split(";")
    .map((name) => name.trim())
    .filter((name) => name !== "" && !/^unknown/i.test(name));
  const image = (named.get("image") ?? "").trim();
  const bannerTitle = title.split("/")[0]!.trim();
  // Страница без названия (`/a/2099-01-01`) или с названием не по пределам — не баннер: выбрасывается здесь, а не на проверке файла.
  if (!bannerFits(bannerTitle, featured)) return { kind: "bad", reason: "название пустое или название и список персонажей не по пределам" };
  return {
    kind: "banner",
    draft: {
      banner: {
        gameId: spec.gameId,
        title: bannerTitle,
        featured,
        rarity: spec.rarity,
        image: null,
        startsAt,
        endsAt,
        url: pageUrl,
      },
      imageFile: image === "" ? null : image,
    },
  };
}

const DATED = /^.+\/(\d{4}-\d{2}-\d{2})$/;

/** Датированные подстраницы баннеров не старше days дней, без повторов, в исходном порядке. */
export function recentBannerPages(titles: string[], now: number, days = 60): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const title of titles) {
    const m = DATED.exec(title);
    if (!m || seen.has(title)) continue;
    const parts = parseIsoLike(m[1]!);
    if (!parts || atOffset(parts, 0) < now - days * 86400) continue;
    seen.add(title);
    result.push(title);
  }
  return result;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
const decode = (text: string) => text.replace(/&(?:amp|quot|#39|lt|gt|nbsp);/g, (e) => ENTITIES[e] ?? e);

// Срок берётся целиком, от `<span>` до скрытого `<span>` со смещением, и режется по
// «&ndash;» уже в коде (splitRange): ленивые группы по обе стороны от разделителя
// на длинной строке перебирали бы все его положения.
const EF_TIMES =
  /AM \/ EU<\/abbr>:<\/b>\s*<span[^>]*>([^<]*)<span class="visually-hidden">\((UTC[^)]*)\)<\/span>/;
// Начало ссылки на оператора после `</span>`. Липкое: проверяется ровно с заданной позиции.
const EF_LINK_OPEN = /\s*\[\[/y;

const SPAN_END = "</span>";
const DASH = "&ndash;";
const HEADER_OPEN = '<div class="header"';
const DIV_END = "</div>";
const FILE_OPEN = "[[File:";

/**
 * Название баннера: текст от `>` первого `<div class="header"…>` до `</div>`. Прежнее
 * выражение для каждого `<div class="header"` заново искало `>`, и на длинной цепочке
 * таких начал без `>` каждое перечитывало остаток строки. Ближайшая `>` общая для всех
 * начал до неё, поэтому проверяется один раз.
 */
function headerTitle(row: string): string | undefined {
  let checked = -1; // `>`, с которой уже сверялось предыдущее начало
  for (let at = row.indexOf(HEADER_OPEN); at !== -1; at = row.indexOf(HEADER_OPEN, at + HEADER_OPEN.length)) {
    const from = at + HEADER_OPEN.length;
    if (from <= checked) continue; // та же `>`, а с ней предыдущее начало не подошло
    const tagEnd = row.indexOf(">", from);
    if (tagEnd === -1) return undefined;
    checked = tagEnd;
    const textEnd = row.indexOf("<", tagEnd + 1);
    if (textEnd > tagEnd + 1 && row.startsWith(DIV_END, textEnd)) return row.slice(tagEnd + 1, textEnd);
  }
  return undefined;
}

/** Индекс первого `]` или `|` начиная с from; -1, если их больше нет. */
function nextLinkEnd(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "]" || text[j] === "|") return j;
  }
  return -1;
}

/** Имя файла из первой ссылки `[[File:Имя|…`; конец имени ищется так же, как у оператора ниже. */
function fileName(row: string): string | undefined {
  let end = -2; // -2 — ещё не искали, -1 — `]` и `|` больше нет
  for (let at = row.indexOf(FILE_OPEN); at !== -1; at = row.indexOf(FILE_OPEN, at + FILE_OPEN.length)) {
    const from = at + FILE_OPEN.length;
    if (end !== -1 && end < from) end = nextLinkEnd(row, from);
    if (end === -1) return undefined;
    if (end > from && row[end] === "|") return row.slice(from, end);
  }
  return undefined;
}

/**
 * Имя из первой ссылки `[[Имя]]` сразу после `</span>` (между ними возможны пробелы);
 * undefined, если такой нет. Прежнее выражение для каждого `</span>[[` заново читало имя
 * до ближайшей `]` или `|`, и на длинной цепочке обрывков это давало квадрат. Конец имени
 * один на все кандидаты до него, поэтому ищется он заново, только когда прежний остался
 * позади: весь поиск — один проход по тексту.
 */
function firstOperator(text: string): string | undefined {
  let end = -2; // -2 — ещё не искали, -1 — `]` и `|` больше нет
  for (let at = text.indexOf(SPAN_END); at !== -1; at = text.indexOf(SPAN_END, at + SPAN_END.length)) {
    EF_LINK_OPEN.lastIndex = at + SPAN_END.length;
    if (!EF_LINK_OPEN.test(text)) continue;
    const from = EF_LINK_OPEN.lastIndex;
    if (end !== -1 && end < from) end = nextLinkEnd(text, from);
    if (end === -1) return undefined;
    if (end > from && text.startsWith("]]", end)) return text.slice(from, end);
  }
  return undefined;
}

/** «Sep 01, 2026, 23:00 &ndash; Sep 30, 2026, 11:59 » → обе даты без пробелов по краям; null, если разделителя нет. */
function splitRange(text: string): [string, string] | null {
  const at = text.indexOf(DASH);
  return at === -1 ? null : [text.slice(0, at).trim(), text.slice(at + DASH.length).trim()];
}

/** Раскрытая таблица {{Banner table|…}} с wiki.gg. Время — строка AM / EU (европейский сервер). */
export function parseEndfieldTable(expanded: string, pageUrl: string): { drafts: BannerDraft[]; parsed: number; dropped: number } {
  const rows = expanded.split('<tr valign="top">').slice(1);
  const drafts: BannerDraft[] = [];
  let dropped = 0;
  for (const row of rows) {
    const title = headerTitle(row);
    const times = EF_TIMES.exec(row);
    const limited = row.split("Limited operators:")[1] ?? "";
    const operator = firstOperator(limited);
    const range = times ? splitRange(times[1]!) : null;
    const start = range ? parseEnglishDate(range[0]) : null;
    const end = range ? parseEnglishDate(range[1]) : null;
    const offset = times ? parseOffset(times[2]!) : null;
    if (!title || !start || !end || offset === null) {
      dropped++;
      continue;
    }
    const startsAt = atOffset(start, offset);
    const endsAt = atOffset(end, offset);
    if (startsAt >= endsAt) {
      dropped++;
      continue;
    }
    const bannerTitle = decode(title).trim();
    // «[[ ]]» вместо имени — оператора нет: баннер остаётся без имени, пустое имя в список не попадает.
    const operatorName = operator ? decode(operator).trim() : "";
    const featured = operatorName === "" ? [] : [operatorName];
    if (!bannerFits(bannerTitle, featured)) {
      dropped++;
      continue;
    }
    drafts.push({
      banner: {
        gameId: "endfield",
        title: bannerTitle,
        featured,
        rarity: 6,
        image: null,
        startsAt,
        endsAt,
        url: pageUrl,
      },
      imageFile: fileName(row)?.trim() ?? null,
    });
  }
  return { drafts, parsed: rows.length, dropped };
}

interface EnneadPerson {
  name?: unknown;
  rarity?: unknown;
}

/** true у непустого объекта: элементы списков ennead.cc бывают null или не объектом вовсе. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isWholeNumber = (value: unknown): value is number => Number.isInteger(value);

/** Календарь ennead.cc — запасной источник. Только баннеры персонажей; название — главные персонажи. */
export function parseEnneadBanners(
  json: unknown,
  gameId: "genshin" | "hsr" | "zzz",
): { found: boolean; banners: Banner[]; parsed: number; dropped: number } {
  const list = (json as { banners?: unknown } | null)?.banners;
  if (!Array.isArray(list)) return { found: false, banners: [], parsed: 0, dropped: 0 };
  const banners: Banner[] = [];
  let parsed = 0;
  let dropped = 0;
  for (const entry of list as unknown[]) {
    // Испорченная запись (не объект) — не баннер, но не повод падать: просто пропущена.
    if (!isRecord(entry)) continue;
    let people: EnneadPerson[];
    let top: unknown;
    if (gameId === "zzz") {
      if (entry.banner_type !== "GACHA_TYPE_CHARACTER_UP") continue;
      people = Array.isArray(entry.agents) ? (entry.agents as EnneadPerson[]) : [];
      top = "S";
    } else {
      people = Array.isArray(entry.characters) ? (entry.characters as EnneadPerson[]) : [];
      top = 5;
    }
    const featured = people
      .filter((p): p is EnneadPerson => isRecord(p) && p.rarity === top && typeof p.name === "string")
      .map((p) => (p.name as string).trim());
    if (featured.length === 0) continue;
    parsed++;
    const startsAt = entry.start_time;
    const endsAt = entry.end_time;
    const title = featured.join(" / ");
    // Время — целые секунды, как требует проверка файла: 1788256800.5 — не баннер, а выброшенная запись.
    if (!isWholeNumber(startsAt) || !isWholeNumber(endsAt) || startsAt >= endsAt || !bannerFits(title, featured)) {
      dropped++;
      continue;
    }
    banners.push({ gameId, title, featured, rarity: 5, image: null, startsAt, endsAt, url: ENNEAD_SOURCE });
  }
  return { found: true, banners, parsed, dropped };
}
