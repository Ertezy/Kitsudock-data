import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusError, type Http } from "../src/http.ts";
import { ART_RECHECK_HOURS, artKey, pickPreviousArt, refreshArt, withArt, type ArtMemory } from "../src/sources/art.ts";
import { ENNEAD_SOURCE } from "../src/sources/codes.ts";
import type { Banner, HubData } from "../src/types.ts";
import { MAX_ART_LOOKUPS_PER_RUN } from "../src/validate.ts";

const NOW = 1_800_000_000;
const THUMB = "https://static.wikia.nocookie.net/w/images/a/aa/Test_Banner_2026-05-21.jpg/revision/latest/scale-to-width-down/400";

const banner = (over: Partial<Banner> = {}): Banner => ({
  gameId: "wuthering",
  title: "Test Banner",
  featured: ["Resonator A"],
  rarity: 5,
  image: null,
  startsAt: NOW - 86400,
  endsAt: NOW + 86400,
  url: "https://example.test/news/1",
  ...over,
});

const file = (name: string, uploadedAt: number) => ({ name, uploadedAt });

/** Фальшивая вики: список файлов по началу имени и миниатюры; запросы записываются. */
function fakeWiki(files: Record<string, { name: string; timestamp: string }[]>, thumbs: Record<string, string>, failPrefix?: string) {
  const urls: string[] = [];
  const http: Http = {
    async get(url) {
      urls.push(url);
      const params = new URL(url).searchParams;
      if (params.get("list") === "allimages") {
        const prefix = params.get("aiprefix")!;
        if (prefix === failPrefix) throw new Error("сеть упала");
        const list = (files[prefix] ?? []).map((f) => ({ name: f.name.replace(/ /g, "_"), title: `File:${f.name}`, timestamp: f.timestamp }));
        return { status: 200, body: JSON.stringify({ query: { allimages: list } }), validators: {} };
      }
      const pages = params
        .get("titles")!
        .split("|")
        .map((title) => {
          const thumb = thumbs[title.replace(/^File:/, "")];
          return thumb ? { title, imageinfo: [{ thumburl: thumb }] } : { title, missing: true };
        });
      return { status: 200, body: JSON.stringify({ query: { pages } }), validators: {} };
    },
  };
  return { http, urls };
}

test("арт прошлого запуска: самый свежий файл с этим названием, с датой или без", () => {
  const files = [
    file("Test Banner.png", 100),
    file("Test Banner 2026-05-21.jpg", 300),
    file("Test Banner 2026-01-15.jpg", 200),
    file("Test Banner Lookout Store.png", 900),
    file("Test Banner 2026-05-21 Splash.png", 950),
  ];
  assert.equal(pickPreviousArt(files, "Test Banner"), "Test Banner 2026-05-21.jpg");
  assert.equal(pickPreviousArt([file("Test Banner.png", 100)], "Test Banner"), "Test Banner.png");
  assert.equal(pickPreviousArt([file("Test Banner Lookout Store.png", 100)], "Test Banner"), null, "другое название с тем же началом");
  assert.equal(pickPreviousArt([file("Test Banner.ogg", 100)], "Test Banner"), null, "не картинка");
  assert.equal(pickPreviousArt([], "Test Banner"), null);
});

test("одинаковое время загрузки: берётся более поздняя дата в имени", () => {
  assert.equal(pickPreviousArt([file("Test Banner 2026-01-01.png", 5), file("Test Banner 2026-09-01.png", 5)], "Test Banner"), "Test Banner 2026-09-01.png");
  assert.equal(pickPreviousArt([file("Test Banner 2026-01-01.png", NaN), file("Test Banner 2026-09-01.png", NaN)], "Test Banner"), "Test Banner 2026-09-01.png");
  assert.equal(pickPreviousArt([file("Test Banner.gif", 5)], "Test Banner"), null, "gif не берётся");
});

test("имя файла как его пишет вики: без двоеточия, лишних пробелов и кривых кавычек, косая черта — дефис", () => {
  assert.equal(pickPreviousArt([file("Test Pulse Ages 2026-06-28.png", 1)], "Test Pulse: Ages"), "Test Pulse Ages 2026-06-28.png");
  assert.equal(pickPreviousArt([file("Test Banner.png", 1)], "  Test   Banner "), "Test Banner.png");
  assert.equal(pickPreviousArt([file('Test "Quoted" Banner.png', 1)], "Test “Quoted” Banner"), 'Test "Quoted" Banner.png');
  assert.equal(pickPreviousArt([file("Test-Slash Banner.png", 1)], "Test/Slash Banner"), "Test-Slash Banner.png");
});

test("название с кривым апострофом и символами регулярных выражений", () => {
  assert.equal(pickPreviousArt([file("Time's (Test) Banner 2026-04-30.jpg", 1)], "Time’s (Test) Banner"), "Time's (Test) Banner 2026-04-30.jpg");
  assert.equal(pickPreviousArt([file("Timexs (Test) Banner.jpg", 1)], "Time.s (Test) Banner"), null);
});

test("ключ: игра и название, апострофы выпрямлены", () => {
  assert.equal(artKey(banner({ title: "Time’s Banner" })), "wuthering|Time's Banner");
});

test("баннер без арта получает миниатюру прошлого запуска с вики своей игры", async () => {
  const wiki = fakeWiki({ Test_Banner: [{ name: "Test Banner 2026-05-21.jpg", timestamp: "2026-05-21T10:00:00Z" }] }, { "Test Banner 2026-05-21.jpg": THUMB });
  const art: ArtMemory = {};
  const warnings = await refreshArt(wiki.http, [banner()], art, NOW);
  assert.deepEqual(warnings, []);
  assert.deepEqual(art, { "wuthering|Test Banner": { image: THUMB, checkedAt: NOW } });
  assert.ok(wiki.urls.every((u) => u.startsWith("https://wutheringwaves.fandom.com/api.php?")), "вики игры баннера");
});

test("не найдено — запоминается пустой результат, чтобы не спрашивать каждый прогон", async () => {
  const wiki = fakeWiki({}, {});
  const art: ArtMemory = {};
  await refreshArt(wiki.http, [banner({ gameId: "zzz" })], art, NOW);
  assert.deepEqual(art, { "zzz|Test Banner": { image: null, checkedAt: NOW } });
  assert.equal(wiki.urls.length, 1, "без файла миниатюры не запрашиваются");
  assert.match(wiki.urls[0]!, /^https:\/\/zenless-zone-zero\.fandom\.com\/api\.php\?/);
});

test("баннеры с картинкой и баннеры Endfield вики не трогают", async () => {
  const wiki = fakeWiki({}, {});
  const art: ArtMemory = {};
  const warnings = await refreshArt(wiki.http, [banner({ image: "https://example.test/a.png" }), banner({ gameId: "endfield" })], art, NOW);
  assert.equal(wiki.urls.length, 0);
  assert.deepEqual(warnings, []);
  assert.deepEqual(art, {});
});

test("баннеры запасного источника ennead.cc вики не трогают: в их названии имена персонажей, а не название баннера", async () => {
  const wiki = fakeWiki({ Character_A: [{ name: "Character A.png", timestamp: "2026-01-01T00:00:00Z" }] }, { "Character A.png": THUMB });
  const art: ArtMemory = {};
  const warnings = await refreshArt(wiki.http, [banner({ gameId: "genshin", title: "Character A", url: ENNEAD_SOURCE })], art, NOW);
  assert.equal(wiki.urls.length, 0);
  assert.deepEqual(warnings, []);
  assert.deepEqual(art, {});
});

test("название, которое вики не примет как имя файла, не запрашивается и запоминается как ненайденное", async () => {
  const wiki = fakeWiki({}, {});
  const art: ArtMemory = {};
  const warnings = await refreshArt(wiki.http, [banner({ title: "Test #1 Banner" }), banner({ title: "Test [Banner]" })], art, NOW);
  assert.equal(wiki.urls.length, 0);
  assert.deepEqual(warnings, []);
  assert.deepEqual(art, {
    "wuthering|Test #1 Banner": { image: null, checkedAt: NOW },
    "wuthering|Test [Banner]": { image: null, checkedAt: NOW },
  });
});

test("проверка повторяется не чаще раза в шесть часов", async () => {
  const wiki = fakeWiki({ Test_Banner: [{ name: "Test Banner.png", timestamp: "2026-01-01T00:00:00Z" }] }, { "Test Banner.png": THUMB });
  const art: ArtMemory = { "wuthering|Test Banner": { image: null, checkedAt: NOW - 3600 } };
  await refreshArt(wiki.http, [banner()], art, NOW);
  assert.equal(wiki.urls.length, 0, "час назад уже смотрели");
  const later = NOW - 3600 + ART_RECHECK_HOURS * 3600 - 300;
  assert.equal(ART_RECHECK_HOURS, 6);
  await refreshArt(wiki.http, [banner()], art, later);
  assert.deepEqual(art["wuthering|Test Banner"], { image: THUMB, checkedAt: later });
});

test("ушедшие баннеры и баннеры, получившие свою картинку, из памяти убираются", async () => {
  const art: ArtMemory = { "zzz|Gone Banner": { image: THUMB, checkedAt: NOW }, "zzz|Test Banner": { image: THUMB, checkedAt: NOW } };
  await refreshArt(fakeWiki({}, {}).http, [banner({ gameId: "zzz", image: "https://example.test/own.png" })], art, NOW);
  assert.deepEqual(art, {});
});

test("сбой вики по одному баннеру: прошлая картинка остаётся, повтор — через шесть часов, остальные проверяются", async () => {
  const wiki = fakeWiki({ Other_Banner: [{ name: "Other Banner.png", timestamp: "2026-01-01T00:00:00Z" }] }, { "Other Banner.png": THUMB }, "Test_Banner");
  const art: ArtMemory = { "wuthering|Test Banner": { image: THUMB, checkedAt: NOW - 7 * 3600 } };
  const warnings = await refreshArt(wiki.http, [banner(), banner({ title: "Other Banner" })], art, NOW);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Test Banner.*сеть упала/);
  assert.deepEqual(art["wuthering|Test Banner"], { image: THUMB, checkedAt: NOW });
  assert.deepEqual(art["wuthering|Other Banner"], { image: THUMB, checkedAt: NOW });
});

test("файл нашёлся, а миниатюры нет — это сбой: прошлая картинка не теряется", async () => {
  const wiki = fakeWiki({ Test_Banner: [{ name: "Test Banner.png", timestamp: "2026-01-01T00:00:00Z" }] }, {});
  const art: ArtMemory = { "wuthering|Test Banner": { image: THUMB, checkedAt: NOW - 7 * 3600 } };
  const warnings = await refreshArt(wiki.http, [banner()], art, NOW);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Test Banner.png/);
  assert.deepEqual(art["wuthering|Test Banner"], { image: THUMB, checkedAt: NOW });
});

test("подстановка: только пустые картинки, тот же объект, если подставлять нечего", () => {
  const hub = {
    version: 2,
    updatedAt: NOW,
    games: [],
    codes: [],
    banners: [banner(), banner({ title: "Own Art", image: "https://example.test/own.png" }), banner({ title: "Nothing Found" })],
    videos: [],
  } as unknown as HubData;
  const art: ArtMemory = {
    "wuthering|Test Banner": { image: THUMB, checkedAt: NOW },
    "wuthering|Own Art": { image: "https://example.test/other.png", checkedAt: NOW },
    "wuthering|Nothing Found": { image: null, checkedAt: NOW },
  };
  const filled = withArt(hub, art);
  assert.deepEqual(
    filled.banners.map((b) => b.image),
    [THUMB, "https://example.test/own.png", null],
  );
  assert.equal(hub.banners[0]!.image, null, "исходные данные не меняются");
  const ennead = { ...hub, banners: [banner({ url: ENNEAD_SOURCE })] } as HubData;
  assert.equal(withArt(ennead, art), ennead, "записи ennead.cc арт не получают");
  assert.equal(withArt(hub, {}), hub);
});

// Число запросов за прогон не растёт вместе с числом баннеров без картинки.

test("за прогон проверяется не больше 20 баннеров, остальные — в следующие прогоны", async () => {
  assert.equal(MAX_ART_LOOKUPS_PER_RUN, 20);
  const banners = Array.from({ length: 100 }, (_, i) => banner({ title: `Synthetic ${i}` }));
  const wiki = fakeWiki({}, {});
  const art: ArtMemory = {};
  await refreshArt(wiki.http, banners, art, NOW);
  assert.equal(wiki.urls.length, 20, "двадцать запросов — по одному на баннер");
  assert.equal(Object.keys(art).length, 20, "остальные не запомнены и будут проверены следующим прогоном");
  for (let run = 0; run < 4; run++) await refreshArt(wiki.http, banners, art, NOW);
  assert.equal(wiki.urls.length, 100);
  assert.equal(new Set(wiki.urls).size, 100, "каждый баннер ровно один раз");
  assert.equal(Object.keys(art).length, 100);
});

test("баннеры, не требующие запроса, предел проверок не занимают", async () => {
  const wiki = fakeWiki({}, {});
  const skipped = Array.from({ length: 30 }, (_, i) => banner({ title: `Skip #${i}` })); // вики такое имя файла не примет
  const art: ArtMemory = {};
  await refreshArt(wiki.http, [...skipped, ...Array.from({ length: 25 }, (_, i) => banner({ title: `Real ${i}` }))], art, NOW);
  assert.equal(wiki.urls.length, 20);
});

for (const [name, makeError] of [
  ["таймаут", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
  ["обрыв соединения", () => new TypeError("fetch failed", { cause: new Error("ECONNRESET") })],
] as const) {
  test(`сбой связи (${name}) останавливает поиск арта: следующих баннеров вики не спрашивают`, async () => {
    const urls: string[] = [];
    const http: Http = {
      async get(url) {
        urls.push(url);
        throw makeError();
      },
    };
    const art: ArtMemory = {};
    const warnings = await refreshArt(http, [banner({ title: "A" }), banner({ title: "B" }), banner({ title: "C" })], art, NOW);
    assert.equal(urls.length, 1, "после первого сбоя запросов больше нет");
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /wuthering\|A/);
    assert.deepEqual(Object.keys(art), ["wuthering|A"], "остальные баннеры проверит следующий прогон");
    assert.deepEqual(art["wuthering|A"], { image: null, checkedAt: NOW }, "у баннера со сбоем срок повтора обычный, иначе он держал бы очередь вечно");
  });
}

test("ответ с кодом 404 по одному баннеру поиск не останавливает", async () => {
  const urls: string[] = [];
  const http: Http = {
    async get(url) {
      urls.push(url);
      throw new StatusError(404, url);
    },
  };
  const art: ArtMemory = {};
  const warnings = await refreshArt(http, [banner({ title: "A" }), banner({ title: "B" }), banner({ title: "C" })], art, NOW);
  assert.equal(urls.length, 3);
  assert.equal(warnings.length, 3);
});
