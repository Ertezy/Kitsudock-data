// Ленты YouTube официальных каналов игр — английских и японских (спека
// этапа 6 §3.1). Канал сверяется по идентификатору. У Endfield английский
// канал — @ArknightsEndfieldEN: лента основного @ArknightsEndfield пуста.

import type { GameId, Video, VideoLang } from "../types.ts";
import { isPublicHttpsUrl, videoTitleOk, youtubeUrlOk } from "../validate.ts";

export const CHANNELS: Record<VideoLang, Record<GameId, string>> = {
  en: {
    genshin: "UCiS882YPwZt1NfaM0gR0D9Q",
    hsr: "UC2PeMPA8PAOp-bynLoCeMLA",
    zzz: "UC2SpC8rL9LaeQriE4YNdyzA",
    wuthering: "UC0Bi5KMcECRVYis5Gb_ZYZQ",
    endfield: "UCowPaVRBzg8CE6K4CB6LJfw",
  },
  ja: {
    genshin: "UCAVR6Q0YgYa8xwz8rdg9Mrg",
    hsr: "UCrzCIt5o0X88G9bCdrdbv6g",
    zzz: "UCt09C9DPSuOGpHoitbcyCIQ",
    wuthering: "UCGc93NguHRwzv1Rw9MyIcxQ",
    endfield: "UCGVCAOZvDH7_fmuRVxkusFQ",
  },
};

/** Столько роликов на каждом языке показывает панель приложения. */
export const VIDEOS_PER_GAME = 6;

export const feedUrl = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
const decode = (text: string) => text.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e] ?? e);
const pick = (block: string, re: RegExp) => re.exec(block)?.[1];

/**
 * Содержимое каждого `<entry>…</entry>`. Прежнее ленивое выражение для каждого
 * незакрытого `<entry>` заново читало текст до конца; здесь поиск идёт вперёд один раз,
 * а когда закрытия больше нет, его нет и ни у одного следующего начала.
 */
function entryBlocks(xml: string): string[] {
  const blocks: string[] = [];
  for (let open = xml.indexOf("<entry>"); open !== -1; ) {
    const from = open + "<entry>".length;
    const close = xml.indexOf("</entry>", from);
    if (close === -1) break;
    blocks.push(xml.slice(from, close));
    open = xml.indexOf("<entry>", close + "</entry>".length);
  }
  return blocks;
}

export function parseYoutubeFeed(
  xml: string,
  gameId: GameId,
  channelId: string,
  lang: VideoLang,
): { found: boolean; videos: Video[]; parsed: number; dropped: number } {
  if (!xml.includes("<feed")) return { found: false, videos: [], parsed: 0, dropped: 0 };
  const videos: Video[] = [];
  let parsed = 0;
  let dropped = 0;
  for (const block of entryBlocks(xml)) {
    parsed++;
    const channel = pick(block, /<yt:channelId>([^<]+)<\/yt:channelId>/);
    const url = pick(block, /<link rel="alternate" href="([^"]+)"/);
    const rawTitle = pick(block, /<title>([^<]*)<\/title>/);
    const title = rawTitle === undefined ? undefined : decode(rawTitle).trim();
    const publishedAt = Date.parse(pick(block, /<published>([^<]+)<\/published>/) ?? "") / 1000;
    const thumb = pick(block, /<media:thumbnail url="([^"]+)"/);
    // Название длиннее предела — не ролик, а выброшенная запись: проверка файла не должна падать из-за одного заголовка.
    if (channel !== channelId || !youtubeUrlOk(url) || title === undefined || !videoTitleOk(title) || !Number.isFinite(publishedAt)) {
      dropped++;
      continue;
    }
    videos.push({
      gameId,
      lang,
      title,
      url,
      thumb: isPublicHttpsUrl(thumb) ? thumb : null,
      publishedAt: Math.floor(publishedAt),
      duration: null,
      premiere: false,
    });
  }
  videos.sort((a, b) => b.publishedAt - a.publishedAt);
  return { found: true, videos: videos.slice(0, VIDEOS_PER_GAME), parsed, dropped };
}
