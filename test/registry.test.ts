import { test } from "node:test";
import assert from "node:assert/strict";
import type { Http, HttpResponse } from "../src/http.ts";
import { fandom } from "../src/mediawiki.ts";
import { mergeHub, sectionKey } from "../src/merge.ts";
import { GAME_IDS, type HubData, type HubGame, type Item, type SourceRun } from "../src/types.ts";
import { bannerStarts, parseOverrides } from "../src/overrides.ts";
import { KURO_MENU_URL, kuroArticleJsonUrl, kuroArticleUrl, kuroBanners, unreadableAnnouncement, type KuroBannerFact } from "../src/sources/kuro.ts";
import { KURO_SIGNAL, SOURCES, emptyMemory, fetchKuroAnnouncements, kuroFactsFromMemory } from "../src/sources/registry.ts";

type Route = (url: URL) => HttpResponse | undefined;

function fakeHttp(routes: Route[]) {
  const urls: string[] = [];
  const http: Http = {
    async get(url, validators) {
      urls.push(url);
      const u = new URL(url);
      for (const route of routes) {
        const res = route(u);
        if (res) return validators?.etag && res.validators.etag === validators.etag ? { status: 304, body: "", validators } : res;
      }
      throw new Error(`нет ответа для ${url}`);
    },
  };
  return { http, urls };
}

const json = (value: unknown, etag?: string): HttpResponse => ({ status: 200, body: JSON.stringify(value), validators: etag ? { etag } : {} });
const byId = (id: string) => SOURCES.find((s) => s.id === id)!;
const NOW = Date.UTC(2026, 8, 16, 12, 0) / 1000;

test("у каждой игры есть источники кодов и баннеров и видео на двух языках, кроме кодов Endfield", () => {
  const ids = SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const game of GAME_IDS) {
    for (const section of ["codes", "banners"] as const) {
      const primary = SOURCES.filter((s) => s.game === game && s.section === section && !s.fallback);
      assert.equal(primary.length, game === "endfield" && section === "codes" ? 0 : 1, `${game} ${section}`);
    }
    const videos = SOURCES.filter((s) => s.game === game && s.section === "videos");
    assert.deepEqual(videos.map((s) => s.id).sort(), [`${game}-videos-en`, `${game}-videos-ja`]);
    assert.deepEqual(videos.map((s) => s.lang).sort(), ["en", "ja"]);
    assert.ok(videos.every((s) => !s.fallback && s.everyHours === 1));
  }
  assert.ok(SOURCES.filter((s) => s.section !== "videos").every((s) => s.lang === undefined));
  assert.deepEqual(SOURCES.filter((s) => s.fallback).map((s) => s.id).sort(), [
    "genshin-banners-ennead", "genshin-codes-ennead", "hsr-banners-ennead", "hsr-codes-ennead", "zzz-banners-ennead", "zzz-codes-ennead",
  ]);
  assert.equal(KURO_SIGNAL.id, "wuthering-signal");
});

test("коды с фандома: тот же номер правки — без чтения страницы", async () => {
  const page = "{{Redemption Code Row|NSJR3B97ZZ5X|ref=|A|{{Item List|Stellar Jade*50|mode=br}}|2026-08-16|unknown}}";
  const f = fakeHttp([
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Redemption Code", lastrevid: 5 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: page } }) : undefined),
  ]);
  const memory = emptyMemory();
  const source = byId("hsr-codes");
  const first = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(first.kind, "ok");
  if (first.kind === "ok") assert.deepEqual(first.items.map((c) => ("code" in c ? c.code : "")), ["NSJR3B97ZZ5X"]);
  const parses = f.urls.filter((u) => u.includes("action=parse")).length;
  const second = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(second.kind, "unchanged");
  assert.equal(f.urls.filter((u) => u.includes("action=parse")).length, parses);
});

test("баннеры с фандома: разобранные страницы берутся из памяти, миниатюры пачкой", async () => {
  const page = `{{Convene
|image = Banner A 2026-09-10.jpg
|type = Featured Resonator
|time_start = 2026-09-10 10:00
|time_end = 2026-09-29 11:59
}}
{{Convene/Pool
|resonator_5_F = Hiyuki
}}`;
  const f = fakeHttp([
    (u) => (u.searchParams.get("list") === "categorymembers" ? json({ query: { categorymembers: [{ title: "Banner A/2026-09-10" }, { title: "Convene" }] } }) : undefined),
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Banner A/2026-09-10", lastrevid: 9 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: page } }) : undefined),
    (u) => (u.searchParams.get("prop") === "imageinfo"
      ? json({ query: { pages: [{ title: "File:Banner A 2026-09-10.jpg", imageinfo: [{ thumburl: "https://static.wikia.nocookie.net/a.jpg/scale-to-width-down/400" }] }] } })
      : undefined),
  ]);
  const memory = emptyMemory();
  const source = byId("wuthering-banners");
  const run = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(run.kind, "ok");
  if (run.kind === "ok") {
    assert.equal(run.items.length, 1);
    assert.equal((run.items[0] as { image: string }).image, "https://static.wikia.nocookie.net/a.jpg/scale-to-width-down/400");
  }
  await source.run({ http: f.http, now: NOW, memory });
  assert.equal(f.urls.filter((u) => u.includes("action=parse")).length, 1, "вторая пробежка страницу не читала");
});

test("баннеры с фандома: сломанная подстраница перечитывается на следующем прогоне", async () => {
  const badPage = `{{Convene
|image = Banner A 2026-09-10.jpg
|type = Featured Resonator
|time_start = not-a-date
|time_end = also-not-a-date
}}`;
  const f = fakeHttp([
    (u) => (u.searchParams.get("list") === "categorymembers" ? json({ query: { categorymembers: [{ title: "Banner A/2026-09-10" }] } }) : undefined),
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Banner A/2026-09-10", lastrevid: 9 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: badPage } }) : undefined),
  ]);
  const memory = emptyMemory();
  const source = byId("wuthering-banners");
  const first = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(first.kind, "broken");
  const parsesAfterFirst = f.urls.filter((u) => u.includes("action=parse")).length;
  const second = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(second.kind, first.kind, "тот же испорченный текст даёт тот же вердикт");
  assert.equal(
    f.urls.filter((u) => u.includes("action=parse")).length,
    parsesAfterFirst + 1,
    "вторая пробежка перечитала сломанную страницу, а не взяла её из памяти",
  );
});

test("коды с фандома: сломанный разбор перечитывается на следующем прогоне", async () => {
  // Строка кода без разрешённых символов — «выброшенная», без здоровых строк рядом,
  // так что judge() сочтёт источник поломанным и не запомнит номер правки.
  const badPage = "{{Redemption Code Row|not a code!!|ref=|A|{{Item List|Stellar Jade*50|mode=br}}|2026-08-16|unknown}}";
  const f = fakeHttp([
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Redemption Code", lastrevid: 5 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: badPage } }) : undefined),
  ]);
  const memory = emptyMemory();
  const source = byId("hsr-codes");
  const first = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(first.kind, "broken");
  const parsesAfterFirst = f.urls.filter((u) => u.includes("action=parse")).length;
  const second = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(second.kind, first.kind, "тот же испорченный текст даёт тот же вердикт");
  assert.equal(
    f.urls.filter((u) => u.includes("action=parse")).length,
    parsesAfterFirst + 1,
    "вторая пробежка перечитала сломанную страницу, а не взяла номер правки из памяти",
  );
});

test("баннеры с фандома: страница, пропавшая из категории, удаляется из памяти", async () => {
  const page = `{{Convene
|image = Banner A 2026-09-10.jpg
|type = Featured Resonator
|time_start = 2026-09-10 10:00
|time_end = 2026-09-29 11:59
}}
{{Convene/Pool
|resonator_5_F = Hiyuki
}}`;
  const f = fakeHttp([
    (u) => (u.searchParams.get("list") === "categorymembers" ? json({ query: { categorymembers: [{ title: "Banner A/2026-09-10" }] } }) : undefined),
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Banner A/2026-09-10", lastrevid: 9 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: page } }) : undefined),
    (u) => (u.searchParams.get("prop") === "imageinfo"
      ? json({ query: { pages: [{ title: "File:Banner A 2026-09-10.jpg", imageinfo: [{ thumburl: "https://static.wikia.nocookie.net/a.jpg/scale-to-width-down/400" }] }] } })
      : undefined),
  ]);
  const memory = emptyMemory();
  const wiki = fandom("wutheringwaves");
  const staleKey = `${wiki.api}|Old Banner/2026-01-01`;
  const currentKey = `${wiki.api}|Banner A/2026-09-10`;
  memory.pages[staleKey] = { rev: 1, outcome: { kind: "skip" } };
  const source = byId("wuthering-banners");
  const run = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(run.kind, "ok");
  assert.equal(staleKey in memory.pages, false, "запись пропавшей подстраницы удалена");
  assert.equal(currentKey in memory.pages, true, "запись текущей подстраницы осталась");
});

test("баннеры с фандома: сбой миниатюр не ломает источник, картинки просто нет", async () => {
  const page = `{{Convene
|image = Banner A 2026-09-10.jpg
|type = Featured Resonator
|time_start = 2026-09-10 10:00
|time_end = 2026-09-29 11:59
}}
{{Convene/Pool
|resonator_5_F = Hiyuki
}}`;
  const f = fakeHttp([
    (u) => (u.searchParams.get("list") === "categorymembers" ? json({ query: { categorymembers: [{ title: "Banner A/2026-09-10" }] } }) : undefined),
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Banner A/2026-09-10", lastrevid: 9 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: page } }) : undefined),
    // Запрос миниатюр (imageinfo) нарочно не обслуживается — имитирует сбой сети.
  ]);
  const memory = emptyMemory();
  const source = byId("wuthering-banners");
  const run = await source.run({ http: f.http, now: NOW, memory });
  assert.equal(run.kind, "ok");
  if (run.kind === "ok") {
    assert.equal(run.items.length, 1);
    assert.equal((run.items[0] as { image: string | null }).image, null);
  }
});

test("лента YouTube: 304 — unchanged", async () => {
  const feed = `<feed><entry><yt:videoId>abc</yt:videoId><yt:channelId>UC2SpC8rL9LaeQriE4YNdyzA</yt:channelId><title>T</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-09-15T10:00:00+00:00</published></entry></feed>`;
  const f = fakeHttp([(u) => (u.host === "www.youtube.com" ? { status: 200, body: feed, validators: { etag: '"e1"' } } : undefined)]);
  const memory = emptyMemory();
  const source = byId("zzz-videos-en");
  assert.equal((await source.run({ http: f.http, now: NOW, memory })).kind, "ok");
  assert.equal((await source.run({ http: f.http, now: NOW, memory })).kind, "unchanged");
});

test("японская лента — отдельный источник со своим адресом", async () => {
  const feed = `<feed><entry><yt:videoId>jpv</yt:videoId><yt:channelId>UCt09C9DPSuOGpHoitbcyCIQ</yt:channelId><title>予告</title><link rel="alternate" href="https://www.youtube.com/watch?v=jpv"/><published>2026-09-15T10:00:00+00:00</published></entry></feed>`;
  const f = fakeHttp([(u) => (u.searchParams.get("channel_id") === "UCt09C9DPSuOGpHoitbcyCIQ" ? { status: 200, body: feed, validators: {} } : undefined)]);
  const run = await byId("zzz-videos-ja").run({ http: f.http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "ok");
  if (run.kind === "ok") assert.equal((run.items[0] as { lang: string }).lang, "ja");
  assert.deepEqual(f.urls, ["https://www.youtube.com/feeds/videos.xml?channel_id=UCt09C9DPSuOGpHoitbcyCIQ"]);
});

// Синтетические статьи Kuro: названия, имена и даты придуманы, от настоящих взяты только служебные фразы.
const KURO_MENU_PATH = "/ArticleMenu.json";
const articlePath = (id: number) => `/article/${id}.json`;
const KURO_MENU = [
  { articleId: 9001, articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]", startTime: "2026-09-15 11:15:00" },
  { articleId: 9101, articleTitle: "Patch Notes for Wuthering Waves Version 9.9: Synthetic Title", startTime: "2026-09-14 12:00:00" },
  { articleId: 9105, articleTitle: "Resonator Review | Synthetic", startTime: "2026-09-15 18:00:00" },
];
const ANNOUNCEMENT_HTML =
  "<p>[Test Banner] Featured Resonator Convene</p>" +
  "<p>During the event, 5-Star Resonator: Resonator A, 4-Star Resonators: B, C receive boosted drop rates!</p>" +
  "<p>Version 9.9 update - 2026-10-22 09:59 (server time)</p>";
const NOTES_HTML = "<p>Version 9.9 update</p><p>Maintenance Time: 2026-09-17 04:00 - 2026-09-17 11:00 (UTC+8)</p>";
const article = (id: number, html: string, etag: string, title = "Synthetic") => json({ articleId: id, articleTitle: title, articleContent: html }, etag);
const FACT: KuroBannerFact = { title: "Test Banner", featured: "Resonator A", start: { kind: "release", version: "9.9" }, endsAt: Date.UTC(2026, 9, 22, 8, 59) / 1000 };
const RELEASE_END = Date.UTC(2026, 8, 17, 3, 0) / 1000;

/** Сайт Kuro, который можно «выключать» по частям и у которого можно менять меню. */
function kuroSite() {
  const site = {
    menu: KURO_MENU as unknown[],
    menuEtag: '"m1"',
    menuDown: false,
    down: new Set<number>(),
    html: { 9001: ANNOUNCEMENT_HTML, 9101: NOTES_HTML } as Record<number, string>,
    etags: { 9001: '"a1"', 9101: '"n1"' } as Record<number, string>,
    titles: {} as Record<number, string>,
    seen: [] as { url: string; etag: string | undefined }[],
  };
  const f = fakeHttp([
    (u) => {
      if (u.host !== "hw-media-cdn-mingchao.kurogame.com") return undefined;
      if (u.pathname.endsWith(KURO_MENU_PATH)) {
        if (site.menuDown) throw new Error("меню недоступно");
        return json(site.menu, site.menuEtag);
      }
      const id = Number(/\/article\/(\d+)\.json$/.exec(u.pathname)?.[1]);
      if (site.down.has(id)) throw new Error(`статья ${id} недоступна`);
      const html = site.html[id];
      return html === undefined ? undefined : article(id, html, site.etags[id]!, site.titles[id]);
    },
  ]);
  const http: Http = {
    get(url, validators) {
      site.seen.push({ url, etag: validators?.etag });
      return f.http.get(url, validators);
    },
  };
  const requests = (path: string) => site.seen.filter((r) => r.url.endsWith(path));
  return { site, http, requests };
}

test("анонсы Kuro: меню, статья анонса и патчноут читаются, из них запоминаются только факты", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.announcements.map((a) => a.articleId), [9001]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
  assert.deepEqual(memory.kuroPatchNotes.map((p) => p.articleId), [9101]);
  assert.deepEqual(memory.kuro.map((a) => a.articleId), [9001]);
  assert.equal(k.requests(articlePath(9105)).length, 0, "статья про резонатора не читается");
  const banners = kuroBanners(kuroFactsFromMemory(memory, result.announcements), memory.kuroReleases, NOW);
  assert.deepEqual(banners.map((b) => [b.title, b.featured, b.startsAt, b.endsAt, b.url, b.image]), [
    ["Test Banner", ["Resonator A"], RELEASE_END, FACT.endsAt, kuroArticleUrl(9001), null],
  ]);
  assert.ok(!JSON.stringify(memory).includes("Featured Resonator Convene"), "текста статьи в памяти нет");
});

test("анонсы Kuro: при 304 всё берётся из памяти, и каждый запрос условный", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  k.site.html[9001] = "<p>изменённый текст с теми же метками версии</p>";
  const before = k.site.seen.length;
  const second = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(second.ok && second.announcements[0]?.articleId, 9001);
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] }, "304 не перечитывает статью — прошлый результат остался");
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
  const again = k.site.seen.slice(before);
  assert.equal(again.length, 3, "меню и две статьи");
  assert.ok(again.every((r) => r.etag !== undefined), "все запросы с условными заголовками");
});

test("анонсы Kuro: изменившаяся статья читается заново", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  k.site.html[9001] = ANNOUNCEMENT_HTML.replace("Test Banner", "Renamed Banner");
  k.site.etags[9001] = '"a2"';
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, true);
  assert.equal(memory.kuroFacts["9001"]?.[0]?.title, "Renamed Banner");
});

test("анонсы Kuro: сбой статьи не ломает прогон и не стирает прошлые факты", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  k.site.down.add(9001);
  k.site.down.add(9101);
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, true, "меню отработало — источник не сломан");
  if (result.ok) {
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0]!, /9001/);
  }
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
  assert.equal(unreadableAnnouncement(memory.kuro, memory.kuroFacts, NOW), null);
  k.site.down.clear();
  const healed = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(healed.ok && healed.warnings, []);
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
});

test("анонсы Kuro: новая статья, которая не открылась, перечитывается на следующем прогоне, даже если меню не менялось", async () => {
  const k = kuroSite();
  k.site.down.add(9001);
  const memory = emptyMemory();
  const first = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(first.ok && first.warnings.length, 1);
  assert.deepEqual(memory.kuroFacts, {}, "фактов нет: статья ещё не прочитана, а не «прочитана без баннеров»");
  assert.deepEqual(first.ok && first.announcements.map((a) => a.articleId), [9001]);
  assert.equal(unreadableAnnouncement(memory.kuro, memory.kuroFacts, NOW), null, "сбой сети сигнала не даёт");
  k.site.down.clear();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(k.requests(articlePath(9001)).length, 2, "второй запрос статьи — при неизменном меню");
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
});

test("анонсы Kuro: устаревшее и закончившееся забывается вместе с метками версий, статьи не запрашиваются", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(Object.keys(memory.validators).filter((key) => key.includes("/article/")).length, 2);
  const before = k.site.seen.length;
  const later = NOW + 60 * 86400; // баннер закончился 22 октября, а это уже середина ноября
  const result = await fetchKuroAnnouncements({ http: k.http, now: later, memory });
  assert.deepEqual(result.ok && result.announcements, []);
  assert.deepEqual(memory.kuro, []);
  assert.deepEqual(memory.kuroPatchNotes, []);
  assert.deepEqual(memory.kuroFacts, {});
  assert.deepEqual(memory.kuroReleases, {});
  assert.equal(Object.keys(memory.validators).filter((key) => key.includes("/article/")).length, 0);
  assert.ok(memory.validators[KURO_MENU_URL], "метки меню остаются");
  assert.equal(k.site.seen.length - before, 1, "только меню");
});

test("анонсы Kuro: меню не отвечает — поломка источника, память нетронута", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  const snapshot = structuredClone(memory);
  k.site.menuDown = true;
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, false);
  assert.deepEqual(memory, snapshot);
});

test("анонсы Kuro: меню другой формы — поломка источника, факты не трогаются", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  k.site.menu = { error: "changed" } as unknown as unknown[];
  k.site.menuEtag = '"m2"';
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, false);
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
});

test("анонсы Kuro: патчноут без строки техработ не стирает уже известный срок версии", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  memory.kuroReleases["9.9"] = 5;
  k.site.html[9101] = "<p>Version 9.9 update</p><p>No maintenance line here</p>";
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok && result.warnings.length, 0);
  assert.deepEqual(memory.kuroReleases, { "9.9": 5 });
});

test("факты Kuro из памяти: у анонса без разобранной статьи баннеров нет", () => {
  const memory = emptyMemory();
  memory.kuroFacts["9001"] = [FACT];
  const a = { articleId: 9001, publishedAt: NOW - 100, url: kuroArticleUrl(9001) };
  const b = { articleId: 9002, publishedAt: NOW - 50, url: kuroArticleUrl(9002) };
  assert.deepEqual(kuroFactsFromMemory(memory, [b, a]), [
    { announcement: b, banners: [] },
    { announcement: a, banners: [FACT] },
  ]);
});

test("сетевая ошибка — поломка источника, а не исключение", async () => {
  const f = fakeHttp([]);
  const run = await byId("endfield-banners").run({ http: f.http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "broken");
});

// Меню, к которому дописаны придуманные статьи: номер, название, время (UTC+8), текст и метка версии.
const withArticles = (k: ReturnType<typeof kuroSite>, extra: { id: number; title: string; time: string; html: string; etag: string }[]) => {
  k.site.menu = [...KURO_MENU, ...extra.map((e) => ({ articleId: e.id, articleTitle: e.title, startTime: e.time }))];
  k.site.menuEtag = '"m-extra"';
  for (const e of extra) {
    k.site.html[e.id] = e.html;
    k.site.etags[e.id] = e.etag;
    k.site.titles[e.id] = e.title;
  }
};
const unreadable = (memory: ReturnType<typeof emptyMemory>, now = NOW) => unreadableAnnouncement(memory.kuro, memory.kuroFacts, now)?.articleId ?? null;

test("анонсы Kuro: факты живут, пока идёт баннер, хотя анонсу больше 21 дня; статьи заново не читаются, сигнала нет", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  const before = k.site.seen.length;
  const later = NOW + 30 * 86400; // 16 октября: анонсу больше 21 дня, а баннер идёт до 22 октября
  for (const menuEtag of ['"m1"', '"m2"']) {
    // Первый раз меню отвечает 304, второй — новой версией: в обоих случаях всё то же.
    k.site.menuEtag = menuEtag;
    const result = await fetchKuroAnnouncements({ http: k.http, now: later, memory });
    assert.deepEqual(result.ok && result.announcements, [], "читаемых анонсов нет: окно в 21 день");
    assert.deepEqual(memory.kuro.map((a) => a.articleId), [9001]);
    assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
    assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END }, "срок версии нужен для начала баннера");
    assert.deepEqual(memory.kuroPatchNotes, []);
    const banners = kuroBanners(kuroFactsFromMemory(memory, memory.kuro), memory.kuroReleases, later);
    assert.deepEqual(banners.map((b) => [b.title, b.startsAt, b.endsAt, b.url]), [["Test Banner", RELEASE_END, FACT.endsAt, kuroArticleUrl(9001)]]);
    assert.equal(unreadable(memory, later), null, "анонс вне окна сигнала не даёт");
  }
  assert.equal(k.requests(articlePath(9001)).length, 1, "статья прочитана один раз, при первом прогоне");
  assert.equal(k.site.seen.length - before, 2, "только меню, дважды");
  // После конца баннера факты забываются.
  await fetchKuroAnnouncements({ http: k.http, now: NOW + 40 * 86400, memory });
  assert.deepEqual(memory.kuro, []);
  assert.deepEqual(memory.kuroFacts, {});
  assert.deepEqual(memory.kuroReleases, {});
});

test("анонсы Kuro: прочитанная статья без баннеров — сигнал, пока её не поправят; сбой перечитывания сигнал не меняет", async () => {
  const k = kuroSite();
  k.site.html[9001] = "<p>Announcement without any banner block</p>";
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts, { "9001": [] }, "статья прочитана, баннеров нет");
  assert.equal(unreadable(memory), 9001);
  k.site.menuEtag = '"m2"'; // меню изменилось — статья запрашивается снова, и на этот раз сбой
  k.site.down.add(9001);
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts, { "9001": [] }, "сбой перечитывания прошлое не стирает");
  assert.equal(unreadable(memory), 9001);
  k.site.down.clear();
  k.site.html[9001] = ANNOUNCEMENT_HTML;
  k.site.etags[9001] = '"a2"';
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.equal(unreadable(memory), null);
});

test("анонсы Kuro: самый свежий анонс оружейный — он не читается и сигнала не даёт", async () => {
  const k = kuroSite();
  k.site.html[9001] = "<p>Announcement without any banner block</p>";
  withArticles(k, [
    {
      id: 9002,
      title: "[Test Weapon] Featured Weapon Convene",
      time: "2026-09-15 20:00:00",
      html: "<p>During the event, 5-Star Weapon: Blade X receive boosted drop rates!</p><p>2026-10-22 10:00 - 2026-11-11 11:59 (server time)</p>",
      etag: '"w1"',
    },
  ]);
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(result.ok && result.announcements.map((a) => a.articleId), [9001]);
  assert.equal(k.requests(articlePath(9002)).length, 0, "оружейная статья не запрашивается");
  assert.equal(memory.kuroFacts["9002"], undefined);
  // Кандидат на сигнал — пустой анонс 9001, а не оружейный.
  assert.equal(unreadable(memory), 9001);
  k.site.html[9001] = ANNOUNCEMENT_HTML;
  k.site.etags[9001] = '"a3"';
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(unreadable(memory), null);
});

test("анонсы Kuro: одиночный баннер без заголовка в теле читается по названию статьи", async () => {
  const k = kuroSite();
  withArticles(k, [
    {
      id: 9003,
      title: "[Solo Banner] Featured Resonator Convene",
      time: "2026-09-15 20:00:00",
      html:
        "<p>During the event, 5-Star Resonator: Solo Resonator, 4-Star Resonators: B, C receive boosted drop rates!</p>" +
        "<p>Duration</p><p>2026-10-22 10:00 - 2026-11-11 11:59 (server time)</p>",
      etag: '"s1"',
    },
  ]);
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts["9003"], [
    { title: "Solo Banner", featured: "Solo Resonator", start: { kind: "at", at: Date.UTC(2026, 9, 22, 9, 0) / 1000 }, endsAt: Date.UTC(2026, 10, 11, 10, 59) / 1000 },
  ]);
  assert.equal(unreadable(memory), null, "самый свежий анонс дал баннер");
});

test("анонсы Kuro: патчноут версии 9.9.1 не задаёт срок 9.9 и не читается", async () => {
  const k = kuroSite();
  withArticles(k, [
    {
      id: 9110,
      title: "Patch Notes for Wuthering Waves Version 9.9.1: Synthetic Hotfix",
      time: "2026-09-15 10:00:00",
      html: "<p>Maintenance Time: 2026-09-16 04:00 - 2026-09-16 09:00 (UTC+8)</p>",
      etag: '"h1"',
    },
  ]);
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok && result.warnings.length, 0);
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
  assert.deepEqual(memory.kuroPatchNotes.map((p) => p.articleId), [9101]);
  assert.equal(k.requests(articlePath(9110)).length, 0);
});

test("анонсы Kuro: два патчноута одной версии — срок берётся у более нового, старый его не перебивает", async () => {
  const k = kuroSite();
  const newer = { id: 9103, title: "Patch Notes for Wuthering Waves Version 9.9: Synthetic Update", time: "2026-09-15 10:00:00", etag: '"p1"' };
  const NEWER_END = Date.UTC(2026, 8, 17, 5, 0) / 1000;
  withArticles(k, [{ ...newer, html: "<p>Maintenance Time: 2026-09-17 06:00 - 2026-09-17 13:00 (UTC+8)</p>" }]);
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroReleases, { "9.9": NEWER_END }, "старый патчноут 9101 идёт позже нового и его не затирает");
  // Старый патчноут изменился, новый — нет (304): срок остаётся новым.
  k.site.html[9101] = "<p>Maintenance Time: 2026-09-18 06:00 - 2026-09-18 13:00 (UTC+8)</p>";
  k.site.etags[9101] = '"n2"';
  k.site.menuEtag = '"m-next"';
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroReleases, { "9.9": NEWER_END });
  // У нового нет строки техработ, а у старого есть: срок не пропадает и берётся у старого.
  const other = kuroSite();
  withArticles(other, [{ ...newer, html: "<p>No maintenance line here</p>" }]);
  const fresh = emptyMemory();
  await fetchKuroAnnouncements({ http: other.http, now: NOW, memory: fresh });
  assert.deepEqual(fresh.kuroReleases, { "9.9": RELEASE_END });
});

/** Сайт Kuro, у которого выбранные статьи отвечают заданным ответом (когда он задан), а остальное — как обычно. */
function kuroSiteWith(replies: Map<number, HttpResponse>) {
  const k = kuroSite();
  const http: Http = {
    get(url, validators) {
      const id = Number(/\/article\/(\d+)\.json$/.exec(url)?.[1]);
      const reply = replies.get(id);
      return reply ? Promise.resolve(reply) : k.http.get(url, validators);
    },
  };
  return { ...k, http };
}

test("анонсы Kuro: ответ 200 без текста статьи — прочитана без баннеров, предупреждение есть, сигнал есть", async () => {
  const bodies: unknown[] = [{ articleId: 9001, message: "oops" }, null, [], "text", 42, { articleContent: 42 }, { articleContent: null }];
  for (const body of bodies) {
    const k = kuroSiteWith(new Map([[9001, json(body, '"x"')]]));
    const memory = emptyMemory();
    const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
    const label = JSON.stringify(body);
    assert.equal(result.ok && result.warnings.length, 1, label);
    assert.match(result.ok ? result.warnings[0]! : "", /9001/, label);
    assert.deepEqual(memory.kuroFacts, { "9001": [] }, label);
    assert.equal(unreadable(memory), 9001, label);
    assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END }, "патчноут читается как обычно");
    assert.deepEqual(memory.validators[kuroArticleJsonUrl(9001)], { etag: '"x"' }, "ответ прочитан — его метки запомнены");
  }
});

test("анонсы Kuro: разовый ответ 200 без текста не стирает найденные баннеры; статья с текстом — снова как обычно", async () => {
  const replies = new Map<number, HttpResponse>();
  const k = kuroSiteWith(replies);
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.equal(unreadable(memory), null);
  replies.set(9001, json({ articleId: 9001 }, '"g1"'));
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] }, "прошлые факты остались");
  assert.equal(unreadable(memory), null);
  replies.delete(9001); // на запрос с метками пустого ответа сайт отвечает 200 с прежней статьёй
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.equal(unreadable(memory), null);
});

test("анонсы Kuro: патчноут без текста — предупреждение, срок версии остаётся, фактов у него нет", async () => {
  const k = kuroSiteWith(new Map([[9101, json({ articleId: 9101 }, '"x"')]]));
  const memory = emptyMemory();
  memory.kuroReleases["9.9"] = 5;
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok && result.warnings.length, 1);
  assert.deepEqual(memory.kuroReleases, { "9.9": 5 });
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] }, "анонс прочитан как обычно, ключа для патчноута нет");
  assert.equal(unreadable(memory), null);
});

test("анонсы Kuro: ответ 200, но не JSON, и сбой сети — статья не прочитана: ключа нет, сигнала нет, метки не меняются", async () => {
  const notJson: HttpResponse = { status: 200, body: "<html>maintenance</html>", validators: { etag: '"h"' } };
  const k = kuroSiteWith(new Map([[9001, notJson]]));
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok && result.warnings.length, 1);
  assert.deepEqual(memory.kuroFacts, {});
  assert.equal(memory.validators[kuroArticleJsonUrl(9001)], undefined);
  assert.equal(unreadable(memory), null);
});

test("анонсы Kuro: вписанный в overrides.json баннер гасит сигнал, в том числе для ответа 200 без текста", async () => {
  const k = kuroSiteWith(new Map([[9001, json({ articleId: 9001 }, '"x"')]]));
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(unreadable(memory), 9001);
  const overrides = (starts: string) => {
    const r = parseOverrides({ banners: [{ game: "wuthering", title: "By Hand", starts, ends: "2026-10-22 10:59 UTC+1" }] });
    assert.ok(r.ok);
    return r.ok ? r.overrides : { codes: [], banners: [], hide: [] };
  };
  const signal = (o: ReturnType<typeof overrides>) => unreadableAnnouncement(memory.kuro, memory.kuroFacts, NOW, bannerStarts(o, "wuthering"))?.articleId ?? null;
  // Анонс 9001 вышел 15 сентября в 11:15 по UTC+8.
  assert.equal(signal(overrides("2026-10-01 10:00 UTC+1")), null, "начало вписанного баннера позже выхода анонса");
  assert.equal(signal(overrides("2026-09-13 04:15 UTC+1")), null, "ровно за 2 суток до выхода");
  assert.equal(signal(overrides("2026-09-13 04:14 UTC+1")), 9001, "минутой раньше — это уже другой баннер");
});

// Поток записей одной игры: больше MAX_CODES_PER_GAME считается поломкой источника, а не новыми данными.
const redemptionRow = (code: string) => `{{Redemption Code Row|${code}|ref=|A|{{Item List|Credit*1|mode=br}}|2026-08-01|unknown}}`;
const codeName = (i: number) => `CODE${String(i).padStart(4, "0")}`;
const codesPage = (count: number) => Array.from({ length: count }, (_, i) => redemptionRow(codeName(i))).join("\n");
const hsrCodesWiki = (page: string) =>
  fakeHttp([
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Redemption Code", lastrevid: 5 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: page } }) : undefined),
  ]);

test("коды с фандома: ровно предел — норма", async () => {
  const memory = emptyMemory();
  const run = await byId("hsr-codes").run({ http: hsrCodesWiki(codesPage(200)).http, now: NOW, memory });
  assert.equal(run.kind, "ok");
  if (run.kind === "ok") assert.equal(run.items.length, 200);
  assert.equal(Object.keys(memory.revisions).length, 1, "номер правки запомнен");
});

test("коды с фандома: 201 код — источник сломан, номер правки не запоминается, прошлые коды остаются", async () => {
  const memory = emptyMemory();
  const run = await byId("hsr-codes").run({ http: hsrCodesWiki(codesPage(201)).http, now: NOW, memory });
  assert.equal(run.kind, "broken");
  assert.deepEqual(memory.revisions, {}, "страница перечитается на следующем прогоне");

  const catalog: HubGame[] = [{ id: "hsr", title: "Honkai: Star Rail", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }];
  const previous: HubData = {
    version: 2,
    updatedAt: NOW - 3600,
    games: catalog,
    codes: [{ gameId: "hsr", code: "OLDCODE1", rewards: "", expiresAt: null, region: "all", source: null }],
    banners: [],
    videos: [],
  };
  const runs = new Map<string, SourceRun<Item>>([[sectionKey("hsr", "codes"), run]]);
  const hub = mergeHub({ previous, catalog, runs, now: NOW });
  assert.deepEqual(hub.codes.map((c) => c.code), ["OLDCODE1"]);
});

test("коды с фандома: предел считается по кодам, а не по строкам — одна строка с 201 кодом ломает источник", async () => {
  const group = Array.from({ length: 201 }, (_, i) => codeName(i)).join(";");
  const run = await byId("hsr-codes").run({ http: hsrCodesWiki(redemptionRow(group)).http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "broken");
});

test("коды ennead.cc: 200 — норма, 201 — источник сломан", async () => {
  const feed = (count: number) => ({ active: Array.from({ length: count }, (_, i) => ({ code: codeName(i), rewards: ["Credit ×1"] })) });
  const at = (count: number) => fakeHttp([(u) => (u.host === "api.ennead.cc" ? json(feed(count)) : undefined)]).http;
  const source = byId("hsr-codes-ennead");
  assert.equal((await source.run({ http: at(200), now: NOW, memory: emptyMemory() })).kind, "ok");
  const memory = emptyMemory();
  assert.equal((await source.run({ http: at(201), now: NOW, memory })).kind, "broken");
  assert.deepEqual(memory.validators, {}, "метки ответа не запомнены — запрос повторится безусловным");
});
