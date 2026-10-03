// Фоны официального лаунчера HoYoPlay для Genshin Impact, Honkai: Star Rail и Zenless
// Zone Zero (спека приложения docs/specs/2026-10-02-launcher-backgrounds-design.md, §2).
// Берутся только ссылки на текущий фон: картинку и, если есть, видео. Ни картинки,
// ни видео нигде не хранятся.

import type { Http } from "../http.ts";
import type { GameBackground, GameId, HubData } from "../types.ts";
import { isPublicHttpsUrl } from "../validate.ts";
import type { SourceMemory } from "./registry.ts";

export const HOYOPLAY_URL =
  "https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api/getAllGameBasicInfo?launcher_id=VYTpXlbWo8&language=en-us";

export const LAUNCHER_ART = { id: "hoyoplay-art", label: "фоны официального лаунчера HoYoPlay", everyHours: 6 } as const;

/** Игры HoYoPlay по их коду в лаунчере. */
const BIZ: Record<string, GameId> = { hk4e_global: "genshin", hkrpg_global: "hsr", nap_global: "zzz" };

const IMAGE_FILE = /^https:\/\/[^?#\s]+\.(?:webp|png|jpe?g)$/i;
const VIDEO_FILE = /^https:\/\/[^?#\s]+\.(?:webm|mp4)$/i;

// Одной формы мало: «https://логин@хост:порт/a.webp» её проходит. Поэтому сначала общая
// проверка адреса (валидация файла делает то же), и только потом расширение.
/** Простой публичный https-адрес картинки webp, png или jpg. */
export const isImageUrl = (value: unknown): value is string => isPublicHttpsUrl(value) && IMAGE_FILE.test(value);
/** Простой публичный https-адрес видео webm или mp4. */
export const isVideoUrl = (value: unknown): value is string => isPublicHttpsUrl(value) && VIDEO_FILE.test(value);

const urlOf = (value: unknown): string | null => {
  const url = typeof value === "object" && value !== null ? (value as { url?: unknown }).url : undefined;
  return typeof url === "string" ? url : null;
};

/**
 * Первый фон каждой из трёх игр из ответа HoYoPlay. Картинка не годится — у игры
 * фона нет; видео не годится или фон не видео — остаётся одна картинка.
 * Ответ не той формы — null.
 */
export function parseHoyoplayArt(json: unknown): Partial<Record<GameId, GameBackground>> | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const { retcode, data } = json as { retcode?: unknown; data?: { game_info_list?: unknown } };
  const list = data?.game_info_list;
  if (retcode !== 0 || !Array.isArray(list)) return null;
  const result: Partial<Record<GameId, GameBackground>> = {};
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const biz = (entry as { game?: { biz?: unknown } | null }).game?.biz;
    if (typeof biz !== "string" || !Object.hasOwn(BIZ, biz)) continue;
    const backgrounds = (entry as { backgrounds?: unknown }).backgrounds;
    if (!Array.isArray(backgrounds) || backgrounds.length === 0) continue;
    const first = backgrounds[0] as { type?: unknown; background?: unknown; video?: unknown } | null;
    const image = urlOf(first?.background);
    if (!isImageUrl(image)) continue;
    const video = first?.type === "BACKGROUND_TYPE_VIDEO" ? urlOf(first.video) : null;
    result[BIZ[biz]!] = isVideoUrl(video) ? { image, video } : { image };
  }
  return result;
}

/**
 * Обновляет memory.launcherArt. 304 — без изменений. Сбой, ответ не той формы или
 * ни одной из трёх игр — ошибка источника, прошлые фоны остаются.
 */
export async function fetchLauncherArt(http: Http, memory: SourceMemory): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await http.get(HOYOPLAY_URL, memory.validators[HOYOPLAY_URL] ?? {});
    if (res.status === 304) return { ok: true };
    const art = parseHoyoplayArt(JSON.parse(res.body));
    if (art === null) return { ok: false, error: "ответ HoYoPlay не той формы" };
    if (Object.keys(art).length === 0) return { ok: false, error: "в ответе HoYoPlay нет ни одной из трёх игр" };
    memory.launcherArt = art;
    memory.validators[HOYOPLAY_URL] = res.validators;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Ставит запомненные фоны играм файла. Ставить нечего — тот же объект. */
export function withLauncherArt(hub: HubData, art: Partial<Record<GameId, GameBackground>>): HubData {
  let changed = false;
  const games = hub.games.map((game) => {
    const background = art[game.id];
    if (background === undefined) return game;
    changed = true;
    return { ...game, background };
  });
  return changed ? { ...hub, games } : hub;
}
