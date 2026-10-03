// Файл правок владельца (спека §5.4): добавить код или баннер, скрыть ошибочную запись.

import { atOffset, parseIsoLike, parseOffset } from "./time.ts";
import { GAME_IDS, type Banner, type Code, type GameId, type HubData } from "./types.ts";
import { bannerTitleOk, codeOk, featuredListOk, isPublicHttpsUrl, rewardsFits } from "./validate.ts";

export interface CodeOverride {
  game: GameId;
  code: string;
  rewards?: string;
  expires?: string;
}

export interface BannerOverride {
  game: GameId;
  title: string;
  featured?: string[];
  starts: string;
  ends: string;
  image?: string;
  url?: string;
}

export type HideRule = { game: GameId; code: string } | { game: GameId; banner: string };

export interface Overrides {
  codes: CodeOverride[];
  banners: BannerOverride[];
  hide: HideRule[];
}

/** «2026-10-01 23:59 UTC+8» → unix-секунды; без пояса или с ошибкой — null. */
export function parseMoment(text: string): number | null {
  const m = /^\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s+((?:UTC|GMT)\S*)\s*$/.exec(text);
  if (!m) return null;
  const parts = parseIsoLike(m[1]!);
  const offset = m[2] === "UTC" || m[2] === "GMT" ? 0 : parseOffset(m[2]!);
  return parts && offset !== null ? atOffset(parts, offset) : null;
}

const isGame = (value: unknown): value is GameId => typeof value === "string" && (GAME_IDS as readonly string[]).includes(value);
type Entry = Record<string, unknown>;
const entries = (value: unknown): Entry[] => (Array.isArray(value) ? (value as Entry[]) : []);

export function parseOverrides(json: unknown): { ok: true; overrides: Overrides } | { ok: false; errors: string[] } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, errors: ["файл правок должен быть объектом с полями codes, banners, hide"] };
  }
  const root = json as Entry;
  const errors: string[] = [];
  const overrides: Overrides = { codes: [], banners: [], hide: [] };

  if (root.codes !== undefined && !Array.isArray(root.codes)) {
    errors.push("codes: должно быть списком");
  }
  entries(root.codes).forEach((e, i) => {
    const at = `codes[${i}]`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) return void errors.push(`${at}: запись должна быть объектом`);
    if (!isGame(e.game)) return void errors.push(`${at}: неизвестная игра ${JSON.stringify(e.game)}`);
    // Проверки записей те же, что у validateHub (validate.ts): то, что он отверг бы, check-overrides отвергает сразу.
    if (typeof e.code !== "string" || !codeOk(e.code)) return void errors.push(`${at}: код только из латинских букв и цифр, 4–40 знаков`);
    if (e.rewards !== undefined && (typeof e.rewards !== "string" || !rewardsFits(e.rewards))) return void errors.push(`${at}: награда — строка до 300 знаков`);
    if (e.expires !== undefined && (typeof e.expires !== "string" || parseMoment(e.expires) === null)) {
      return void errors.push(`${at}: срок в виде «2026-10-01 23:59 UTC+8»`);
    }
    overrides.codes.push({ game: e.game, code: e.code, rewards: e.rewards as string | undefined, expires: e.expires as string | undefined });
  });

  if (root.banners !== undefined && !Array.isArray(root.banners)) {
    errors.push("banners: должно быть списком");
  }
  entries(root.banners).forEach((e, i) => {
    const at = `banners[${i}]`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) return void errors.push(`${at}: запись должна быть объектом`);
    if (!isGame(e.game)) return void errors.push(`${at}: неизвестная игра ${JSON.stringify(e.game)}`);
    // Название хранится обрезанным по краям, поэтому и проверяется обрезанным.
    if (typeof e.title !== "string" || !bannerTitleOk(e.title.trim())) return void errors.push(`${at}: нужно название до 200 знаков`);
    const starts = typeof e.starts === "string" ? parseMoment(e.starts) : null;
    const ends = typeof e.ends === "string" ? parseMoment(e.ends) : null;
    if (starts === null || ends === null) return void errors.push(`${at}: начало и конец в виде «2026-09-10 10:00 UTC+1»`);
    if (starts >= ends) return void errors.push(`${at}: конец раньше начала`);
    if (e.featured !== undefined && !(Array.isArray(e.featured) && e.featured.every((f) => typeof f === "string"))) {
      return void errors.push(`${at}: featured — список имён`);
    }
    if (e.featured !== undefined && !featuredListOk(e.featured as string[])) {
      return void errors.push(`${at}: featured — до 10 имён по 80 знаков, без пустых`);
    }
    if ((e.image !== undefined && !isPublicHttpsUrl(e.image)) || (e.url !== undefined && !isPublicHttpsUrl(e.url))) {
      return void errors.push(`${at}: image и url — обычные https-адреса (без логина, порта и IP-адреса, до 2048 знаков)`);
    }
    overrides.banners.push({
      game: e.game,
      title: e.title.trim(),
      featured: e.featured as string[] | undefined,
      starts: e.starts as string,
      ends: e.ends as string,
      image: e.image as string | undefined,
      url: e.url as string | undefined,
    });
  });

  if (root.hide !== undefined && !Array.isArray(root.hide)) {
    errors.push("hide: должно быть списком");
  }
  entries(root.hide).forEach((e, i) => {
    const at = `hide[${i}]`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) return void errors.push(`${at}: запись должна быть объектом`);
    if (!isGame(e.game)) return void errors.push(`${at}: неизвестная игра ${JSON.stringify(e.game)}`);
    const hasCode = typeof e.code === "string";
    const hasBanner = typeof e.banner === "string";
    if (hasCode === hasBanner) return void errors.push(`${at}: укажите ровно одно — code или banner`);
    overrides.hide.push(hasCode ? { game: e.game, code: e.code as string } : { game: e.game, banner: e.banner as string });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, overrides };
}

/** Начала баннеров игры, вписанных в файл правок (в unix-секундах). */
export const bannerStarts = (overrides: Overrides, game: GameId): number[] =>
  overrides.banners.flatMap((o) => {
    const starts = o.game === game ? parseMoment(o.starts) : null;
    return starts === null ? [] : [starts];
  });

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function applyOverrides(hub: HubData, overrides: Overrides, now: number): HubData {
  const hiddenCode = (game: GameId, code: string) =>
    overrides.hide.some((h) => h.game === game && "code" in h && same(h.code, code));
  const hiddenBanner = (game: GameId, title: string) =>
    overrides.hide.some((h) => h.game === game && "banner" in h && same(h.banner, title));

  const codes: Code[] = hub.codes.filter((c) => !hiddenCode(c.gameId, c.code)).map((c) => ({ ...c }));
  for (const o of overrides.codes) {
    if (hiddenCode(o.game, o.code)) continue;
    const expiresAt = o.expires === undefined ? null : parseMoment(o.expires);
    if (expiresAt !== null && expiresAt <= now) continue;
    const existing = codes.find((c) => c.gameId === o.game && same(c.code, o.code));
    if (existing) {
      if (o.rewards !== undefined) existing.rewards = o.rewards;
      existing.expiresAt = expiresAt;
    } else {
      codes.push({ gameId: o.game, code: o.code, rewards: o.rewards ?? "", expiresAt, region: "all", source: null });
    }
  }

  const banners: Banner[] = hub.banners.filter((b) => !hiddenBanner(b.gameId, b.title));
  for (const o of overrides.banners) {
    if (hiddenBanner(o.game, o.title) || banners.some((b) => b.gameId === o.game && same(b.title, o.title))) continue;
    const startsAt = parseMoment(o.starts);
    const endsAt = parseMoment(o.ends);
    if (startsAt === null || endsAt === null || endsAt <= now) continue;
    banners.push({
      gameId: o.game,
      title: o.title,
      featured: o.featured ?? [],
      rarity: o.game === "endfield" ? 6 : 5,
      image: o.image ?? null,
      startsAt,
      endsAt,
      url: o.url ?? null,
    });
  }
  banners.sort((a, b) => GAME_IDS.indexOf(a.gameId) - GAME_IDS.indexOf(b.gameId) || a.startsAt - b.startsAt);

  return { ...hub, codes, banners };
}
