// Сборка файла: свежие записи там, где источник ответил, прошлые — где нет.

import { isLive } from "./items.ts";
import { VIDEOS_PER_GAME } from "./sources/videos.ts";
import { GAME_IDS, VIDEO_LANGS, type Banner, type Code, type GameId, type HubData, type HubGame, type Item, type Section, type SourceRun, type Video, type VideoLang } from "./types.ts";

export const sectionKey = (game: GameId, section: Section, lang?: VideoLang) =>
  lang === undefined ? `${game}:${section}` : `${game}:${section}:${lang}`;

export interface MergeInput {
  previous: HubData | null;
  catalog: HubGame[];
  runs: Map<string, SourceRun<Item>>;
  now: number;
}

/** Язык видео из прошлого файла: у записей без поля языка — английские. */
const langOf = (item: Item): VideoLang => (item as Partial<Video>).lang ?? "en";

function sectionItems(input: MergeInput, game: GameId, section: Section, lang?: VideoLang): Item[] {
  const run = input.runs.get(sectionKey(game, section, lang));
  const items: Item[] =
    run?.kind === "ok"
      ? run.items
      : ((input.previous?.[section] ?? []) as Item[]).filter(
          (item) => item.gameId === game && (lang === undefined || langOf(item) === lang),
        );
  return items.filter((item) => isLive(section, item, input.now));
}

export function mergeHub(input: MergeInput): HubData {
  const codes: Code[] = [];
  const banners: Banner[] = [];
  const videos: Video[] = [];
  for (const game of GAME_IDS) {
    const seen = new Set<string>();
    for (const code of sectionItems(input, game, "codes") as Code[]) {
      const key = code.code.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      codes.push(code);
    }
    banners.push(...(sectionItems(input, game, "banners") as Banner[]).sort((a, b) => a.startsAt - b.startsAt));
    for (const lang of VIDEO_LANGS) {
      videos.push(
        ...(sectionItems(input, game, "videos", lang) as Video[])
          .map((v) => ({ ...v, lang }))
          .sort((a, b) => b.publishedAt - a.publishedAt)
          .slice(0, VIDEOS_PER_GAME),
      );
    }
  }
  return { version: 2, updatedAt: input.now, games: input.catalog, codes, banners, videos };
}

/** Одинаковы ли данные, не считая времени сборки. */
export function sameData(a: HubData | null, b: HubData): boolean {
  if (a === null) return false;
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}
