// Типы файла хаба версии 2. Должны совпадать со схемой приложения
// (src-tauri/src/hub/schema.rs): приложение читает ровно эти поля.

export type GameId = "genshin" | "hsr" | "zzz" | "wuthering" | "endfield";

export const GAME_IDS: readonly GameId[] = ["genshin", "hsr", "zzz", "wuthering", "endfield"];

export type Section = "codes" | "banners" | "videos";

export interface Code {
  gameId: GameId;
  code: string;
  rewards: string;
  /** Unix-секунды; null — срок неизвестен или код бессрочный. */
  expiresAt: number | null;
  /**
   * Срок на странице был одной датой, без часа: `expiresAt` — оценка (конец дня по
   * серверу, который кончает сутки раньше всех). Лаунчер тогда показывает день, а не
   * часы и минуты. Нет поля — срок точный или его нет.
   */
  expiresDayOnly?: true;
  region: string;
  /** Страница, откуда взят код, — указание источника по лицензии. */
  source: string | null;
}

export interface Banner {
  gameId: GameId;
  title: string;
  featured: string[];
  rarity: number | null;
  /** Уменьшенная копия шириной 400 точек или null. */
  image: string | null;
  startsAt: number;
  endsAt: number;
  /** Страница вики с баннером. */
  url: string | null;
}

/** Языки видео: английский — основной, японский — по выбору в приложении. */
export type VideoLang = "en" | "ja";
export const VIDEO_LANGS: readonly VideoLang[] = ["en", "ja"];

export interface Video {
  gameId: GameId;
  lang: VideoLang;
  title: string;
  url: string;
  thumb: string | null;
  publishedAt: number;
  duration: null;
  premiere: false;
}

/** Текущий фон официального лаунчера игры: картинка и, если есть, видео. Только ссылки. */
export interface GameBackground {
  image: string;
  video?: string;
}

/** Тип записи в соцсетях игры; хост адреса обязан подходить к нему (sources/socials.ts). */
export type SocialKind = "hoyolab" | "site" | "youtube" | "x" | "discord" | "reddit" | "facebook" | "instagram" | "tiktok" | "telegram" | "vk";

/** Одна официальная страница игры. url хранится как есть, в том числе короткая ссылка hoyo.link. */
export interface Social {
  kind: SocialKind;
  url: string;
}

/** Официальные страницы игры по языкам, в порядке показа. Языка без списка нет совсем. */
export interface GameSocials {
  ru?: Social[];
  en?: Social[];
}

export interface HubGame {
  id: GameId;
  title: string;
  redeemUrl?: string;
  match: { steamAppIds: number[]; epicAppNames: string[]; folderNames: string[] };
  background?: GameBackground;
  socials?: GameSocials;
}

/** Последняя опубликованная версия приложения: номер без «v» и страница релиза. */
export interface AppRelease {
  version: string;
  url: string;
}

export interface HubData {
  version: 2;
  updatedAt: number;
  games: HubGame[];
  codes: Code[];
  banners: Banner[];
  videos: Video[];
  /** Есть, только когда опубликован хотя бы один релиз приложения. */
  app?: AppRelease;
}

export type Item = Code | Banner | Video;

/**
 * Итог одного источника за запуск. `skipped` — источник не спрашивали (час не настал или не хватило
 * времени прогона, тогда в `reason` причина): прошлые данные остаются, неудачей это не считается.
 * `broken` с `transport` — сбой связи, а не ответа (таймаут, обрыв): сайт не отвечает.
 */
export type SourceRun<T extends Item> =
  | { kind: "ok"; items: T[]; parsed: number; dropped: number }
  | { kind: "unchanged" }
  | { kind: "skipped"; reason?: string }
  | { kind: "broken"; error: string; transport?: true };
