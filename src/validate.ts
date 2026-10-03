// Последний рубеж перед выкладкой: файл проверяется по тем же правилам, что
// соблюдает приложение. Не прошёл — в сети остаётся прошлый рабочий файл.

import { VERSION } from "./sources/appRelease.ts";
import { CODE_PATTERN } from "./sources/codes.ts";
import { isImageUrl, isVideoUrl } from "./sources/launcherArt.ts";
import { VIDEOS_PER_GAME } from "./sources/videos.ts";
import { GAME_IDS, VIDEO_LANGS, type HubData } from "./types.ts";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const MAX_ERRORS = 50;

// Пределы длины, общие для парсеров и этой проверки: единственный источник чисел
// (спека §5.1). Парсеры отбраковывают запись сверх предела сами — validateHub
// остаётся последним утверждением и в нормальной работе срабатывать не должен.
export const REWARDS_MAX = 300;
export const BANNER_TITLE_MAX = 200;
export const FEATURED_MAX = 10;
export const FEATURED_NAME_MAX = 80;
export const VIDEO_TITLE_MAX = 300;
// Пределы на игру: сколько записей один источник отдаёт за запуск. Больше кодов — это не
// «кодов прибавилось», а испорченная страница или сломанный источник (см. judge); лишние
// баннеры (самые старые) отбрасываются: так одна страница не плодит запросы миниатюр.
export const MAX_CODES_PER_GAME = 200;
export const MAX_BANNERS_PER_GAME = 50;
// Предел на запуск: сколько статей Kuro читается за раз; остальные подождут следующего запуска.
export const MAX_KURO_ARTICLES_PER_RUN = 30;
// Из одной статьи Kuro берутся первые баннеры не больше этого числа: в анонсе их единицы, а больше —
// это не анонс, а испорченная или подложенная страница.
export const MAX_KURO_BANNERS_PER_ARTICLE = 10;
// Сколько баннеров без картинки за прогон проверяется на арт прошлого запуска; остальные ждут следующего прогона.
export const MAX_ART_LOOKUPS_PER_RUN = 20;
// Бюджет времени, мс: чтение статей Kuro и поиск арта по отдельности. Вышло время — остаток в следующий прогон,
// а прогон укладывается в свой лимит и успевает сохранить состояние.
export const KURO_ARTICLES_BUDGET_MS = 120_000;
export const ART_BUDGET_MS = 120_000;

// Текст в файле — корректный UTF-16, без одиноких половин суррогатной пары. JSON.stringify пишет
// такую половину как «\ud800», а читатель файла в приложении (serde_json) её отвергает, и весь файл
// не читается. Источники такие знаки приносят (JSON с «\ud800», числовые сущности), поэтому
// проверка стоит во всех общих проверках текста, а запись с ней парсер выбрасывает.

/** Награда кода умещается в предел длины и без одиноких суррогатов. */
export function rewardsFits(rewards: string): boolean {
  return rewards.length <= REWARDS_MAX && rewards.isWellFormed();
}

// Одна проверка на вид записи — и у парсеров, и у validateHub. Запись, не прошедшую
// её, парсер выбрасывает сам, а не отдаёт на проверку всего файла.

/** Название баннера: не пустое (одни пробелы — пусто), не длиннее предела, без одиноких суррогатов. */
export const bannerTitleOk = (title: string): boolean => title.trim() !== "" && title.length <= BANNER_TITLE_MAX && title.isWellFormed();

/** Имя в списке персонажей: не пустое (одни пробелы — пусто), не длиннее предела, без одиноких суррогатов. */
export const featuredNameOk = (name: string): boolean => name.trim() !== "" && name.length <= FEATURED_NAME_MAX && name.isWellFormed();

/** Список персонажей баннера: не больше FEATURED_MAX имён, каждое проходит featuredNameOk. */
export const featuredListOk = (featured: string[]): boolean => featured.length <= FEATURED_MAX && featured.every(featuredNameOk);

/** Название ролика: до предела длины (пустое допустимо), без одиноких суррогатов. */
export const videoTitleOk = (title: string): boolean => title.length <= VIDEO_TITLE_MAX && title.isWellFormed();

/** Код: латинские буквы и цифры, 4–40 знаков. */
export const codeOk = (code: string): boolean => CODE_PATTERN.test(code);

// Ссылки. Приложение и сборщик кладут их в разметку и в запросы как есть, поэтому годится
// только простой публичный https-адрес: без логина, порта и IP-адреса вместо имени.

/** Самый длинный адрес, который принимает файл. */
export const URL_MAX = 2048;
/** Страницы релизов приложения: только они годятся для app.url. */
export const APP_URL_PREFIX = "https://github.com/Ertezy/Kitsudock/releases/";

// Пробелы всех видов, управляющие знаки (Cc), невидимые форматирующие (Cf: нулевой пробел,
// переключатели направления текста), одинокие суррогаты (Cs: в файле они записались бы как «\ud800»)
// и обратная косая черта (\x5c): разбор адреса читает её как «/», и адрес с ней у разных читателей
// получает разных хозяев. Целая суррогатная пара — один знак, не Cs, и не мешает.
const URL_FORBIDDEN = /[\s\p{Cc}\p{Cf}\p{Cs}\x5c]/u;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Имя из непустых меток через точку: хотя бы одна точка, ни точки на конце, ни пустой метки.
// Так не проходят «localhost», «hsr», «localhost.» и «e..org».
const DOTTED_HOST = /^[^.]+(?:\.[^.]+)+$/;
// Имена особого назначения: .localhost, .local, .internal и .home.arpa (вместе с самим home.arpa) ведут не в
// интернет, а на машину читателя или в его домашнюю сеть, и в файле для всех им не место. Одиночные «localhost»
// и «local» уже не проходят как имя без точки. Проверяется разобранное имя: оно уже строчное и без точки на конце.
const SPECIAL_USE_HOST = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/;
// Сегмент пути «.» или «..» — и в записи %2e любого регистра: разбор такие сегменты сворачивает,
// и адрес приходит не туда, куда читается в строке.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Простой публичный https-адрес: строка начинается с «https://», не длиннее URL_MAX,
 * без пробелов и управляющих знаков, без логина и порта (явного тоже: «:443» разбор прячет),
 * без сегментов пути «.» и «..», хост — имя с точкой (сразу после «https://», без лишних «/»), а не IPv4, не IPv6 и не имя
 * особого назначения (.localhost, .local, .internal, .home.arpa). Разбор приводит
 * «2130706433», «0x7f.1» и «127.1» к 127.0.0.1, поэтому IPv4 ищется в уже разобранном имени.
 */
export function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > URL_MAX || !value.startsWith("https://")) return false;
  if (URL_FORBIDDEN.test(value)) return false;
  // Хост стоит сразу после «https://». Начало с косой черты — пустое: разбор по WHATWG берёт
  // хост из пути («https:///example.org/x» → example.org), а строгий читатель видит пустой.
  if (value.startsWith("/", "https://".length)) return false;
  // Начало до первой «/», «?» или «#»: «@» и «:» здесь — логин или порт, в пути и запросе они обычны.
  const authority = value.slice("https://".length).split(/[/?#]/, 1)[0]!;
  if (authority.includes("@") || authority.includes(":")) return false;
  // Путь — от конца начала до «?» или «#»: «..» в запросе и якоре ничего не сворачивает.
  const path = value.slice("https://".length + authority.length).split(/[?#]/, 1)[0]!;
  if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
  return !url.hostname.startsWith("[") && !IPV4_HOST.test(url.hostname) && DOTTED_HOST.test(url.hostname) && !SPECIAL_USE_HOST.test(url.hostname);
}

/**
 * Ссылка на ролик: простой https-адрес на www.youtube.com. Строка должна совпасть с тем, что
 * из неё разберёт читатель (разбор, например, кодирует «"» в «%22»): в файле лежит то, что откроется.
 */
export const youtubeUrlOk = (url: unknown): url is string =>
  isPublicHttpsUrl(url) && url.startsWith("https://www.youtube.com/") && new URL(url).href === url;

/**
 * Страница релиза приложения: простой https-адрес из APP_URL_PREFIX. Префикс проверяется и в строке,
 * и в разобранном виде, чтобы запись вида «releases/..» не уводила на чужой путь на github.com.
 */
export const appUrlOk = (url: unknown): url is string =>
  isPublicHttpsUrl(url) && url.startsWith(APP_URL_PREFIX) && new URL(url).href.startsWith(APP_URL_PREFIX);

/** Название баннера и список персонажей проходят свои проверки и умещаются в пределы. */
export function bannerFits(title: string, featured: string[]): boolean {
  return bannerTitleOk(title) && featuredListOk(featured);
}

// Безопасное целое: читатель файла (serde_json) помещает время в i64, а 1e300 или 2**60 — «целые» только для double.
const isInt = (value: unknown) => Number.isSafeInteger(value);
const urlOrNull = (value: unknown) => value === null || isPublicHttpsUrl(value);
const text = (value: unknown, min: number, max: number) =>
  typeof value === "string" && value.length >= min && value.length <= max && value.isWellFormed();

export function validateHub(hub: HubData, maxBytes = MAX_FILE_BYTES): string[] {
  const errors: string[] = [];
  const fail = (message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };

  if (hub.version !== 2) fail("version: должна быть 2");
  if (!isInt(hub.updatedAt) || hub.updatedAt <= 0) fail("updatedAt: целое число секунд");

  const gameIds = new Set<string>();
  hub.games.forEach((g, i) => {
    if (!(GAME_IDS as readonly string[]).includes(g.id) || gameIds.has(g.id)) fail(`games[${i}].id: неизвестная или повторная игра ${g.id}`);
    gameIds.add(g.id);
    if (!text(g.title, 1, 100)) fail(`games[${i}].title: 1–100 знаков`);
    if (!(g.redeemUrl === undefined || (isPublicHttpsUrl(g.redeemUrl) && g.redeemUrl.includes("{code}")))) {
      fail(`games[${i}].redeemUrl: обычный https-адрес с {code}`);
    }
    if (g.background !== undefined) {
      if (!isImageUrl(g.background.image)) fail(`games[${i}].background.image: обычный https-адрес картинки webp, png или jpg`);
      if (!(g.background.video === undefined || isVideoUrl(g.background.video))) {
        fail(`games[${i}].background.video: обычный https-адрес видео webm или mp4`);
      }
    }
  });
  const knownGame = (id: string) => gameIds.has(id);

  hub.codes.forEach((c, i) => {
    const at = `codes[${i}]`;
    if (!knownGame(c.gameId)) fail(`${at}.gameId: игры ${c.gameId} нет в файле`);
    if (!(typeof c.code === "string" && codeOk(c.code))) fail(`${at}.code: латинские буквы и цифры, 4–40 знаков`);
    if (!text(c.rewards, 0, REWARDS_MAX)) fail(`${at}.rewards: до 300 знаков`);
    if (c.expiresAt !== null && !isInt(c.expiresAt)) fail(`${at}.expiresAt: целое или null`);
    if (!text(c.region, 1, 16)) fail(`${at}.region: 1–16 знаков`);
    if (!urlOrNull(c.source)) fail(`${at}.source: обычный https-адрес или null`);
  });

  hub.banners.forEach((b, i) => {
    const at = `banners[${i}]`;
    if (!knownGame(b.gameId)) fail(`${at}.gameId: игры ${b.gameId} нет в файле`);
    if (!(typeof b.title === "string" && bannerTitleOk(b.title))) fail(`${at}.title: 1–200 знаков`);
    if (!Array.isArray(b.featured) || !b.featured.every((f) => typeof f === "string") || !featuredListOk(b.featured)) {
      fail(`${at}.featured: до 10 имён по 80 знаков`);
    }
    if (b.rarity !== null && !(isInt(b.rarity) && b.rarity >= 1 && b.rarity <= 6)) fail(`${at}.rarity: 1–6 или null`);
    if (!urlOrNull(b.image)) fail(`${at}.image: обычный https-адрес или null`);
    if (!urlOrNull(b.url)) fail(`${at}.url: обычный https-адрес или null`);
    if (!isInt(b.startsAt)) fail(`${at}.startsAt: целое`);
    if (!isInt(b.endsAt) || b.endsAt <= b.startsAt) fail(`${at}.endsAt: целое и позже начала`);
  });

  const perGameLang = new Map<string, number>();
  hub.videos.forEach((v, i) => {
    const at = `videos[${i}]`;
    if (!knownGame(v.gameId)) fail(`${at}.gameId: игры ${v.gameId} нет в файле`);
    if (!VIDEO_LANGS.includes(v.lang)) fail(`${at}.lang: en или ja`);
    if (!(typeof v.title === "string" && videoTitleOk(v.title))) fail(`${at}.title: до 300 знаков`);
    if (!youtubeUrlOk(v.url)) fail(`${at}.url: только обычный адрес https://www.youtube.com/`);
    if (!urlOrNull(v.thumb)) fail(`${at}.thumb: обычный https-адрес или null`);
    if (!isInt(v.publishedAt)) fail(`${at}.publishedAt: целое`);
    const key = `${v.gameId}:${v.lang}`;
    perGameLang.set(key, (perGameLang.get(key) ?? 0) + 1);
  });
  for (const [key, count] of perGameLang) {
    if (count > VIDEOS_PER_GAME) fail(`videos: у ${key} ${count} роликов, больше ${VIDEOS_PER_GAME}`);
  }

  if (hub.app !== undefined) {
    if (!(typeof hub.app.version === "string" && VERSION.test(hub.app.version))) fail("app.version: три числа через точку");
    if (!appUrlOk(hub.app.url)) fail(`app.url: только страница релизов ${APP_URL_PREFIX}`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(hub), "utf8");
  if (bytes > maxBytes) fail(`файл: ${bytes} байт, больше потолка ${maxBytes}`);

  return errors;
}
