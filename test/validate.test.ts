import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerTitleOk, codeOk, featuredNameOk, isPublicHttpsUrl, validateHub, videoTitleOk } from "../src/validate.ts";
import type { HubData } from "../src/types.ts";

const good = (): HubData => ({
  version: 2,
  updatedAt: 1_788_000_000,
  games: [{ id: "hsr", title: "Honkai: Star Rail", redeemUrl: "https://hsr.hoyoverse.com/gift?code={code}", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }],
  codes: [{ gameId: "hsr", code: "ABCD1234", rewards: "Stellar Jade ×50", expiresAt: null, region: "all", source: "https://honkai-star-rail.fandom.com/wiki/Redemption_Code" }],
  banners: [{ gameId: "hsr", title: "Over the Gilded Tides", featured: ["Aventurine"], rarity: 5, image: "https://static.wikia.nocookie.net/a.png", startsAt: 1, endsAt: 2, url: "https://honkai-star-rail.fandom.com/wiki/X" }],
  videos: [{ gameId: "hsr", lang: "en", title: "Trailer", url: "https://www.youtube.com/watch?v=abc", thumb: "https://i1.ytimg.com/vi/abc/hqdefault.jpg", publishedAt: 5, duration: null, premiere: false }],
});

test("правильный файл проходит", () => {
  assert.deepEqual(validateHub(good()), []);
});

test("ошибки называют путь к полю", () => {
  const hub = good();
  hub.codes[0]!.code = "BAD CODE";
  hub.banners[0]!.endsAt = 1;
  hub.banners[0]!.image = "http://insecure/a.png";
  hub.videos[0]!.url = "https://evil.example/watch";
  const errors = validateHub(hub);
  assert.ok(errors.some((e) => e.startsWith("codes[0].code")));
  assert.ok(errors.some((e) => e.startsWith("banners[0].endsAt")));
  assert.ok(errors.some((e) => e.startsWith("banners[0].image")));
  assert.ok(errors.some((e) => e.startsWith("videos[0].url")));
});

test("запись чужой игры и повтор игры в каталоге", () => {
  const hub = good();
  hub.codes[0]!.gameId = "genshin";
  hub.games.push({ ...hub.games[0]! });
  const errors = validateHub(hub);
  assert.ok(errors.some((e) => e.startsWith("codes[0].gameId")));
  assert.ok(errors.some((e) => e.startsWith("games[1].id")));
});

test("адрес погашения без {code} и не https", () => {
  const hub = good();
  hub.games[0]!.redeemUrl = "http://hsr.hoyoverse.com/gift";
  assert.ok(validateHub(hub).some((e) => e.startsWith("games[0].redeemUrl")));
});

test("больше шести видео у игры", () => {
  const hub = good();
  hub.videos = Array.from({ length: 7 }, (_, i) => ({ ...hub.videos[0]!, publishedAt: i }));
  assert.ok(validateHub(hub).some((e) => e.startsWith("videos: у hsr")));
});

test("файл больше потолка", () => {
  assert.ok(validateHub(good(), 100).some((e) => e.startsWith("файл:")));
});

test("не больше пятидесяти ошибок", () => {
  const hub = good();
  hub.codes = Array.from({ length: 80 }, () => ({ ...hub.codes[0]!, code: "!" }));
  assert.equal(validateHub(hub).length, 50);
});

test("странные значения не вызывают исключение", () => {
  const hub = {
    version: 2,
    updatedAt: 1_788_000_000,
    games: [{ id: "hsr", title: "Test", redeemUrl: null as unknown, match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }],
    codes: [{ gameId: "hsr", code: 42 as unknown, rewards: "Test", expiresAt: null, region: "all", source: null }],
    banners: [{ gameId: "hsr", title: "Test", featured: [null] as unknown, rarity: null, image: null, startsAt: 1, endsAt: 2, url: null }],
    videos: [{ gameId: "hsr", lang: "en", title: "Test", url: null as unknown, thumb: null, publishedAt: 5, duration: null, premiere: false }],
  } as unknown as HubData;
  const errors = validateHub(hub);
  assert.ok(errors.some((e) => e.startsWith("games[0].redeemUrl")));
  assert.ok(errors.some((e) => e.startsWith("codes[0].code")));
  assert.ok(errors.some((e) => e.startsWith("banners[0].featured")));
  assert.ok(errors.some((e) => e.startsWith("videos[0].url")));
});

test("видео: язык обязателен, лимит шесть на игру и язык", () => {
  const v = (n: number, lang: unknown) => ({ gameId: "hsr", lang, title: `V${n}`, url: `https://www.youtube.com/watch?v=${n}`, thumb: null, publishedAt: n, duration: null, premiere: false });
  const base = good();
  const twelve = { ...base, videos: [...[1, 2, 3, 4, 5, 6].map((n) => v(n, "en")), ...[7, 8, 9, 10, 11, 12].map((n) => v(n, "ja"))] } as unknown as HubData;
  assert.deepEqual(validateHub(twelve), []);
  const sevenEn = { ...base, videos: [1, 2, 3, 4, 5, 6, 7].map((n) => v(n, "en")) } as unknown as HubData;
  assert.ok(validateHub(sevenEn).some((e) => e.includes("hsr:en")));
  const noLang = { ...base, videos: [v(1, undefined)] } as unknown as HubData;
  assert.ok(validateHub(noLang).some((e) => e.includes("lang")));
  const odd = { ...base, videos: [v(1, "fr")] } as unknown as HubData;
  assert.ok(validateHub(odd).some((e) => e.includes("lang")));
});

test("поле app: необязательное, три числа через точку и https", () => {
  const hub = good();
  hub.app = { version: "0.1.1", url: "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.1" };
  assert.deepEqual(validateHub(hub), []);
  hub.app = { version: "0.1", url: "http://github.com/x" };
  const errors = validateHub(hub);
  assert.ok(errors.some((e) => e.startsWith("app.version")));
  assert.ok(errors.some((e) => e.startsWith("app.url")));
});

test("фон игры: необязателен, картинка и видео — https нужного вида", () => {
  const hub = good();
  hub.games[0]!.background = { image: "https://cdn.example.test/a.webp", video: "https://cdn.example.test/a.webm" };
  assert.deepEqual(validateHub(hub), []);
  hub.games[0]!.background = { image: "https://cdn.example.test/a.webp" };
  assert.deepEqual(validateHub(hub), []);
  hub.games[0]!.background = { image: "http://cdn.example.test/a.webp", video: "https://cdn.example.test/a.mov" };
  const errors = validateHub(hub);
  assert.ok(errors.some((e) => e.startsWith("games[0].background.image")));
  assert.ok(errors.some((e) => e.startsWith("games[0].background.video")));
});

test("общие проверки записей: название баннера, имя персонажа, код", () => {
  assert.equal(bannerTitleOk("x"), true);
  assert.equal(bannerTitleOk("x".repeat(200)), true);
  assert.equal(bannerTitleOk(""), false);
  assert.equal(bannerTitleOk("   "), false, "из одних пробелов — пусто");
  assert.equal(bannerTitleOk("x".repeat(201)), false);
  assert.equal(featuredNameOk("x"), true);
  assert.equal(featuredNameOk("x".repeat(80)), true);
  assert.equal(featuredNameOk(""), false);
  assert.equal(featuredNameOk(" "), false);
  assert.equal(featuredNameOk("x".repeat(81)), false);
  assert.equal(codeOk("ABCD"), true);
  assert.equal(codeOk("a1".repeat(20)), true);
  assert.equal(codeOk("ABC"), false);
  assert.equal(codeOk("a1".repeat(20) + "z"), false);
  assert.equal(codeOk("AB CD"), false);
  assert.equal(codeOk(""), false);
});

test("validateHub пользуется теми же проверками: пустое название и пустое имя не проходят", () => {
  const hub = good();
  hub.banners[0]!.title = "  ";
  hub.banners[0]!.featured = [""];
  const errors = validateHub(hub);
  assert.ok(errors.some((e) => e.startsWith("banners[0].title")));
  assert.ok(errors.some((e) => e.startsWith("banners[0].featured")));
});

test("название ролика: от 0 до 300 знаков, и validateHub пользуется той же проверкой", () => {
  assert.equal(videoTitleOk(""), true);
  assert.equal(videoTitleOk("x".repeat(300)), true);
  assert.equal(videoTitleOk("x".repeat(301)), false);
  const hub = good();
  hub.videos[0]!.title = "x".repeat(301);
  assert.ok(validateHub(hub).some((e) => e.startsWith("videos[0].title")));
});

// Настоящие виды адресов из hub.json (идентификаторы выдуманы): ни один из них отвергаться не должен.
const REAL_URLS = [
  "https://genshin-impact.fandom.com/wiki/Example_Banner/2026-01-01",
  "https://wutheringwaves.fandom.com/wiki/Across_Time's_Waxes/2026-01-01",
  "https://honkai-star-rail.fandom.com/wiki/Redemption_Code",
  "https://zenless-zone-zero.fandom.com/wiki/Redemption_Code",
  "https://endfield.wiki.gg/wiki/Headhunting/Banners",
  "https://endfield.wiki.gg/images/thumb/Example_banner.png/400px-Example_banner.png?abc123",
  "https://static.wikia.nocookie.net/example-wiki/images/a/ab/Example_Banner_2026-01-01.png/revision/latest/scale-to-width-down/400?cb=20260101000000",
  "https://static.wikia.nocookie.net/example-wiki/images/6/64/Across_Time%27s_Waxes_2026-01-01.jpg/revision/latest/scale-to-width-down/400?cb=20260101000000",
  "https://fastcdn.hoyoverse.com/static-resource-v2/2026/01/01/0123456789abcdef0123456789abcdef_1234567890123456789.webp",
  "https://launcher-webstatic.hoyoverse.com/launcher-public/2026/01/01/0123456789abcdef0123456789abcdef_1234567890123456789.webp",
  "https://i1.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
  "https://i2.ytimg.com/vi/aaaa-bbbb_c/hqdefault.jpg",
  "https://i3.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
  "https://i4.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
  "https://www.youtube.com/watch?v=AAAAAAAAAAA",
  "https://www.youtube.com/shorts/AAAAAAAAAAA",
  "https://www.youtube.com/@ExampleChannel",
  "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.0",
  "https://github.com/torikushiii/hoyoverse-api",
  "https://wutheringwaves.kurogames.com/en/main/news/detail/1000001",
  "https://genshin.hoyoverse.com/en/gift?code={code}",
  "https://hsr.hoyoverse.com/gift?code={code}",
  "https://zenless.hoyoverse.com/redemption?code={code}",
];

const BS = String.fromCharCode(92);
const ch = (code: number) => String.fromCharCode(code);

// Каждый адрес — по одной причине отказа; причина названа рядом.
const REJECTED_URLS: [string, string][] = [
  ["http://example.org/x", "не https"],
  ["HTTPS://example.org/x", "схема не строчными буквами: приложение сравнивает строку как есть"],
  ["https:example.org/x", "нет двух косых черт"],
  ["//example.org/x", "нет схемы"],
  ["ftp://example.org/x", "чужая схема"],
  ["https://", "нет хоста"],
  ["", "пусто"],
  ["https://u:p@example.org/x", "логин и пароль"],
  ["https://u@example.org/x", "логин"],
  ["https://@example.org/x", "пустой логин: разбор его прячет"],
  ["https://example.org:8443/x", "порт"],
  ["https://example.org:443/x", "порт, даже обычный: разбор его прячет"],
  ["https://example.org:/x", "пустой порт: разбор его прячет"],
  ["https://192.168.1.1/x", "IPv4"],
  ["https://1.1.1.1/x", "IPv4 публичный: всё равно не имя"],
  ["https://2130706433/", "IPv4 числом: разбор превращает в 127.0.0.1"],
  ["https://0x7f.1/", "IPv4 в шестнадцатеричном виде"],
  ["https://0x7f000001/", "IPv4 одним шестнадцатеричным числом"],
  ["https://127.1/", "IPv4 в сокращённом виде"],
  ["https://017700000001/", "IPv4 в восьмеричном виде"],
  ["https://1.2.3.4./x", "IPv4 с точкой на конце"],
  ["https://[::1]/x", "IPv6"],
  ["https://[::ffff:127.0.0.1]/x", "IPv6 с вложенным IPv4"],
  ["https://example.org/a b", "пробел"],
  [`https://example.org/a${ch(9)}b`, "табуляция"],
  [`https://example.org/a${ch(10)}b`, "перевод строки"],
  [`https://example.org/a${ch(0xa0)}b`, "неразрывный пробел"],
  [`https://example.org/a${ch(0x2028)}b`, "разделитель строк"],
  [`https://example.org/a${ch(0)}b`, "управляющий знак NUL"],
  [`https://example.org/a${ch(0x7f)}b`, "управляющий знак DEL"],
  [`https://example.org/a${ch(0x85)}b`, "управляющий знак NEL"],
  [`https://example.org/a${ch(0x202e)}b`, "переключатель направления текста"],
  [`https://example.org/a${ch(0x200b)}b`, "нулевой пробел"],
  [`https://example.org${BS}@evil.example/x`, "обратная косая черта: разбор читает её как «/»"],
  [`https://example.org/a${BS}b`, "обратная косая черта в пути"],
  [`https://example.org/${"a".repeat(2048 - "https://example.org/".length + 1)}`, "2049 знаков"],
];

test("адрес: настоящие виды проходят", () => {
  for (const url of REAL_URLS) assert.equal(isPublicHttpsUrl(url), true, url);
});

test("адрес: каждая из причин отказа срабатывает", () => {
  for (const [url, why] of REJECTED_URLS) assert.equal(isPublicHttpsUrl(url), false, `${why}: ${JSON.stringify(url)}`);
  for (const value of [null, undefined, 42, {}, ["https://example.org/"]]) assert.equal(isPublicHttpsUrl(value), false);
});

test("адрес: длина ровно 2048 проходит, 2049 нет", () => {
  const base = "https://example.org/";
  assert.equal(isPublicHttpsUrl(base + "a".repeat(2048 - base.length)), true);
  assert.equal(isPublicHttpsUrl(base + "a".repeat(2049 - base.length)), false);
});

test("адрес: «@» и «:» в пути и запросе допустимы — смотрится только начало до первой косой черты", () => {
  assert.equal(isPublicHttpsUrl("https://example.org/@name"), true);
  assert.equal(isPublicHttpsUrl("https://example.org/a:b?x=y@z:1#f@g"), true);
  assert.equal(isPublicHttpsUrl("https://example.org?x=y@z"), true);
});

// По одному полю файла на каждую ссылку. bad — то, что обязано отвергнуться.
const URL_FIELDS: { path: string; set: (hub: HubData, url: string) => void; bad: string[] }[] = [
  {
    path: "games[0].redeemUrl",
    set: (h, u) => void (h.games[0]!.redeemUrl = u),
    bad: ["https://u:p@hsr.example.test/gift?code={code}", "https://hsr.example.test:8443/gift?code={code}", "https://10.0.0.1/gift?code={code}"],
  },
  {
    path: "games[0].background.image",
    set: (h, u) => void (h.games[0]!.background = { image: u }),
    bad: ["https://u:p@cdn.example.test/a.webp", "https://cdn.example.test:8443/a.webp", "https://192.168.1.1/a.webp", "https://[::1]/a.webp"],
  },
  {
    path: "games[0].background.video",
    set: (h, u) => void (h.games[0]!.background = { image: "https://cdn.example.test/a.webp", video: u }),
    bad: ["https://u:p@cdn.example.test/a.webm", "https://cdn.example.test:8443/a.webm", "https://192.168.1.1/a.mp4", "https://[::1]/a.mp4"],
  },
  {
    path: "codes[0].source",
    set: (h, u) => void (h.codes[0]!.source = u),
    bad: ["https://u:p@wiki.example.test/x", "https://wiki.example.test:8443/x", "https://192.168.1.1/x", "https://[::1]/x", "http://wiki.example.test/x"],
  },
  {
    path: "banners[0].image",
    set: (h, u) => void (h.banners[0]!.image = u),
    bad: ["https://u:p@cdn.example.test/a.png", "https://cdn.example.test:8443/a.png", "https://192.168.1.1/a.png", "https://[::1]/a.png", "https://cdn.example.test/a b.png"],
  },
  {
    path: "banners[0].url",
    set: (h, u) => void (h.banners[0]!.url = u),
    bad: ["https://u:p@wiki.example.test/x", "https://wiki.example.test:8443/x", "https://192.168.1.1/x", "https://[::1]/x", `https://wiki.example.test/${"a".repeat(2100)}`],
  },
  {
    // Начало «https://www.youtube.com/» уже отсекает чужой хост, порт и логин; общая проверка ловит остальное.
    path: "videos[0].url",
    set: (h, u) => void (h.videos[0]!.url = u),
    bad: ["https://www.youtube.com/watch?v=a b", `https://www.youtube.com/watch?v=${"a".repeat(2100)}`, "https://www.youtube.com/watch?v=a\tb"],
  },
  {
    path: "videos[0].thumb",
    set: (h, u) => void (h.videos[0]!.thumb = u),
    bad: ["https://u:p@i1.ytimg.com/vi/a/hqdefault.jpg", "https://i1.ytimg.com:8443/vi/a/hqdefault.jpg", "https://192.168.1.1/a.jpg", "https://[::1]/a.jpg"],
  },
  {
    path: "app.url",
    set: (h, u) => void (h.app = { version: "0.1.1", url: u }),
    bad: ["https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.1 x", `https://github.com/Ertezy/Kitsudock/releases/tag/${"a".repeat(2100)}`],
  },
];

test("validateHub: каждое поле со ссылкой отвергает логин, порт, IP-адрес, пробелы и лишнюю длину", () => {
  for (const field of URL_FIELDS) {
    for (const url of field.bad) {
      const hub = good();
      field.set(hub, url);
      assert.ok(
        validateHub(hub).some((e) => e.startsWith(field.path)),
        `${field.path} должно отвергать ${url.slice(0, 80)}`,
      );
    }
  }
});

test("validateHub: те же поля принимают настоящие адреса", () => {
  const hub = good();
  hub.games[0]!.redeemUrl = "https://hsr.hoyoverse.com/gift?code={code}";
  hub.games[0]!.background = {
    image: "https://launcher-webstatic.hoyoverse.com/launcher-public/2026/01/01/0123456789abcdef0123456789abcdef_1234567890123456789.webp",
    video: "https://fastcdn.hoyoverse.com/static-resource-v2/2026/01/01/0123456789abcdef0123456789abcdef_1234567890123456789.webm",
  };
  hub.codes[0]!.source = "https://honkai-star-rail.fandom.com/wiki/Redemption_Code";
  hub.banners[0]!.image =
    "https://static.wikia.nocookie.net/example-wiki/images/a/ab/Example_Banner_2026-01-01.png/revision/latest/scale-to-width-down/400?cb=20260101000000";
  hub.banners[0]!.url = "https://honkai-star-rail.fandom.com/wiki/Example_Banner/2026-01-01";
  hub.videos[0]!.url = "https://www.youtube.com/shorts/AAAAAAAAAAA";
  hub.videos[0]!.thumb = "https://i4.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg";
  hub.app = { version: "0.1.0", url: "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.0" };
  assert.deepEqual(validateHub(hub), []);
});

test("validateHub: app.url — только страница релизов Kitsudock на GitHub", () => {
  const hub = good();
  for (const url of [
    "https://github.com/someone-else/Kitsudock/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Other/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Kitsudock/issues/1",
    "https://github.com/Ertezy/Kitsudock/releases",
    "https://example.org/Ertezy/Kitsudock/releases/tag/v0.1.1",
    "https://github.com@example.org/Ertezy/Kitsudock/releases/tag/v0.1.1",
  ]) {
    hub.app = { version: "0.1.1", url };
    assert.ok(validateHub(hub).some((e) => e.startsWith("app.url")), url);
  }
  hub.app = { version: "0.1.1", url: "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.1" };
  assert.deepEqual(validateHub(hub), []);
});
