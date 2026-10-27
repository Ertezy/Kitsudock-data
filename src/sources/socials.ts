// Официальные соцсети игр. Genshin Impact, Honkai: Star Rail и Zenless Zone Zero берутся из
// лаунчера HoYoPlay (список значков соцсетей в его окне), Wuthering Waves и Arknights: Endfield
// заданы вручную по их официальным сайтам. Хранятся только ссылки и их тип.

import type { Redirects } from "../http.ts";
import type { GameId, GameSocials, HubData, Social, SocialKind } from "../types.ts";
import { isPublicHttpsUrl } from "../validate.ts";

export const SOCIAL_KINDS: readonly SocialKind[] = ["hoyolab", "site", "youtube", "x", "discord", "reddit", "facebook", "instagram", "tiktok", "telegram", "vk"];
export const SOCIAL_LANGS = ["ru", "en"] as const;
/** Записей в одном списке не больше. */
export const SOCIALS_MAX = 10;
/** Самый длинный адрес записи. */
export const SOCIAL_URL_MAX = 512;

/** Короткие ссылки HoYoverse: подходят к любому kind, а тип узнаётся по адресу, куда они ведут. */
const SHORT_LINK_HOST = "hoyo.link";

/** Хосты, которые годятся для каждого kind. Чаты поддержки, магазины и прочие хосты сюда не попадают. */
const KIND_HOSTS: Record<SocialKind, readonly string[]> = {
  hoyolab: ["www.hoyolab.com", "hoyolab.com"],
  site: ["genshin.hoyoverse.com", "hsr.hoyoverse.com", "zenless.hoyoverse.com", "wutheringwaves.kurogames.com", "endfield.gryphline.com"],
  youtube: ["www.youtube.com", "youtube.com"],
  x: ["x.com", "twitter.com"],
  discord: ["discord.gg", "discord.com"],
  reddit: ["www.reddit.com"],
  facebook: ["www.facebook.com"],
  instagram: ["www.instagram.com"],
  tiktok: ["www.tiktok.com"],
  telegram: ["t.me"],
  vk: ["vk.com", "m.vk.com"],
};

const KIND_BY_HOST = new Map<string, SocialKind>(SOCIAL_KINDS.flatMap((kind) => KIND_HOSTS[kind].map((host) => [host, kind] as const)));

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
};

/** Тип записи по хосту адреса; хост не из списка (в том числе hoyo.link) — null. */
export function kindOfUrl(url: string): SocialKind | null {
  const host = hostOf(url);
  return host === null ? null : (KIND_BY_HOST.get(host) ?? null);
}

/** Запись годится: простой публичный https-адрес до предела длины, хост подходит к kind (или это hoyo.link). */
function socialOk(kind: unknown, url: unknown): boolean {
  if (typeof kind !== "string" || !(SOCIAL_KINDS as readonly string[]).includes(kind)) return false;
  if (!isPublicHttpsUrl(url) || url.length > SOCIAL_URL_MAX) return false;
  const host = hostOf(url);
  return host !== null && (host === SHORT_LINK_HOST || KIND_HOSTS[kind as SocialKind].includes(host));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Первая найденная беда в поле `socials` игры или null. Текст начинается с пути внутри поля
 * (`.ru[2].url`) или с двоеточия, если беда в самом поле. Читает всё, что угодно: файл мог прийти из памяти прошлых запусков.
 */
export function socialsProblem(value: unknown): string | null {
  if (!isRecord(value)) return ": объект со списками ru и en";
  const keys = Object.keys(value);
  if (keys.length === 0) return ": нет ни одного списка, поля быть не должно";
  for (const key of keys) {
    if (!(SOCIAL_LANGS as readonly string[]).includes(key)) return `.${key}: языки только ru и en`;
    const list = value[key];
    if (!Array.isArray(list) || list.length === 0) return `.${key}: непустой список (нет записей — нет и ключа)`;
    if (list.length > SOCIALS_MAX) return `.${key}: ${list.length} записей, больше ${SOCIALS_MAX}`;
    const seen = new Set<string>();
    for (const [i, entry] of list.entries()) {
      const at = `.${key}[${i}]`;
      if (!isRecord(entry)) return `${at}: запись { kind, url }`;
      if (!socialOk(entry.kind, entry.url)) return `${at}: kind из списка контракта и обычный https-адрес до ${SOCIAL_URL_MAX} знаков с подходящим хостом`;
      if (seen.has(entry.url as string)) return `${at}.url: повтор адреса`;
      seen.add(entry.url as string);
    }
  }
  return null;
}

/**
 * Адреса значков соцсетей из ответа getGameContent в порядке окна лаунчера: у записи со ссылкой — icon.link,
 * у записи без неё («хаб» HoYoLAB со списком) — первая из links[]. Пустые записи, мусор и негодные адреса
 * пропускаются. Ответ не той формы — null.
 */
export function parseSocialLinks(json: unknown): string[] | null {
  if (!isRecord(json) || json.retcode !== 0 || !isRecord(json.data) || !isRecord(json.data.content)) return null;
  const list = json.data.content.social_media_list;
  if (!Array.isArray(list)) return null;
  const urls: string[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const icon = isRecord(entry.icon) ? entry.icon.link : undefined;
    let link: unknown = typeof icon === "string" && icon !== "" ? icon : undefined;
    if (link === undefined && Array.isArray(entry.links)) {
      const first: unknown = entry.links[0];
      link = isRecord(first) ? first.link : undefined;
    }
    if (isPublicHttpsUrl(link) && link.length <= SOCIAL_URL_MAX) urls.push(link);
  }
  return urls;
}

/**
 * Тип каждого адреса: по хосту, а у короткой ссылки hoyo.link — по хосту того, куда она ведёт (один запрос
 * без перехода). Хост не из контракта (WhatsApp, Messenger, новая соцсеть) — запись пропускается. В записи остаётся
 * исходный адрес. Повторы убираются, записей не больше SOCIALS_MAX, и за лишними ссылками сверх этого не ходим.
 * Сбой запроса уходит наверх: остаток списка тогда не спрашивается.
 */
export async function classifySocials(redirects: Redirects, urls: readonly string[]): Promise<Social[]> {
  const list: Social[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (list.length >= SOCIALS_MAX) break;
    if (seen.has(url)) continue;
    seen.add(url);
    let kind: SocialKind | null;
    if (hostOf(url) === SHORT_LINK_HOST) {
      const target = await redirects.location(url);
      kind = target === null ? null : kindOfUrl(resolveTarget(target, url));
    } else {
      kind = kindOfUrl(url);
    }
    if (kind !== null && socialOk(kind, url)) list.push({ kind, url });
  }
  return list;
}

/** Адрес из Location: он может быть и относительным; негодный разбору — пустая строка (kind по нему не узнать). */
function resolveTarget(target: string, base: string): string {
  try {
    return new URL(target, base).href;
  } catch {
    return "";
  }
}

// Wuthering Waves и Arknights: Endfield в лаунчере HoYoPlay нет. Списки взяты с их официальных сайтов
// (wutheringwaves.kurogames.com, endfield.gryphline.com) и проверены вручную; чаты поддержки
// и платформу skport не берём. У Wuthering Waves русской версии сайта нет — один список на оба языка.
export const MANUAL_SOCIALS: Record<"wuthering" | "endfield", GameSocials> = {
  wuthering: {
    ru: [
      { kind: "x", url: "https://twitter.com/Wuthering_Waves" },
      { kind: "facebook", url: "https://www.facebook.com/WutheringWaves.Official" },
      { kind: "youtube", url: "https://www.youtube.com/@WutheringWaves" },
      { kind: "discord", url: "https://discord.com/invite/wutheringwaves" },
      { kind: "reddit", url: "https://www.reddit.com/r/WutheringWaves/" },
      { kind: "instagram", url: "https://www.instagram.com/wuthering_waves/" },
      { kind: "tiktok", url: "https://www.tiktok.com/@wutheringwaves_official" },
    ],
    en: [
      { kind: "x", url: "https://twitter.com/Wuthering_Waves" },
      { kind: "facebook", url: "https://www.facebook.com/WutheringWaves.Official" },
      { kind: "youtube", url: "https://www.youtube.com/@WutheringWaves" },
      { kind: "discord", url: "https://discord.com/invite/wutheringwaves" },
      { kind: "reddit", url: "https://www.reddit.com/r/WutheringWaves/" },
      { kind: "instagram", url: "https://www.instagram.com/wuthering_waves/" },
      { kind: "tiktok", url: "https://www.tiktok.com/@wutheringwaves_official" },
    ],
  },
  endfield: {
    ru: [
      { kind: "vk", url: "https://vk.com/akendfieldru" },
      { kind: "telegram", url: "https://t.me/AKEndfieldRU" },
      { kind: "discord", url: "https://discord.gg/akendfield" },
    ],
    en: [
      { kind: "x", url: "https://twitter.com/AKEndfield" },
      { kind: "tiktok", url: "https://www.tiktok.com/@akendfielden" },
      { kind: "facebook", url: "https://www.facebook.com/ArknightsEndfield" },
      { kind: "youtube", url: "https://www.youtube.com/channel/UCowPaVRBzg8CE6K4CB6LJfw" },
      { kind: "discord", url: "https://discord.gg/akendfield" },
      { kind: "instagram", url: "https://www.instagram.com/akendfieldofficial/" },
    ],
  },
};

/** Запомненные соцсети игр HoYoPlay (у остальных списки заданы вручную выше). */
export type SocialsMemory = Partial<Record<GameId, GameSocials>>;

/**
 * Ставит играм файла соцсети: играм HoYoPlay — из памяти, остальным — ручной список. Нечего ставить —
 * тот же объект. Язык без записей поля не получает.
 */
export function withSocials(hub: HubData, memory: SocialsMemory): HubData {
  let changed = false;
  const games = hub.games.map((game) => {
    const found: GameSocials | undefined = memory[game.id] ?? (game.id === "wuthering" || game.id === "endfield" ? MANUAL_SOCIALS[game.id] : undefined);
    if (found === undefined) return game;
    const socials: GameSocials = {};
    if (found.ru !== undefined && found.ru.length > 0) socials.ru = found.ru.map((s) => ({ ...s }));
    if (found.en !== undefined && found.en.length > 0) socials.en = found.en.map((s) => ({ ...s }));
    if (socials.ru === undefined && socials.en === undefined) return game;
    changed = true;
    return { ...game, socials };
  });
  return changed ? { ...hub, games } : hub;
}
