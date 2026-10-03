import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerTitleOk, codeOk, featuredNameOk, validateHub } from "../src/validate.ts";
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
