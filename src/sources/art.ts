// Арт прошлого запуска баннера, когда у текущего его нет (решение владельца 1 октября 2026).
//
// Вики называет файл нового запуска («Название 2026-09-30.png») раньше, чем его
// загружает, а у баннеров по анонсам Kuro картинки нет вовсе: с сайта Kuro берутся
// только факты. Название баннера у HoYoverse и Kuro закреплено за персонажем, и на
// его прошлых запусках — тот же персонаж. Поэтому такой баннер получает самый свежий
// арт с этим названием с фандома своей игры. Ссылка, как и у остальных картинок, —
// на копию у фандома; сами картинки нигде не хранятся.

import { isTransportError, type Http } from "../http.ts";
import { fandom, filesWithPrefix, thumbnails, type WikiFile } from "../mediawiki.ts";
import { isDue } from "../state.ts";
import type { Banner, HubData } from "../types.ts";
import { MAX_ART_LOOKUPS_PER_RUN } from "../validate.ts";
import { BANNER_PAGES } from "./banners.ts";
import { ENNEAD_SOURCE } from "./codes.ts";

/** Как часто перепроверяется один баннер: так же часто, как читаются страницы баннеров фандома. */
export const ART_RECHECK_HOURS = 6;

/** Найденный арт по ключу баннера; image: null — искали и не нашли. */
export type ArtMemory = Record<string, { image: string | null; checkedAt: number }>;

/**
 * Название, как его пишет вики в именах файлов: кавычки и апострофы прямые,
 * двоеточия нет («Name: Part» → «Name Part.png»), косая черта — дефис, пробелы одиночные.
 */
const fileTitle = (title: string) =>
  title
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/:/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Символы, которых не бывает в именах файлов MediaWiki: запрос с ними вики отвергает. */
const NOT_IN_FILE_NAMES = /[#<>[\]{}|]/;

export const artKey = (banner: Banner) => `${banner.gameId}|${fileTitle(banner.title)}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Позже ли загружен a, чем b; при равном (или неизвестном) времени — у кого дата в имени позже. */
const isNewer = (a: WikiFile, b: WikiFile) => {
  const diff = (a.uploadedAt || 0) - (b.uploadedAt || 0);
  return diff !== 0 ? diff > 0 : a.name > b.name;
};

/**
 * Файл с артом этого баннера: «Название.png» или «Название 2026-05-21.jpg», самый
 * свежий. Другие файлы с тем же началом имени («Название Store.png») не подходят.
 */
export function pickPreviousArt(files: WikiFile[], title: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(fileTitle(title))}(?: \\d{4}-\\d{2}-\\d{2})?\\.(?:png|jpe?g|webp)$`, "i");
  let best: WikiFile | null = null;
  for (const file of files) {
    if (pattern.test(file.name) && (best === null || isNewer(file, best))) best = file;
  }
  return best?.name ?? null;
}

const wikiFor = (gameId: Banner["gameId"]) => (gameId in BANNER_PAGES ? fandom(BANNER_PAGES[gameId as keyof typeof BANNER_PAGES].wiki) : null);

/**
 * Нуждается ли баннер в чужом арте: картинки нет, у игры есть фандом, и название —
 * настоящее название баннера. У записей запасного ennead.cc вместо него имена
 * персонажей: по ним нашёлся бы портрет, а не арт баннера.
 */
const wantsArt = (banner: Banner) => banner.image === null && banner.url !== ENNEAD_SOURCE && wikiFor(banner.gameId) !== null;

/**
 * Обновляет память для баннеров без арта — каждый не чаще раза в ART_RECHECK_HOURS.
 * Баннеры, которых больше нет или у которых появилась своя картинка, из памяти
 * убираются. Сбой по одному баннеру оставляет его прошлую картинку, откладывает
 * повтор на тот же срок и возвращается предупреждением: прогон из-за картинки не падает.
 * За прогон проверяется не больше MAX_ART_LOOKUPS_PER_RUN баннеров (остальные — в следующий
 * прогон), а сбой связи (таймаут, обрыв) обрывает поиск: вики не отвечает, остальным баннерам
 * не лучше.
 */
export async function refreshArt(http: Http, banners: Banner[], art: ArtMemory, now: number): Promise<string[]> {
  const warnings: string[] = [];
  const wanted = new Map<string, Banner>();
  for (const banner of banners) if (wantsArt(banner)) wanted.set(artKey(banner), banner);
  for (const key of Object.keys(art)) if (!wanted.has(key)) delete art[key];
  let lookups = 0;
  for (const [key, banner] of wanted) {
    if (!isDue(art[key]?.checkedAt, ART_RECHECK_HOURS, now)) continue;
    const title = fileTitle(banner.title);
    if (NOT_IN_FILE_NAMES.test(title)) {
      art[key] = { image: null, checkedAt: now };
      continue;
    }
    if (lookups >= MAX_ART_LOOKUPS_PER_RUN) break; // остальных проверит следующий прогон
    lookups++;
    const wiki = wikiFor(banner.gameId)!;
    try {
      const name = pickPreviousArt(await filesWithPrefix(http, wiki, title), title);
      let image: string | null = null;
      if (name !== null) {
        image = (await thumbnails(http, wiki, [name])).get(name) ?? null;
        if (image === null) throw new Error(`нет миниатюры ${name}`);
      }
      art[key] = { image, checkedAt: now };
    } catch (error) {
      // У баннера со сбоем срок повтора обычный: иначе баннер, на котором вики вечно виснет, держал бы очередь.
      art[key] = { image: art[key]?.image ?? null, checkedAt: now };
      warnings.push(`${key}: ${(error as Error).message}`);
      if (isTransportError(error)) {
        warnings.push("поиск арта остановлен: вики не отвечает, остальные баннеры — в следующий прогон");
        break;
      }
    }
  }
  return warnings;
}

/** Баннерам без картинки — запомненный арт прошлого запуска. Ничего не подставилось — тот же объект. */
export function withArt(hub: HubData, art: ArtMemory): HubData {
  let changed = false;
  const banners = hub.banners.map((banner) => {
    const image = wantsArt(banner) ? art[artKey(banner)]?.image : undefined;
    if (!image) return banner;
    changed = true;
    return { ...banner, image };
  });
  return changed ? { ...hub, banners } : hub;
}
