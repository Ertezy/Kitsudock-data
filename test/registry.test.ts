import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusError, type Http, type HttpResponse } from "../src/http.ts";
import { fandom } from "../src/mediawiki.ts";
import { mergeHub, sectionKey } from "../src/merge.ts";
import { GAME_IDS, type HubData, type HubGame, type Item, type SourceRun } from "../src/types.ts";
import { bannerStarts, parseOverrides } from "../src/overrides.ts";
import { KURO_MENU_URL, kuroArticleJsonUrl, kuroArticleUrl, kuroBanners, unreadableAnnouncement, withKuroBanners, type KuroBannerFact } from "../src/sources/kuro.ts";
import { KURO_SIGNAL, SOURCES, emptyMemory, fetchKuroAnnouncements, kuroBannersFromMemory, kuroFactsFromMemory } from "../src/sources/registry.ts";
import { KURO_ARTICLES_BUDGET_MS, MAX_BANNERS_PER_GAME, MAX_KURO_ARTICLES_PER_RUN, MAX_KURO_BANNERS_PER_ARTICLE, RUN_BUDGET_MS } from "../src/validate.ts";

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

// Число запросов за прогон не должно расти вместе с тем, что отдала страница.
test("анонсы Kuro: из сотни свежих анонсов и патчноутов за прогон читается не больше 30 статей, самые новые", async () => {
  assert.equal(MAX_KURO_ARTICLES_PER_RUN, 30);
  const k = kuroSite();
  // Время на сайте — UTC+8; метка только упорядочивает записи, главное — все они свежие и уже вышли.
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const announcementIds = Array.from({ length: 100 }, (_, i) => 20_000 + i); // 20 000 — самый новый
  const noteIds = Array.from({ length: 10 }, (_, i) => 30_000 + i); // патчноуты новее всех анонсов
  const announcements = announcementIds.map((articleId, i) => ({
    articleId,
    articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]",
    startTime: stamp(Date.UTC(2026, 8, 15, 23, 59) - i * 60_000),
  }));
  const notes = noteIds.map((articleId, i) => ({
    articleId,
    articleTitle: `Patch Notes for Wuthering Waves Version 7.${i}: Synthetic Title`,
    startTime: stamp(Date.UTC(2026, 8, 16, 4, 0) - i * 60_000),
  }));
  k.site.menu = [...announcements, ...notes].reverse(); // самые старые первыми: порядок меню не подсказка
  for (const id of [...announcementIds, ...noteIds]) {
    k.site.html[id] = announcementIds.includes(id) ? ANNOUNCEMENT_HTML : NOTES_HTML;
    k.site.etags[id] = `"e${id}"`;
  }
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, true);
  const fetched = k.site.seen.filter((r) => r.url.includes("/article/")).map((r) => Number(/(\d+)\.json$/.exec(r.url)![1]));
  const readAnnouncements = announcementIds.slice(0, MAX_KURO_ARTICLES_PER_RUN - noteIds.length);
  assert.equal(fetched.length, MAX_KURO_ARTICLES_PER_RUN, "статей запрошено не больше предела");
  assert.deepEqual([...fetched].sort(), [...noteIds, ...readAnnouncements].sort(), "из всех — самые новые");
  assert.deepEqual(Object.keys(memory.kuroFacts).map(Number).sort(), [...readAnnouncements].sort(), "факты есть только у прочитанных анонсов");
  assert.equal(memory.kuro.length, 100, "остальные анонсы из меню не теряются — просто не прочитаны");
});

test("анонсы Kuro: до предела читаются все статьи, как и раньше", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(k.site.seen.filter((r) => r.url.includes("/article/")).length, 2, "анонс и патчноут");
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
});

// Баннеров Kuro в файле не больше предела, сколько бы блоков ни было в статье и сколько бы статей ни отдало меню.
/** Статья из `count` блоков баннеров; срок начала — на `minute` минут позже десяти часов, чтобы у статей были разные начала. */
const bannerBlocks = (id: number, count: number, minute: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `<p>[Synthetic ${id}/${i}] Featured Resonator Convene</p><p>5-Star Resonator: Name ${id}/${i}, 4-Star Resonators: B receive boosted drop rates!</p>` +
      `<p>2026-10-01 10:${String(minute).padStart(2, "0")} - 2026-10-22 11:59 (server time)</p>`,
  ).join("");

test("анонсы Kuro: одна статья с 3000 блоками баннеров — в памяти не больше десяти фактов", async () => {
  assert.equal(MAX_KURO_BANNERS_PER_ARTICLE, 10);
  const k = kuroSite();
  k.site.html[9001] = bannerBlocks(9001, 3000, 0);
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.equal(result.ok, true);
  assert.equal(memory.kuroFacts["9001"]?.length, MAX_KURO_BANNERS_PER_ARTICLE);
  assert.ok(Buffer.byteLength(JSON.stringify(memory), "utf8") < 20_000, "память не раздувается");
  assert.equal(kuroBannersFromMemory(memory, NOW).length, MAX_KURO_BANNERS_PER_ARTICLE);
});

test("анонсы Kuro: тридцать статей по десять баннеров — в файл идут не больше 50, самые новые", async () => {
  assert.equal(MAX_BANNERS_PER_GAME, 50);
  const k = kuroSite();
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const ids = Array.from({ length: MAX_KURO_ARTICLES_PER_RUN }, (_, i) => 20_000 + i);
  k.site.menu = ids.map((articleId, i) => ({
    articleId,
    articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]",
    startTime: stamp(Date.UTC(2026, 8, 15, 23, 59) - i * 60_000),
  }));
  ids.forEach((id, i) => {
    k.site.html[id] = bannerBlocks(id, 3000, i); // начало тем позже, чем больше i
    k.site.etags[id] = `"e${id}"`;
  });
  const memory = emptyMemory();
  assert.equal((await fetchKuroAnnouncements({ http: k.http, now: NOW, memory })).ok, true);
  const all = kuroBanners(kuroFactsFromMemory(memory, memory.kuro), memory.kuroReleases, NOW);
  assert.equal(all.length, MAX_KURO_ARTICLES_PER_RUN * MAX_KURO_BANNERS_PER_ARTICLE, "до предела на файл баннеров 300");
  const capped = kuroBannersFromMemory(memory, NOW);
  assert.equal(capped.length, MAX_BANNERS_PER_GAME);
  const newestStart = Math.max(...all.map((b) => b.startsAt));
  assert.equal(capped[0]!.startsAt, newestStart, "самые новые первыми");
  assert.deepEqual(
    [...new Set(capped.map((b) => b.startsAt))].sort((a, b) => b - a),
    [...new Set(all.map((b) => b.startsAt))].sort((a, b) => b - a).slice(0, 5),
    "пять самых новых начал по десять баннеров",
  );
});

// Таблица Endfield: сколько бы строк ни отдала страница, баннеров не больше предела, а миниатюры — одним запросом.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const efStamp = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}, 00:00`;
};
const efRow = (name: string, startMs: number, endMs: number) =>
  `<tr valign="top"><td><div class="header">${name}</div><div>[[File:${name} banner.png|360px|link=]]</div><div><b><abbr title="Americas / Europe">AM / EU</abbr>:</b> <span>${efStamp(startMs)} &ndash; ${efStamp(endMs)} <span class="visually-hidden">(UTC+8)</span></span></div></td><td><div>'''Limited operators:''' <ul><li><span>[[File:${name} icon.png|24px|link=${name}]]</span> [[${name} op]] </li></ul></div></td></tr>`;
const DAY_MS = 86_400_000;

function endfieldWiki(table: string) {
  return fakeHttp([
    (u) => (u.searchParams.get("action") === "expandtemplates" ? json({ expandtemplates: { wikitext: table } }) : undefined),
    (u) =>
      u.searchParams.get("prop") === "imageinfo"
        ? json({ query: { pages: u.searchParams.get("titles")!.split("|").map((title) => ({ title, imageinfo: [{ thumburl: `https://static.example.test/${encodeURIComponent(title)}` }] })) } })
        : undefined,
  ]);
}
const imageinfoCalls = (urls: string[]) => urls.filter((u) => u.includes("prop=imageinfo"));

test("Endfield: 500 строк таблицы — не больше 50 баннеров, самые новые, и один запрос миниатюр", async () => {
  assert.equal(MAX_BANNERS_PER_GAME, 50);
  const first = Date.UTC(2030, 0, 1);
  const live = Array.from({ length: 500 }, (_, i) => efRow(`Banner ${i}`, first + i * DAY_MS, first + (i + 10) * DAY_MS));
  const expired = Array.from({ length: 10 }, (_, i) => efRow(`Old ${i}`, Date.UTC(2025, 0, 1) + i * DAY_MS, Date.UTC(2025, 0, 20) + i * DAY_MS));
  const f = endfieldWiki(`<table>${[...expired, ...live].join("\n")}</table>`);
  const run = await byId("endfield-banners").run({ http: f.http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "ok");
  if (run.kind !== "ok") return;
  const titles = run.items.map((b) => (b as { title: string }).title);
  assert.equal(titles.length, MAX_BANNERS_PER_GAME);
  assert.deepEqual([...titles].sort(), Array.from({ length: 50 }, (_, i) => `Banner ${450 + i}`).sort(), "оставлены самые новые, закончившиеся не берутся");
  assert.ok(run.items.every((b) => (b as { image: string | null }).image?.startsWith("https://static.example.test/")), "у всех оставленных есть миниатюра");
  const calls = imageinfoCalls(f.urls);
  assert.equal(calls.length, 1, "миниатюры — одним запросом");
  const asked = new URL(calls[0]!).searchParams.get("titles")!.split("|");
  assert.equal(asked.length, MAX_BANNERS_PER_GAME);
  assert.ok(asked.every((name) => /^File:Banner \d+ banner\.png$/.test(name) && Number(/\d+/.exec(name)![0]) >= 450), "картинки только тех баннеров, что попадут в файл");
});

test("Endfield: все строки закончились — ни баннеров, ни запроса миниатюр", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => efRow(`Old ${i}`, Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 20)));
  const f = endfieldWiki(`<table>${rows.join("\n")}</table>`);
  const run = await byId("endfield-banners").run({ http: f.http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "ok");
  if (run.kind === "ok") assert.deepEqual(run.items, []);
  assert.equal(imageinfoCalls(f.urls).length, 0);
});

test("баннеры с фандома: закончившийся баннер не просит миниатюру, число страниц ограничено общим пределом", async () => {
  const page = `{{Convene
|image = Banner A 2026-08-20.jpg
|type = Featured Resonator
|time_start = 2026-08-20 10:00
|time_end = 2026-09-10 09:59
}}
{{Convene/Pool
|resonator_5_F = Hiyuki
}}`;
  const f = fakeHttp([
    (u) => (u.searchParams.get("list") === "categorymembers" ? json({ query: { categorymembers: [{ title: "Banner A/2026-08-20" }] } }) : undefined),
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: [{ title: "Banner A/2026-08-20", lastrevid: 9 }] } }) : undefined),
    (u) => (u.searchParams.get("action") === "parse" ? json({ parse: { wikitext: page } }) : undefined),
  ]);
  const run = await byId("wuthering-banners").run({ http: f.http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "ok");
  if (run.kind === "ok") assert.deepEqual(run.items, [], "баннер закончился 10 сентября — в файл не попадёт");
  assert.equal(imageinfoCalls(f.urls).length, 0, "миниатюра для него не запрашивалась");
  assert.ok(f.urls.some((u) => u.includes("list=categorymembers") && u.includes(`cmlimit=${MAX_BANNERS_PER_GAME}`)));
});

// Предел кодов считается по тем, что попадут в файл: долгая история сгоревших кодов на странице — не поток.
const expiredRow = (code: string) => `{{Redemption Code Row|${code}|ref=|A|{{Item List|Credit*1|mode=br}}|2026-08-01|2026-08-02}}`;

test("коды с фандома: 250 сгоревших и 5 живых — норма, в файл идут 5 живых", async () => {
  const expired = Array.from({ length: 250 }, (_, i) => expiredRow(`OLD${String(i).padStart(4, "0")}`));
  const live = Array.from({ length: 5 }, (_, i) => redemptionRow(`LIVE${String(i).padStart(4, "0")}`));
  const memory = emptyMemory();
  const run = await byId("hsr-codes").run({ http: hsrCodesWiki([...expired, ...live].join("\n")).http, now: NOW, memory });
  assert.equal(run.kind, "ok");
  if (run.kind !== "ok") return;
  assert.deepEqual(run.items.map((c) => (c as { code: string }).code), Array.from({ length: 5 }, (_, i) => `LIVE${String(i).padStart(4, "0")}`));
  assert.equal(Object.keys(memory.revisions).length, 1, "номер правки запомнен");
  const catalog: HubGame[] = [{ id: "hsr", title: "Honkai: Star Rail", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }];
  const hub = mergeHub({ previous: null, catalog, runs: new Map<string, SourceRun<Item>>([[sectionKey("hsr", "codes"), run]]), now: NOW });
  assert.equal(hub.codes.length, 5);
});

test("коды с фандома: 201 живой код среди сгоревших — по-прежнему поломка", async () => {
  const expired = Array.from({ length: 50 }, (_, i) => expiredRow(`OLD${String(i).padStart(4, "0")}`));
  const run = await byId("hsr-codes").run({ http: hsrCodesWiki([...expired, codesPage(201)].join("\n")).http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "broken");
});

// Календарь ennead.cc тоже идёт через общий предел баннеров: живые, самые новые, не больше 50.
test("баннеры ennead.cc: 120 живых и 10 закончившихся — не больше 50, самые новые", async () => {
  const day = 86_400;
  const live = Array.from({ length: 120 }, (_, i) => ({ characters: [{ name: `Hero ${i}`, rarity: 5 }], start_time: NOW + i * day, end_time: NOW + (i + 10) * day }));
  const expired = Array.from({ length: 10 }, (_, i) => ({ characters: [{ name: `Gone ${i}`, rarity: 5 }], start_time: NOW - (100 + i) * day, end_time: NOW - (50 + i) * day }));
  const http = fakeHttp([(u) => (u.host === "api.ennead.cc" ? json({ banners: [...expired, ...live] }) : undefined)]).http;
  const run = await byId("genshin-banners-ennead").run({ http, now: NOW, memory: emptyMemory() });
  assert.equal(run.kind, "ok");
  if (run.kind !== "ok") return;
  assert.equal(run.items.length, MAX_BANNERS_PER_GAME);
  assert.deepEqual(
    run.items.map((b) => (b as { title: string }).title).sort(),
    Array.from({ length: 50 }, (_, i) => `Hero ${70 + i}`).sort(),
  );
});

// Время прогона ограничено: сбой связи и бюджет времени обрывают чтение статей, остаток ждёт следующего прогона.

/** Тот же сайт Kuro, у которого запросы статей предварительно проходят через `onArticle`. */
const withArticleHook = (k: ReturnType<typeof kuroSite>, onArticle: (url: string, etag: string | undefined) => void): Http => ({
  get(url, validators) {
    if (url.includes("/article/")) onArticle(url, validators?.etag);
    return k.http.get(url, validators);
  },
});

const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

test("анонсы Kuro: статья не ответила за таймаут — чтение останавливается, прогон не падает, остальное — в следующий раз", async () => {
  const k = kuroSite();
  const requested: string[] = [];
  const http = withArticleHook(k, (url) => {
    requested.push(url);
    throw timeoutError();
  });
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.equal(result.ok, true, "меню отработало — источник не сломан");
  assert.equal(requested.length, 1, "после первого таймаута вторая статья не запрашивается");
  assert.match(requested[0]!, /9001\.json$/);
  assert.ok(result.ok && result.warnings.length === 2 && /9001/.test(result.warnings[0]!), "предупреждение о статье и об остановке");
  assert.deepEqual(memory.kuroFacts, {}, "ключа нет — статья не прочитана и сигнала не даёт");
  assert.deepEqual(memory.kuro.map((a) => a.articleId), [9001], "анонс из меню остался");
  // Следующий прогон читает всё, что не успел.
  const healed = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  assert.deepEqual(healed.ok && healed.warnings, []);
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
});

test("анонсы Kuro: обрыв соединения останавливает чтение так же, как таймаут", async () => {
  const k = kuroSite();
  let requested = 0;
  const http = withArticleHook(k, () => {
    requested++;
    throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
  });
  const result = await fetchKuroAnnouncements({ http, now: NOW, memory: emptyMemory() });
  assert.equal(result.ok, true);
  assert.equal(requested, 1);
});

test("анонсы Kuro: ответ 404 по одной статье чтение не останавливает, как и раньше", async () => {
  const k = kuroSite();
  const requested: string[] = [];
  const http = withArticleHook(k, (url) => {
    requested.push(url);
    if (url.endsWith("/9001.json")) throw new StatusError(404, url);
  });
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.equal(result.ok, true);
  assert.equal(requested.length, 2, "патчноут читается после статьи с 404");
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
  assert.ok(result.ok && result.warnings.length === 1 && /9001/.test(result.warnings[0]!));
});

test("анонсы Kuro: время чтения вышло — следующая статья не запрашивается, остальные ждут следующего прогона", async () => {
  assert.equal(KURO_ARTICLES_BUDGET_MS, 120_000);
  const k = kuroSite();
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const ids = Array.from({ length: 10 }, (_, i) => 20_000 + i);
  k.site.menu = ids.map((articleId, i) => ({
    articleId,
    articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]",
    startTime: stamp(Date.UTC(2026, 8, 15, 23, 59) - i * 60_000),
  }));
  for (const id of ids) {
    k.site.html[id] = ANNOUNCEMENT_HTML;
    k.site.etags[id] = `"e${id}"`;
  }
  // Каждая статья, которую нужно читать, «отвечает» 50 секунд (ответ 304 — мгновенно): часы идут по ответам, настоящего ожидания нет.
  let elapsed = 1_000_000;
  const clock = () => elapsed;
  const requested: string[] = [];
  const http = withArticleHook(k, (url, etag) => {
    requested.push(url);
    if (etag === undefined) elapsed += 50_000;
  });
  const memory = emptyMemory();
  const result = await fetchKuroAnnouncements({ http, now: NOW, memory, clock });
  assert.equal(result.ok, true);
  assert.equal(requested.length, 3, "0 с, 50 с и 100 с — до бюджета; на 150 с чтение остановлено");
  requested.length = 0;
  assert.deepEqual(Object.keys(memory.kuroFacts).sort(), ids.slice(0, 3).map(String).sort(), "прочитаны самые новые");
  assert.equal(memory.kuro.length, 10, "остальные анонсы из меню остались");
  assert.ok(result.ok && result.warnings.length === 1 && /время/.test(result.warnings[0]!));
  // Следующий прогон с новыми часами продолжает: прочитанные отвечают 304, остальные читаются.
  elapsed = 5_000_000;
  const next = await fetchKuroAnnouncements({ http, now: NOW, memory, clock });
  assert.equal(next.ok, true);
  assert.deepEqual(Object.keys(memory.kuroFacts).sort(), ids.slice(0, 6).map(String).sort(), "прочитанные ответили 304 и времени не взяли, следующие три прочитаны");
});

test("анонсы Kuro: до бюджета времени ничего не меняется — читаются все статьи без предупреждений", async () => {
  const k = kuroSite();
  const result = await fetchKuroAnnouncements({ http: k.http, now: NOW, memory: emptyMemory(), clock: () => 0 });
  assert.deepEqual(result.ok && result.warnings, []);
  assert.equal(k.site.seen.filter((r) => r.url.includes("/article/")).length, 2);
});

// Срок всего прогона (RUN_BUDGET_MS): источники не начинают новых запросов, когда он вышел, и оставляют прошлые данные.

test("ленты: у YouTube и у запасного ennead.cc своя лента (общий хост), у остальных источников её нет", () => {
  assert.ok(SOURCES.filter((s) => s.section === "videos").every((s) => s.lane === "youtube"));
  assert.ok(SOURCES.filter((s) => s.fallback).every((s) => s.lane === "ennead"));
  assert.ok(SOURCES.filter((s) => s.section !== "videos" && !s.fallback).every((s) => s.lane === undefined));
});

test("источник: сбой связи помечается в результате, остальные поломки — нет", async () => {
  const source = byId("zzz-videos-en");
  const failing = (error: Error): Http => ({ async get() { throw error; } });
  const timedOut = await source.run({ http: failing(timeoutError()), now: NOW, memory: emptyMemory() });
  assert.deepEqual(timedOut, { kind: "broken", error: "The operation was aborted due to timeout", transport: true });
  const reset = await source.run({ http: failing(new TypeError("fetch failed")), now: NOW, memory: emptyMemory() });
  assert.equal(reset.kind === "broken" && reset.transport, true);
  const refused = await source.run({ http: failing(new StatusError(404, "https://example.test/")), now: NOW, memory: emptyMemory() });
  assert.deepEqual(refused, { kind: "broken", error: "ответ 404: https://example.test/" }, "ответ с кодом — не сбой связи, поля нет");
  const plain = await source.run({ http: failing(new Error("другое")), now: NOW, memory: emptyMemory() });
  assert.deepEqual(plain, { kind: "broken", error: "другое" });
});

const BANNER_PAGE = (n: number) => `{{Convene
|image = Banner ${n} 2026-09-1${n}.jpg
|type = Featured Resonator
|time_start = 2026-09-1${n} 10:00
|time_end = 2026-09-29 11:59
}}
{{Convene/Pool
|resonator_5_F = Hiyuki
}}`;

/** Фандом Wuthering Waves с тремя страницами баннеров; чтение страницы «занимает» parseMs на часах. */
function wuwaWiki(clock: { at: number }, parseMs: number) {
  const titles = [1, 2, 3].map((n) => `Banner ${n}/2026-09-1${n}`);
  return fakeHttp([
    (u) => (u.searchParams.get("list") === "categorymembers" ? json({ query: { categorymembers: titles.map((title) => ({ title })) } }) : undefined),
    (u) => (u.searchParams.get("prop") === "info" ? json({ query: { pages: u.searchParams.get("titles")!.split("|").map((title, i) => ({ title, lastrevid: 10 + i })) } }) : undefined),
    (u) => {
      if (u.searchParams.get("action") !== "parse") return undefined;
      clock.at += parseMs;
      return json({ parse: { wikitext: BANNER_PAGE(Number(/Banner (\d)/.exec(u.searchParams.get("page")!)![1])) } });
    },
    (u) => (u.searchParams.get("prop") === "imageinfo" ? json({ query: { pages: [] } }) : undefined),
  ]);
}

test("баннеры с фандома: срок прогона вышел между страницами — остальные не читаются, источник пропущен, прочитанное запомнено", async () => {
  const clock = { at: 0 };
  const f = wuwaWiki(clock, 400_000);
  const memory = emptyMemory();
  const ctx = { http: f.http, now: NOW, memory, clock: () => clock.at, deadline: 500_000 };
  const run = await byId("wuthering-banners").run(ctx);
  assert.equal(run.kind, "skipped");
  assert.match(run.kind === "skipped" ? run.reason! : "", /время прогона/);
  assert.equal(f.urls.filter((u) => u.includes("action=parse")).length, 2, "0 и 400 секунд — до срока; на 800-й третья страница не читается");
  assert.equal(Object.keys(memory.pages).length, 2, "разобранные страницы запомнены");
  assert.equal(f.urls.filter((u) => u.includes("prop=imageinfo")).length, 0, "без полного набора страниц миниатюры не нужны");
  // Следующий прогон берёт две страницы из памяти и дочитывает третью.
  clock.at = 0;
  const next = await byId("wuthering-banners").run(ctx);
  assert.equal(next.kind, "ok");
  assert.equal(f.urls.filter((u) => u.includes("action=parse")).length, 3, "прочитана одна недостающая страница");
  if (next.kind === "ok") assert.equal(next.items.length, 3);
});

test("баннеры с фандома: до срока всё идёт как раньше", async () => {
  const clock = { at: 0 };
  const f = wuwaWiki(clock, 1_000);
  const run = await byId("wuthering-banners").run({ http: f.http, now: NOW, memory: emptyMemory(), clock: () => clock.at, deadline: RUN_BUDGET_MS });
  assert.equal(run.kind, "ok");
  assert.equal(f.urls.filter((u) => u.includes("action=parse")).length, 3);
  assert.equal(f.urls.filter((u) => u.includes("prop=imageinfo")).length, 1);
});

test("баннеры с фандома: срок вышел после чтения страниц — миниатюры не запрашиваются, источник пропущен", async () => {
  const clock = { at: 0 };
  const f = wuwaWiki(clock, 300_000); // три страницы: 0, 300 и 600 секунд — при сроке 700 последняя ещё читается
  const run = await byId("wuthering-banners").run({ http: f.http, now: NOW, memory: emptyMemory(), clock: () => clock.at, deadline: 700_000 });
  assert.equal(run.kind, "skipped", "запрос миниатюр на 900-й секунде уже не начинается");
  assert.equal(f.urls.filter((u) => u.includes("action=parse")).length, 3);
  assert.equal(f.urls.filter((u) => u.includes("prop=imageinfo")).length, 0);
});

test("Endfield: срок вышел до запроса миниатюр — запрос не идёт, источник пропущен, до срока — как раньше", async () => {
  const table = `<table>${efRow("Banner 1", Date.UTC(2030, 0, 1), Date.UTC(2030, 0, 20))}</table>`;
  const clock = { at: 0 };
  const f = endfieldWiki(table);
  const http: Http = {
    get(url, validators) {
      if (url.includes("action=expandtemplates")) clock.at += 700_000;
      return f.http.get(url, validators);
    },
  };
  const late = await byId("endfield-banners").run({ http, now: NOW, memory: emptyMemory(), clock: () => clock.at, deadline: 600_000 });
  assert.equal(late.kind, "skipped");
  assert.equal(imageinfoCalls(f.urls).length, 0);
  clock.at = 0;
  const inTime = await byId("endfield-banners").run({ http: f.http, now: NOW, memory: emptyMemory(), clock: () => clock.at, deadline: RUN_BUDGET_MS });
  assert.equal(inTime.kind, "ok");
  assert.equal(imageinfoCalls(f.urls).length, 1);
});

test("анонсы Kuro: срок прогона вышел — следующая статья не запрашивается, остальные ждут следующего прогона", async () => {
  const k = kuroSite();
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const ids = Array.from({ length: 10 }, (_, i) => 20_000 + i);
  k.site.menu = ids.map((articleId, i) => ({
    articleId,
    articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]",
    startTime: stamp(Date.UTC(2026, 8, 15, 23, 59) - i * 60_000),
  }));
  for (const id of ids) {
    k.site.html[id] = ANNOUNCEMENT_HTML;
    k.site.etags[id] = `"e${id}"`;
  }
  let elapsed = 0;
  let step = 50_000; // каждая читаемая статья «отвечает» 50 секунд
  const requested: string[] = [];
  const http = withArticleHook(k, (url, etag) => {
    requested.push(url);
    if (etag === undefined) elapsed += step;
  });
  const memory = emptyMemory();
  // Бюджет чтения статей (120 с) не вышел бы и на третьей статье, а срок прогона вышел: 0 и 50 секунд — до срока 60, на 100-й чтение остановлено.
  const result = await fetchKuroAnnouncements({ http, now: NOW, memory, clock: () => elapsed, deadline: 60_000 });
  assert.equal(result.ok, true);
  assert.equal(requested.length, 2);
  assert.deepEqual(Object.keys(memory.kuroFacts).sort(), ids.slice(0, 2).map(String).sort());
  assert.ok(result.ok && result.warnings.length === 1 && /время/.test(result.warnings[0]!));
  // Следующий прогон с новыми часами продолжает.
  elapsed = 0;
  step = 0;
  const next = await fetchKuroAnnouncements({ http, now: NOW, memory, clock: () => elapsed, deadline: RUN_BUDGET_MS });
  assert.deepEqual(next.ok && next.warnings, []);
  assert.deepEqual(Object.keys(memory.kuroFacts).sort(), [...ids].map(String).sort());
});

// Статья, что всегда не отвечает, не должна держать остальные: она откладывается и читается последней.

const articleOf = (url: string) => Number(/(\d+)\.json$/.exec(url)![1]);

test("анонсы Kuro: статья, что всегда не отвечает, откладывается — остальные читаются в следующие прогоны", async () => {
  const k = kuroSite();
  const requested: number[] = [];
  const http = withArticleHook(k, (url) => {
    requested.push(articleOf(url));
    if (articleOf(url) === 9001) throw timeoutError();
  });
  const memory = emptyMemory();
  // Прогон 1: самая новая статья первая, таймаут обрывает чтение — патчноут не прочитан, статья отложена.
  assert.equal((await fetchKuroAnnouncements({ http, now: NOW, memory })).ok, true);
  assert.deepEqual(requested, [9001]);
  assert.deepEqual(memory.kuroDeferred, { "9001": NOW });
  assert.deepEqual(memory.kuroReleases, {});
  // Прогон 2: сперва статьи без отметки, отложенная — последней; патчноут теперь прочитан.
  requested.length = 0;
  assert.equal((await fetchKuroAnnouncements({ http, now: NOW + 3600, memory })).ok, true);
  assert.deepEqual(requested, [9101, 9001]);
  assert.deepEqual(memory.kuroReleases, { "9.9": RELEASE_END });
  assert.deepEqual(memory.kuroFacts, {}, "анонс так и не прочитан, сигнала он не даёт");
  assert.deepEqual(memory.kuroDeferred, { "9001": NOW + 3600 }, "отметка обновлена: статья снова не ответила");
  // Прогон 3 и дальше: порядок тот же, остальные статьи не голодают.
  requested.length = 0;
  await fetchKuroAnnouncements({ http, now: NOW + 7200, memory });
  assert.deepEqual(requested, [9101, 9001], "патчноут отвечает 304 и читается первым, отложенная — последней");
});

test("анонсы Kuro: отложенная статья, что снова отвечает, читается и теряет отметку", async () => {
  const k = kuroSite();
  const requested: number[] = [];
  let down = true;
  const http = withArticleHook(k, (url) => {
    requested.push(articleOf(url));
    if (down && articleOf(url) === 9001) throw timeoutError();
  });
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.deepEqual(memory.kuroDeferred, { "9001": NOW });
  down = false;
  requested.length = 0;
  const result = await fetchKuroAnnouncements({ http, now: NOW + 3600, memory });
  assert.deepEqual(result.ok && result.warnings, []);
  assert.deepEqual(requested, [9101, 9001]);
  assert.deepEqual(memory.kuroFacts, { "9001": [FACT] });
  assert.deepEqual(memory.kuroDeferred, {}, "успешное чтение снимает отметку");
});

test("анонсы Kuro: отложенная статья, ответившая 304, тоже теряет отметку; ответ с кодом отметку не снимает и чтение не останавливает", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  memory.kuroDeferred = { "9001": NOW - 10 };
  const requested: number[] = [];
  const http = withArticleHook(k, (url) => requested.push(articleOf(url)));
  await fetchKuroAnnouncements({ http, now: NOW + 3600, memory });
  assert.deepEqual(requested, [9101, 9001], "отложенная идёт последней, хотя новее");
  assert.deepEqual(memory.kuroDeferred, {}, "304 — статья отвечает");
  memory.kuroDeferred = { "9001": NOW - 10 };
  requested.length = 0;
  const missing = withArticleHook(k, (url) => {
    requested.push(articleOf(url));
    if (articleOf(url) === 9001) throw new StatusError(404, url);
  });
  const result = await fetchKuroAnnouncements({ http: missing, now: NOW + 7200, memory });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, [9101, 9001]);
  assert.deepEqual(memory.kuroDeferred, { "9001": NOW - 10 }, "404 — не сбой связи: отметка остаётся как была");
});

test("анонсы Kuro: из отложенных первой читается та, что отложена раньше, — они чередуются, а не голодают", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http: k.http, now: NOW, memory });
  // Обе статьи отложены: 9101 — давно, 9001 — недавно. Давно отложенная идёт первой, хотя 9001 новее.
  memory.kuroDeferred = { "9001": NOW - 1000, "9101": NOW - 5000 };
  k.site.etags[9001] = '"a2"';
  k.site.etags[9101] = '"n2"';
  const requested: number[] = [];
  const http = withArticleHook(k, (url) => requested.push(articleOf(url)));
  await fetchKuroAnnouncements({ http, now: NOW + 3600, memory });
  assert.deepEqual(requested, [9101, 9001]);
  assert.deepEqual(memory.kuroDeferred, {});
  // Если и первая из отложенных не отвечает, вторая в этот прогон не читается, но в следующий идёт первой.
  memory.kuroDeferred = { "9001": NOW - 1000, "9101": NOW - 5000 };
  k.site.etags[9001] = '"a3"';
  k.site.etags[9101] = '"n3"';
  requested.length = 0;
  const failing = withArticleHook(k, (url) => {
    requested.push(articleOf(url));
    if (articleOf(url) === 9101) throw timeoutError();
  });
  await fetchKuroAnnouncements({ http: failing, now: NOW + 7200, memory });
  assert.deepEqual(requested, [9101], "сбой связи обрывает чтение, как и раньше");
  assert.deepEqual(memory.kuroDeferred, { "9001": NOW - 1000, "9101": NOW + 7200 });
  requested.length = 0;
  await fetchKuroAnnouncements({ http: failing, now: NOW + 10_800, memory });
  assert.deepEqual(requested, [9001, 9101], "9001 теперь отложена раньше — идёт первой и читается");
  assert.deepEqual(memory.kuroDeferred, { "9101": NOW + 10_800 });
});

test("анонсы Kuro: отметка отложенной статьи уходит, когда анонса больше нет в меню", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  const http = withArticleHook(k, (url) => {
    if (articleOf(url) === 9001) throw timeoutError();
  });
  await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.deepEqual(Object.keys(memory.kuroDeferred), ["9001"]);
  k.site.menu = KURO_MENU.filter((a) => a.articleId !== 9001);
  k.site.menuEtag = '"m2"';
  await fetchKuroAnnouncements({ http: k.http, now: NOW + 3600, memory });
  assert.deepEqual(memory.kuroDeferred, {});
});

test("анонсы Kuro: отметка отложенной статьи уходит, когда статья старше 21 дня, даже если меню не менялось", async () => {
  const k = kuroSite();
  const memory = emptyMemory();
  const http = withArticleHook(k, (url) => {
    if (articleOf(url) === 9001) throw timeoutError();
  });
  await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.deepEqual(Object.keys(memory.kuroDeferred), ["9001"]);
  await fetchKuroAnnouncements({ http: k.http, now: NOW + 40 * 86400, memory }); // меню отвечает 304, свежесть считается по часам
  assert.deepEqual(memory.kuroDeferred, {});
});

test("анонсы Kuro: отложенная статья остаётся среди тридцати самых новых, но идёт последней", async () => {
  const k = kuroSite();
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const ids = Array.from({ length: 40 }, (_, i) => 20_000 + i); // 20 000 — самая новая
  k.site.menu = ids.map((articleId, i) => ({
    articleId,
    articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]",
    startTime: stamp(Date.UTC(2026, 8, 15, 23, 59) - i * 60_000),
  }));
  for (const id of ids) {
    k.site.html[id] = ANNOUNCEMENT_HTML;
    k.site.etags[id] = `"e${id}"`;
  }
  const requested: number[] = [];
  const http = withArticleHook(k, (url) => requested.push(articleOf(url)));
  const memory = emptyMemory();
  memory.kuroDeferred = { "20000": NOW - 60 };
  await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.equal(requested.length, MAX_KURO_ARTICLES_PER_RUN, "предел прежний");
  assert.deepEqual(requested, [...ids.slice(1, MAX_KURO_ARTICLES_PER_RUN), 20_000], "остальные самые новые — по порядку, отложенная — в конце");
  assert.deepEqual(memory.kuroDeferred, {});
});

test("анонсы Kuro: без отложенных статей порядок чтения прежний — анонсы, затем патчноуты", async () => {
  const k = kuroSite();
  const requested: number[] = [];
  const http = withArticleHook(k, (url) => requested.push(articleOf(url)));
  const memory = emptyMemory();
  await fetchKuroAnnouncements({ http, now: NOW, memory });
  assert.deepEqual(requested, [9001, 9101]);
  assert.deepEqual(memory.kuroDeferred, {});
});

// Двойники баннеров Kuro (то же название, начала в пределах двух суток) сводятся по порядку статей, а не по началу.

const atFact = (title: string, start: number, endsAt: number): KuroBannerFact => ({ title, featured: "Resonator A", start: { kind: "at", at: start }, endsAt });
const announced = (articleId: number, publishedAt: number) => ({ articleId, publishedAt, url: kuroArticleUrl(articleId) });
const emptyHub = (): HubData => ({ version: 2, updatedAt: NOW, games: [], codes: [], banners: [], videos: [] });

test("баннеры Kuro из памяти: у двойников из двух анонсов остаётся запись более новой статьи, а не более позднего начала", () => {
  const memory = emptyMemory();
  const start = NOW + 86_400;
  memory.kuro = [announced(9002, NOW - 86_400), announced(9001, NOW - 3 * 86_400)]; // самая новая статья первая
  memory.kuroFacts = {
    "9002": [atFact("Twin Banner", start, start + 21 * 86_400)], // новая статья, начало раньше
    "9001": [atFact("Twin Banner", start + 86_400, start + 22 * 86_400)], // старая статья, начало на сутки позже
  };
  const banners = kuroBannersFromMemory(memory, NOW);
  assert.equal(banners.length, 1);
  assert.equal(banners[0]!.url, kuroArticleUrl(9002), "запись новой статьи");
  assert.equal(banners[0]!.startsAt, start);
  const hub = withKuroBanners(emptyHub(), banners);
  assert.deepEqual(hub.banners.map((b) => [b.url, b.startsAt]), [[kuroArticleUrl(9002), start]]);
  // Порядок статей решает и когда начала поменялись местами.
  memory.kuroFacts = {
    "9002": [atFact("Twin Banner", start + 86_400, start + 22 * 86_400)],
    "9001": [atFact("Twin Banner", start, start + 21 * 86_400)],
  };
  assert.deepEqual(kuroBannersFromMemory(memory, NOW).map((b) => b.url), [kuroArticleUrl(9002)]);
});

test("баннеры Kuro из памяти: двойники занимают одно место под пределом баннеров, а не два", () => {
  assert.equal(MAX_BANNERS_PER_GAME, 50);
  const memory = emptyMemory();
  const newest = NOW + 30 * 86_400; // двойники — самые поздние по началу
  const ends = NOW + 60 * 86_400;
  memory.kuro = [announced(9002, NOW - 86_400), announced(9001, NOW - 3 * 86_400), announced(8000, NOW - 10 * 86_400)];
  memory.kuroFacts = {
    "9002": [atFact("Twin", newest, ends)],
    "9001": [atFact("Twin", newest + 3_600, ends)],
    "8000": Array.from({ length: MAX_BANNERS_PER_GAME }, (_, i) => atFact(`Other ${i}`, NOW + (i + 1) * 3_600, ends)), // 50 разных названий
  };
  // Названий 51, записей 52: если обрезать до сведения двойников, обоих двойников оставило бы под пределом — вышло бы 49.
  const banners = kuroBannersFromMemory(memory, NOW);
  assert.equal(banners.length, MAX_BANNERS_PER_GAME);
  assert.deepEqual(banners.filter((b) => b.title === "Twin").map((b) => b.url), [kuroArticleUrl(9002)], "один двойник — из более новой статьи");
  assert.equal(banners.filter((b) => b.title.startsWith("Other")).length, MAX_BANNERS_PER_GAME - 1, "из остальных не влезает самый ранний");
});
