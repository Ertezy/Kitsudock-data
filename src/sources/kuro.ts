// Официальные анонсы Kuro Games для Wuthering Waves. Условия сайта запрещают
// воспроизводить его содержимое, поэтому берутся только факты: название баннера,
// имя 5★ резонатора, даты и конец техработ — со ссылкой на сам анонс. Ни текста
// статей, ни картинок здесь нет. Источник убирается при первой просьбе Kuro
// (спека §6.2, §7, поправка от 30 сентября 2026). Номер статьи и время её
// публикации дополнительно служат сигналом владельцу: если самый свежий анонс
// баннера персонажа прочитан, а баннера из него не вышло (и владелец не вписал его
// в overrides.json), сборщик открывает задачу.

import { atOffset, EUROPE_SERVER_OFFSET_MINUTES, parseIsoLike } from "../time.ts";
import { GAME_IDS, type Banner, type HubData } from "../types.ts";
import { MAX_KURO_BANNERS_PER_ARTICLE, bannerFits } from "../validate.ts";
import { isSpace, replaceTags } from "../wikitext.ts";

export const KURO_MENU_URL =
  "https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/en/ArticleMenu.json";

/** JSON статьи; из него берутся только факты (см. kuroBannerFacts и maintenanceEnd). */
export const KURO_ARTICLE_JSON_DIR = "https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/en/article/";

export const kuroArticleJsonUrl = (id: number) => `${KURO_ARTICLE_JSON_DIR}${id}.json`;

const KURO_NEWS_PREFIX = "https://wutheringwaves.kurogames.com/en/main/news/detail/";

export const kuroArticleUrl = (id: number) => `${KURO_NEWS_PREFIX}${id}`;

/** Ссылка на анонс Kuro: так записи Kuro отличаются от записей вики. */
export const isKuroUrl = (url: string) => url.startsWith(KURO_NEWS_PREFIX);

export interface Announcement {
  articleId: number;
  publishedAt: number;
  url: string;
}

/** Патчноут версии: из него берётся только конец техработ — начало баннеров «с выходом версии». */
export interface PatchNotes {
  articleId: number;
  version: string;
  publishedAt: number;
}

/** Время на сайте Kuro — UTC+8. */
const KURO_OFFSET_MINUTES = 480;

const FRESH_SECONDS = 21 * 86400;

/** Статья не старше 21 дня и уже опубликована. */
export const isFresh = (publishedAt: number, now: number) => publishedAt >= now - FRESH_SECONDS && publishedAt <= now;

/** Анонс только про оружие («[X] Featured / Reverb / Collab Weapon Convene»): баннера персонажа в нём нет, читать его и ждать от него баннера незачем. */
export const isWeaponOnly = (title: string) => /Weapon Convene/i.test(title) && !/Resonator/i.test(title);

/** Меню: свежие анонсы баннеров персонажей и свежие патчноуты, самые новые первыми. Оружейные анонсы пропускаются. */
export function conveneAnnouncements(
  json: unknown,
  now: number,
): { found: boolean; announcements: Announcement[]; patchNotes: PatchNotes[] } {
  if (!Array.isArray(json)) return { found: false, announcements: [], patchNotes: [] };
  const announcements: Announcement[] = [];
  const patchNotes: PatchNotes[] = [];
  for (const article of json as { articleId?: unknown; articleTitle?: unknown; startTime?: unknown }[]) {
    if (typeof article !== "object" || article === null) continue;
    if (typeof article.articleId !== "number" || typeof article.articleTitle !== "string" || typeof article.startTime !== "string") continue;
    const title = article.articleTitle;
    const isConvene = /convene/i.test(title) && !/^\s*convene details\s*$/i.test(title) && !isWeaponOnly(title);
    const version = patchNotesVersion(title);
    if (!isConvene && version === null) continue;
    const parts = parseIsoLike(article.startTime);
    if (!parts) continue;
    const publishedAt = atOffset(parts, KURO_OFFSET_MINUTES);
    if (!isFresh(publishedAt, now)) continue;
    if (isConvene) announcements.push({ articleId: article.articleId, publishedAt, url: kuroArticleUrl(article.articleId) });
    if (version !== null) patchNotes.push({ articleId: article.articleId, version, publishedAt });
  }
  announcements.sort((a, b) => b.publishedAt - a.publishedAt);
  patchNotes.sort((a, b) => b.publishedAt - a.publishedAt);
  return { found: true, announcements, patchNotes };
}

/** Баннер, вписанный владельцем, начинается не раньше чем за 2 суток до выхода анонса — значит, он про этот анонс. */
const MANUAL_BANNER_SECONDS = 2 * 86400;

/**
 * Сигнал владельцу: самый свежий анонс баннера персонажа, статья которого прочитана,
 * но баннеров в ней не нашлось. Решается по запомненным фактам (`facts` — по номеру
 * статьи строкой): ключа нет — статью ещё не удалось прочитать (сбой сети, статус
 * не 200), и это не повод для задачи; пустой список — прочитана (в том числе ответ 200
 * без текста статьи), баннеров нет. Учитываются только свежие анонсы (не старше
 * 21 дня); оружейные в список не попадают. Если несколько анонсов вышли в одну секунду,
 * «самыми свежими» считаются все они. Владелец уже вписал баннер вручную, если у
 * какого-то баннера из overrides.json (`manualStarts` — его начала) начало не раньше
 * времени выхода самого свежего анонса минус 2 суток: тогда сигнала нет и задача закроется.
 */
export function unreadableAnnouncement(
  announcements: Announcement[],
  facts: Record<string, KuroBannerFact[]>,
  now: number,
  manualStarts: readonly number[] = [],
): Announcement | null {
  const fresh = announcements.filter((a) => isFresh(a.publishedAt, now));
  if (fresh.length === 0) return null;
  const latest = Math.max(...fresh.map((a) => a.publishedAt));
  if (manualStarts.some((start) => start >= latest - MANUAL_BANNER_SECONDS)) return null;
  const empty = fresh.filter((a) => a.publishedAt === latest && facts[String(a.articleId)]?.length === 0);
  return empty.sort((a, b) => b.articleId - a.articleId)[0] ?? null;
}

/** Идёт ли ещё хотя бы один из баннеров, прочитанных из анонса: по ним анонс помнится и после 21 дня. */
export const hasLiveBanner = (banners: KuroBannerFact[] | undefined, now: number) => (banners ?? []).some((b) => b.endsAt > now);

/** Начало баннера: момент или «с выходом версии X.Y». */
export type KuroStart = { kind: "at"; at: number } | { kind: "release"; version: string };

export interface KuroBannerFact {
  title: string;
  /** Имя 5★ резонатора; пустая строка — у повторного баннера персонажа выбирают из списка. */
  featured: string;
  start: KuroStart;
  /** Unix-секунды. */
  endsAt: number;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Именованные и числовые (&#10022;, &#x2726;) сущности; незнакомые остаются как есть. */
const decodeEntities = (text: string) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

// Начало тега, который означает перевод строки: `<br>`, `<br/>`, `<p …>`, `</div>`, `<li>`, `<h1>`…
const BREAK_TAG = /<(?:br\s*\/?(?=>)|\/?(?:p|div|li|h[1-6])\b)/iy;

/**
 * Текст статьи из JSON Kuro: теги убраны, <br>, <p>, <div>, <li> и <h1>–<h6> —
 * переводы строк, сущности раскрыты, пустые строки выброшены. Не объект или
 * нет articleContent — null.
 */
export function articleText(article: unknown): string[] | null {
  if (typeof article !== "object" || article === null) return null;
  const content = (article as { articleContent?: unknown }).articleContent;
  if (typeof content !== "string") return null;
  // Теги режутся до раскрытия сущностей: «&lt;b&gt;» должно остаться текстом.
  const withBreaks = replaceTags(content, "\n", BREAK_TAG);
  return decodeEntities(replaceTags(withBreaks, ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Название статьи из её JSON (или null); из него берётся только заголовок одиночного баннера. */
export function articleTitle(article: unknown): string | null {
  if (typeof article !== "object" || article === null) return null;
  const title = (article as { articleTitle?: unknown }).articleTitle;
  return typeof title === "string" ? decodeEntities(title).trim() : null;
}

// Баннеры персонажей бывают обычные (Featured), повторные (Reverb) и совместные (Collab).
const RESONATOR_HEAD = /^\[(.+?)\]\s*(?:Featured|Reverb|Collab)\s+Resonator Convene\s*$/i;
const ANY_HEAD = /^\[.+?\]\s*(?:Featured|Reverb|Collab)\s+(?:Resonator|Weapon) Convene\s*$/i;
const FEATURED_LABEL = /5-Star Resonator:/gi;
const RECEIVE = /receive/gi;
// Конец срока после « - »: пробелы, дата и «(server time)». Липкое: проверяется с заданной позиции.
const DURATION_END = /\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\(server time\)/iy;
const RELEASE_START = /^version\s+(\d+\.\d+)\s+update$/i;
const MINUTE_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const SELECTABLE = /selectable 5-Star Resonators?:/i;
// Перевод строки: точка в выражениях ниже его не пересекает.
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * Имя после «5-Star Resonator:» — до «,», «!», слова «receive» или конца строки, без
 * пробелов по краям. Это `/5-Star Resonator:\s*([^,!]+?)\s*(?:,|receive|!|$)/i`, но без
 * перебора: там `\s*` и `[^,!]+?` делили между собой каждую серию пробелов внутри
 * имени заново. Если после метки сразу «,», «!» или конец, имени нет; единственный
 * пробел перед ними выражение считало именем — так оставлено.
 */
function featuredName(line: string): string | undefined {
  FEATURED_LABEL.lastIndex = 0;
  for (let label = FEATURED_LABEL.exec(line); label !== null; label = FEATURED_LABEL.exec(line)) {
    const after = FEATURED_LABEL.lastIndex;
    let stop = after; // первая «,» или «!» либо конец строки
    while (stop < line.length && line[stop] !== "," && line[stop] !== "!") stop++;
    let name = after; // начало имени после пробелов
    while (name < stop && isSpace(line[name]!)) name++;
    if (name === stop) {
      if (name > after) return line[name - 1];
      continue;
    }
    RECEIVE.lastIndex = name + 1;
    const receive = RECEIVE.exec(line);
    let end = receive !== null && receive.index < stop ? receive.index : stop;
    while (end > name + 1 && isSpace(line[end - 1]!)) end--;
    return line.slice(name, end);
  }
  return undefined;
}

/**
 * «Начало - 2026-09-30 11:59 (server time)» → [начало, конец]; null, если такого нет. Это
 * `/^(.+?)\s+-\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\(server time\)/i`, но без перебора:
 * там `.+?` и `\s+` делили каждую серию пробелов внутри начала заново. Начало кончается
 * там, где перед очередным « - » начинается пробельная серия (но не раньше первого символа).
 */
function durationOf(line: string): [string, string] | null {
  const lineBreak = line.search(LINE_BREAK);
  for (let dash = line.indexOf("-"); dash !== -1; dash = line.indexOf("-", dash + 1)) {
    if (dash === 0 || !isSpace(line[dash - 1]!)) continue;
    let gap = dash - 1; // начало пробельной серии перед «-»
    while (gap > 0 && isSpace(line[gap - 1]!)) gap--;
    const end = Math.max(gap, 1);
    if (end >= dash) continue;
    DURATION_END.lastIndex = dash + 1;
    const m = DURATION_END.exec(line);
    if (m === null) continue;
    // Начало не должно содержать перевода строки; у следующих « - » оно только длиннее.
    return lineBreak !== -1 && lineBreak < end ? null : [line.slice(0, end), m[1]!];
  }
  return null;
}

/** Баннер персонажа из блока строк под его заголовком; null — имени 5★ или понятных дат нет. */
function blockFact(title: string, block: string[]): KuroBannerFact | null {
  const named = block.map(featuredName).find((name) => name !== undefined);
  // У повторного баннера (Reverb) 5★ персонажа игрок выбирает из списка — одного имени нет,
  // и баннер показывается без имён (пустая строка).
  const featured = named ?? (block.some((line) => SELECTABLE.test(line)) ? "" : undefined);
  const duration = block.map(durationOf).find((range) => range !== null);
  if (featured === undefined || !duration) return null;
  const endParts = parseIsoLike(duration[1]);
  if (!endParts) return null;
  const endsAt = atOffset(endParts, EUROPE_SERVER_OFFSET_MINUTES);
  const from = duration[0].trim();
  const release = RELEASE_START.exec(from);
  if (release) return { title, featured, start: { kind: "release", version: release[1]! }, endsAt };
  // Только «ГГГГ-ММ-ДД ЧЧ:ММ»: голая дата у parseIsoLike означала бы конец дня.
  const startParts = MINUTE_STAMP.test(from) ? parseIsoLike(from) : null;
  if (!startParts) return null;
  const at = atOffset(startParts, EUROPE_SERVER_OFFSET_MINUTES);
  if (at >= endsAt) return null;
  return { title, featured, start: { kind: "at", at }, endsAt };
}

/**
 * Баннеры персонажей из анонса. Пустой массив — ничего не нашлось. Одиночный баннер
 * пишется без строки «[Название] Featured Resonator Convene» в теле — она есть только
 * в названии статьи (`ownTitle`); тогда заголовком служит оно, а блок — всё тело
 * до первого оружейного заголовка. Из статьи берутся первые MAX_KURO_BANNERS_PER_ARTICLE
 * баннеров: больше в анонсе не бывает, а остальное — испорченная страница.
 */
export function kuroBannerFacts(lines: string[], ownTitle?: string | null): KuroBannerFact[] {
  const heads: number[] = [];
  lines.forEach((line, index) => {
    if (ANY_HEAD.test(line)) heads.push(index);
  });
  const facts: KuroBannerFact[] = [];
  const push = (fact: KuroBannerFact | null) => {
    if (fact && facts.length < MAX_KURO_BANNERS_PER_ARTICLE) facts.push(fact);
  };
  if (!lines.some((line) => RESONATOR_HEAD.test(line))) {
    const own = ownTitle ? RESONATOR_HEAD.exec(ownTitle.trim())?.[1]?.trim() : undefined;
    if (own) push(blockFact(own, lines.slice(0, heads[0] ?? lines.length)));
    return facts;
  }
  for (let n = 0; n < heads.length && facts.length < MAX_KURO_BANNERS_PER_ARTICLE; n++) {
    const head = heads[n]!;
    const title = RESONATOR_HEAD.exec(lines[head]!)?.[1]?.trim();
    if (!title) continue; // блок оружия
    push(blockFact(title, lines.slice(head + 1, heads[n + 1] ?? lines.length)));
  }
  return facts;
}

const MAINTENANCE =
  /Maintenance Time:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*\(UTC\+8\)/i;

/** Конец техработ из патчноута: «Maintenance Time: A - B (UTC+8)» → B; null, если строки нет. */
export function maintenanceEnd(lines: string[]): number | null {
  for (const line of lines) {
    const m = MAINTENANCE.exec(line);
    const parts = m ? parseIsoLike(m[2]!) : null;
    if (parts) return atOffset(parts, KURO_OFFSET_MINUTES);
  }
  return null;
}

/**
 * Версия из заголовка патчноута («… Version 3.7 …») или null, если это не патчноут.
 * «Version 3.7.1» — уже другая версия (правка к 3.7), и время выхода 3.7 она задавать
 * не должна: такой патчноут пропускается.
 */
export function patchNotesVersion(title: string): string | null {
  if (!/patch notes/i.test(title)) return null;
  return /version\s+(\d+\.\d+)(?!\d|\.\d)/i.exec(title)?.[1] ?? null;
}

/** Анонс и баннеры, прочитанные из его статьи. */
export interface AnnouncementFacts {
  announcement: Announcement;
  banners: KuroBannerFact[];
}

/**
 * Баннеры из фактов. Начало «с выходом версии» — конец техработ этой версии
 * (releases), а пока патчноута нет, — время публикации анонса. Закончившиеся и
 * не влезающие в пределы файла отбрасываются: одна такая запись не пропустила бы
 * проверку всего файла.
 */
export function kuroBanners(facts: AnnouncementFacts[], releases: Record<string, number>, now: number): Banner[] {
  const banners: Banner[] = [];
  for (const { announcement, banners: list } of facts) {
    for (const fact of list) {
      const startsAt = fact.start.kind === "at" ? fact.start.at : (releases[fact.start.version] ?? announcement.publishedAt);
      const featured = fact.featured.trim() === "" ? [] : [fact.featured];
      if (fact.endsAt <= now || fact.endsAt <= startsAt || !bannerFits(fact.title, featured)) continue;
      banners.push({
        gameId: "wuthering",
        title: fact.title,
        featured,
        rarity: 5,
        image: null,
        startsAt,
        endsAt: fact.endsAt,
        url: kuroArticleUrl(announcement.articleId),
      });
    }
  }
  return banners;
}

/** Одно название и начала в пределах 2 суток — это один и тот же баннер, а не его повтор. */
const SAME_BANNER_SECONDS = 2 * 86400;

/** Название для сравнения: кривые и прямые кавычки и апострофы одинаковы, пробелы схлопнуты, регистр не важен. */
const comparableTitle = (title: string) =>
  title
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Сверка «такой баннер уже есть»: одна игра, одно название для сравнения и начала в пределах
 * SAME_BANNER_SECONDS. Начала одной связки (игра + название) разложены по окнам шириной в эти
 * 2 суток, в окне помнятся наименьшее и наибольшее. Подходящее начало может быть только в своём
 * окне (там любое — не дальше 2 суток) и в двух соседних (там — ближайшее к краю): поэтому ответ
 * за O(1), а не перебором всех записей.
 */
class BannerIndex {
  private readonly groups = new Map<string, Map<number, { min: number; max: number }>>();

  private static key(banner: Banner): string {
    return `${banner.gameId}
${comparableTitle(banner.title)}`;
  }

  private static window(startsAt: number): number {
    return Math.floor(startsAt / SAME_BANNER_SECONDS);
  }

  add(banner: Banner): void {
    if (!Number.isFinite(banner.startsAt)) return; // с таким началом баннер ни с чем не совпадает
    const key = BannerIndex.key(banner);
    let windows = this.groups.get(key);
    if (windows === undefined) this.groups.set(key, (windows = new Map()));
    const at = BannerIndex.window(banner.startsAt);
    const known = windows.get(at);
    if (known === undefined) windows.set(at, { min: banner.startsAt, max: banner.startsAt });
    else {
      known.min = Math.min(known.min, banner.startsAt);
      known.max = Math.max(known.max, banner.startsAt);
    }
  }

  has(banner: Banner): boolean {
    if (!Number.isFinite(banner.startsAt)) return false;
    const windows = this.groups.get(BannerIndex.key(banner));
    if (windows === undefined) return false;
    const at = BannerIndex.window(banner.startsAt);
    const before = windows.get(at - 1);
    const after = windows.get(at + 1);
    return (
      windows.has(at) ||
      (before !== undefined && banner.startsAt - before.max <= SAME_BANNER_SECONDS) ||
      (after !== undefined && after.min - banner.startsAt <= SAME_BANNER_SECONDS)
    );
  }
}

/**
 * Добавляет баннеры Kuro, которых там ещё нет. Фандом побеждает: у него есть
 * картинка. Из двух одинаковых записей Kuro остаётся первая (анонсы в списке
 * идут от новых к старым).
 */
export function withKuroBanners(hub: HubData, kuro: Banner[]): HubData {
  const banners = [...hub.banners];
  const index = new BannerIndex();
  for (const banner of banners) index.add(banner);
  for (const banner of kuro) {
    if (index.has(banner)) continue;
    banners.push(banner);
    index.add(banner);
  }
  if (banners.length === hub.banners.length) return hub;
  banners.sort((a, b) => GAME_IDS.indexOf(a.gameId) - GAME_IDS.indexOf(b.gameId) || a.startsAt - b.startsAt);
  return { ...hub, banners };
}
