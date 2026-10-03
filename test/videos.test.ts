import { test } from "node:test";
import assert from "node:assert/strict";
import { GAME_IDS, VIDEO_LANGS, type HubData } from "../src/types.ts";
import { validateHub } from "../src/validate.ts";
import { CHANNELS, feedUrl, parseYoutubeFeed } from "../src/sources/videos.ts";
import { runBounded } from "./bounded.ts";

const entry = (id: string, published: string, title: string, channel = CHANNELS.en.endfield) => `
 <entry>
  <id>yt:video:${id}</id>
  <yt:videoId>${id}</yt:videoId>
  <yt:channelId>${channel}</yt:channelId>
  <title>${title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
  <published>${published}</published>
  <media:group>
   <media:thumbnail url="https://i1.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/>
  </media:group>
 </entry>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>owPaVRBzg8CE6K4CB6LJfw</yt:channelId>
 <title>Arknights: Endfield</title>
${entry("DgWvnA2NCm0", "2026-09-15T09:00:33+00:00", "Collab &amp; recap")}
${entry("o3jqcYXVGZM", "2026-09-12T10:00:13+00:00", "Short")}
${entry("aaaaaaaaaaa", "not a date", "Broken")}
${entry("bbbbbbbbbbb", "2026-09-14T10:00:00+00:00", "Other channel", "UCxxxxxxxxxxxxxxxxxxxxxx")}
</feed>`;

test("десять каналов: у каждой игры английский и японский, все разные", () => {
  const all = VIDEO_LANGS.flatMap((lang) => GAME_IDS.map((game) => CHANNELS[lang][game]));
  assert.equal(all.length, 10);
  assert.equal(new Set(all).size, 10);
  for (const id of all) assert.match(id, /^UC[A-Za-z0-9_-]{22}$/);
});

test("адрес ленты", () => {
  assert.equal(feedUrl(CHANNELS.en.genshin), "https://www.youtube.com/feeds/videos.xml?channel_id=UCiS882YPwZt1NfaM0gR0D9Q");
  assert.equal(feedUrl(CHANNELS.ja.genshin), "https://www.youtube.com/feeds/videos.xml?channel_id=UCAVR6Q0YgYa8xwz8rdg9Mrg");
});

test("ролики по свежести, сущности раскодированы, чужой канал и битая дата выброшены", () => {
  const r = parseYoutubeFeed(FEED, "endfield", CHANNELS.en.endfield, "en");
  assert.equal(r.found, true);
  assert.equal(r.parsed, 4);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.videos[0], {
    gameId: "endfield",
    lang: "en",
    title: "Collab & recap",
    url: "https://www.youtube.com/watch?v=DgWvnA2NCm0",
    thumb: "https://i1.ytimg.com/vi/DgWvnA2NCm0/hqdefault.jpg",
    publishedAt: Date.UTC(2026, 8, 15, 9, 0, 33) / 1000,
    duration: null,
    premiere: false,
  });
  assert.deepEqual(r.videos.map((v) => v.title), ["Collab & recap", "Short"]);
});

test("японская лента помечает ролики языком ja", () => {
  const feed = `<feed>${entry("jp000000001", "2026-09-15T09:00:00+00:00", "告知", CHANNELS.ja.endfield)}</feed>`;
  const r = parseYoutubeFeed(feed, "endfield", CHANNELS.ja.endfield, "ja");
  assert.equal(r.videos.length, 1);
  assert.equal(r.videos[0]!.lang, "ja");
});

test("не больше шести роликов", () => {
  const many = Array.from({ length: 9 }, (_, i) => entry(`vid${String(i).padStart(8, "0")}`, `2026-09-0${i + 1}T10:00:00+00:00`, `V${i}`)).join("");
  const r = parseYoutubeFeed(`<feed>${many}</feed>`, "endfield", CHANNELS.en.endfield, "en");
  assert.equal(r.videos.length, 6);
  assert.equal(r.videos[0]!.title, "V8");
});

test("не лента — not found", () => {
  assert.equal(parseYoutubeFeed("<html>error</html>", "endfield", CHANNELS.en.endfield, "en").found, false);
});

test("незакрытый <entry> перед роликом не прячет его", () => {
  const r = parseYoutubeFeed(`<feed><entry>мусор${entry("DgWvnA2NCm0", "2026-09-15T09:00:33+00:00", "Collab")}</feed>`, "endfield", CHANNELS.en.endfield, "en");
  assert.deepEqual([r.parsed, r.videos.map((v) => v.title)], [1, ["Collab"]]);
});

test("50 000 незакрытых <entry> читаются за линейное время", async () => {
  const xml = `<feed>${"<entry>".repeat(50_000)}</feed>`;
  const r = await runBounded<ReturnType<typeof parseYoutubeFeed>>("../src/sources/videos.ts", "parseYoutubeFeed", [xml, "endfield", CHANNELS.en.endfield, "en"]);
  assert.deepEqual([r.found, r.parsed, r.dropped, r.videos.length], [true, 0, 0, 0]);
});

test("ролик с названием длиннее предела выбрасывается и считается, файл проходит проверку", () => {
  const feed = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
${entry("longlonglo1", "2026-09-15T09:00:33+00:00", "T".repeat(301))}
${entry("edgeedgeed1", "2026-09-14T09:00:33+00:00", "T".repeat(300))}
${entry("shortshort1", "2026-09-13T09:00:33+00:00", "Short")}
</feed>`;
  const r = parseYoutubeFeed(feed, "endfield", CHANNELS.en.endfield, "en");
  assert.equal(r.parsed, 3);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.videos.map((v) => v.title.length), [300, 5]);
  const hub: HubData = {
    version: 2,
    updatedAt: 1_788_000_000,
    games: [{ id: "endfield", title: "Arknights: Endfield", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }],
    codes: [],
    banners: [],
    videos: r.videos,
  };
  assert.deepEqual(validateHub(hub), []);
});
