import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusError, type Http, type HttpResponse, type Redirects } from "../src/http.ts";
import { HOYOPLAY_URL } from "../src/sources/launcherArt.ts";
import { emptyMemory } from "../src/sources/registry.ts";
import {
  MANUAL_SOCIALS,
  contentUrl,
  fetchSocials,
  parseHoyoplayGameIds,
  SOCIAL_KINDS,
  SOCIALS_MAX,
  classifySocials,
  kindOfUrl,
  parseSocialLinks,
  socialsProblem,
  withSocials,
} from "../src/sources/socials.ts";
import type { HubData, Social } from "../src/types.ts";

const social = (kind: Social["kind"], url: string): Social => ({ kind, url });

// Ответ getGameContent в той форме, что у настоящего, с выдуманными адресами и номерами.
const linkEntry = (link: string) => ({ id: "a1", icon: { url: "https://cdn.example.test/i.png", link, login_state_in_link: false }, links: [] });
const hubEntry = (...links: string[]) => ({ id: "h1", icon: { url: "https://cdn.example.test/i.png", link: "" }, links: links.map((link) => ({ title: "t", link })) });
const reply = (list: unknown) => ({ retcode: 0, message: "OK", data: { content: { social_media_list: list } } });

/** Переходы коротких ссылок: адрес → куда ведёт; журнал запросов. Адрес вне таблицы — не перенаправление. */
function fakeRedirects(map: Record<string, string | Error | null>) {
  const calls: string[] = [];
  const redirects: Redirects = {
    async location(url) {
      calls.push(url);
      const target = map[url];
      if (target instanceof Error) throw target;
      return target ?? null;
    },
  };
  return { redirects, calls };
}

test("разбор ответа: запись-ссылка берёт icon.link, запись-хаб — первую из links[], порядок сохраняется", () => {
  const links = parseSocialLinks(
    reply([
      hubEntry("https://www.hoyolab.com/home?lang=ru-ru&utm_source=launcher", "https://act.hoyolab.com/x"),
      linkEntry("https://hoyo.link/aaaa1111"),
      linkEntry("https://www.youtube.com/@Example"),
    ]),
  );
  assert.deepEqual(links, ["https://www.hoyolab.com/home?lang=ru-ru&utm_source=launcher", "https://hoyo.link/aaaa1111", "https://www.youtube.com/@Example"]);
});

test("разбор ответа: пустая запись, мусор и негодные адреса пропускаются без ошибки", () => {
  const links = parseSocialLinks(
    reply([
      linkEntry(""),
      hubEntry(),
      null,
      "строка",
      7,
      [],
      { icon: null, links: null },
      { icon: { link: 5 }, links: [{ link: null }] },
      { icon: { link: "" }, links: [null] },
      linkEntry("http://hoyo.link/insecure"),
      linkEntry("https://u:p@hoyo.link/x"),
      linkEntry(`https://hoyo.link/${"a".repeat(600)}`),
      linkEntry("https://hoyo.link/ok0000"),
    ]),
  );
  assert.deepEqual(links, ["https://hoyo.link/ok0000"]);
});

test("разбор ответа: не та форма — null, пустой список — пустой список", () => {
  assert.equal(parseSocialLinks(null), null);
  assert.equal(parseSocialLinks("текст"), null);
  assert.equal(parseSocialLinks({ retcode: -1, data: { content: { social_media_list: [] } } }), null);
  assert.equal(parseSocialLinks({ retcode: 0, data: null }), null);
  assert.equal(parseSocialLinks({ retcode: 0, data: { content: {} } }), null);
  assert.equal(parseSocialLinks({ retcode: 0, data: { content: { social_media_list: {} } } }), null);
  assert.deepEqual(parseSocialLinks(reply([])), []);
});

test("kind по хосту: все хосты контракта, www и без; чужие и похожие — нет", () => {
  const table: [string, Social["kind"]][] = [
    ["https://www.hoyolab.com/home", "hoyolab"],
    ["https://hoyolab.com/home", "hoyolab"],
    ["https://genshin.hoyoverse.com/", "site"],
    ["https://hsr.hoyoverse.com/", "site"],
    ["https://zenless.hoyoverse.com/", "site"],
    ["https://wutheringwaves.kurogames.com/", "site"],
    ["https://endfield.gryphline.com/", "site"],
    ["https://www.youtube.com/@a", "youtube"],
    ["https://youtube.com/@a", "youtube"],
    ["https://x.com/a", "x"],
    ["https://twitter.com/a", "x"],
    ["https://discord.gg/a", "discord"],
    ["https://discord.com/invite/a", "discord"],
    ["https://www.reddit.com/r/a", "reddit"],
    ["https://www.facebook.com/a", "facebook"],
    ["https://www.instagram.com/a", "instagram"],
    ["https://www.tiktok.com/@a", "tiktok"],
    ["https://t.me/a", "telegram"],
    ["https://vk.com/a", "vk"],
    ["https://m.vk.com/a", "vk"],
  ];
  for (const [url, kind] of table) assert.equal(kindOfUrl(url), kind, url);
  for (const url of [
    "https://m.me/a",
    "https://wa.me/1",
    "https://api.whatsapp.com/send",
    "https://skport.com/",
    "https://t.me.evil.example/a",
    "https://evil-vk.com/a",
    "https://vk.com.evil.example/a",
    "https://reddit.com/r/a",
    "https://old.reddit.com/r/a",
    "https://hoyo.link/abc",
    "not a url",
  ]) {
    assert.equal(kindOfUrl(url), null, url);
  }
});

test("классификация: прямой адрес — kind по хосту без запроса; короткая ссылка — по тому, куда она ведёт, url остаётся исходный", async () => {
  const f = fakeRedirects({
    "https://hoyo.link/aaaa1111": "https://vk.com/example",
    "https://hoyo.link/bbbb2222": "https://t.me/example?x=1",
    "https://hoyo.link/cccc3333": "https://www.youtube.com/@example",
  });
  const list = await classifySocials(f.redirects, [
    "https://www.hoyolab.com/home?lang=ru-ru&utm_source=launcher",
    "https://hoyo.link/aaaa1111",
    "https://x.com/example",
    "https://hoyo.link/bbbb2222",
    "https://hoyo.link/cccc3333",
  ]);
  assert.deepEqual(list, [
    social("hoyolab", "https://www.hoyolab.com/home?lang=ru-ru&utm_source=launcher"),
    social("vk", "https://hoyo.link/aaaa1111"),
    social("x", "https://x.com/example"),
    social("telegram", "https://hoyo.link/bbbb2222"),
    social("youtube", "https://hoyo.link/cccc3333"),
  ]);
  assert.deepEqual(f.calls, ["https://hoyo.link/aaaa1111", "https://hoyo.link/bbbb2222", "https://hoyo.link/cccc3333"], "запросы только за короткими ссылками, по порядку");
});

test("классификация: чужой хост, WhatsApp, Messenger, не перенаправление и неясный адрес — запись пропускается, ошибки нет", async () => {
  const f = fakeRedirects({
    "https://hoyo.link/wa000001": "https://api.whatsapp.com/send?phone=1",
    "https://hoyo.link/msg00002": "https://m.me/example",
    "https://hoyo.link/gone0003": "https://webstatic.hoyoverse.com/short_link/404_v2.html",
    "https://hoyo.link/rel00004": "/relative/path",
    "https://hoyo.link/http0005": "http://vk.com/example",
    "https://hoyo.link/ok000006": "https://vk.com/example",
    "https://hoyo.link/none0007": null,
  });
  const list = await classifySocials(f.redirects, [
    "https://hoyo.link/wa000001",
    "https://m.me/example",
    "https://wa.me/1",
    "https://hoyo.link/msg00002",
    "https://hoyo.link/gone0003",
    "https://hoyo.link/rel00004",
    "https://hoyo.link/http0005",
    "https://hoyo.link/none0007",
    "https://hoyo.link/ok000006",
    "https://hoyo.link.evil.example/x",
  ]);
  assert.deepEqual(list, [social("vk", "https://hoyo.link/ok000006")]);
  assert.ok(!f.calls.includes("https://m.me/example") && !f.calls.includes("https://hoyo.link.evil.example/x"), "чужие хосты не спрашиваются");
});

test("классификация: повторы убираются, не больше десяти записей, лишние короткие ссылки не спрашиваются", async () => {
  const map: Record<string, string> = {};
  const urls: string[] = [];
  for (let i = 0; i < 14; i++) {
    const short = `https://hoyo.link/code${String(i).padStart(4, "0")}`;
    map[short] = `https://vk.com/g${i}`;
    urls.push(short, short);
  }
  const f = fakeRedirects(map);
  const list = await classifySocials(f.redirects, urls);
  assert.equal(list.length, SOCIALS_MAX);
  assert.deepEqual(
    list.map((s) => s.url),
    urls.filter((_, i) => i % 2 === 0).slice(0, SOCIALS_MAX),
  );
  assert.equal(f.calls.length, SOCIALS_MAX, "по одному запросу на каждую и ни одного сверх десяти");
});

test("классификация: сбой запроса уходит наверх, остаток не спрашивается", async () => {
  const f = fakeRedirects({ "https://hoyo.link/aaaa1111": new TypeError("fetch failed") });
  await assert.rejects(classifySocials(f.redirects, ["https://hoyo.link/aaaa1111", "https://hoyo.link/bbbb2222"]), /fetch failed/);
  assert.deepEqual(f.calls, ["https://hoyo.link/aaaa1111"]);
});

test("проверка списков: хороший файл, любой kind у hoyo.link, пустой объект и языки", () => {
  assert.equal(socialsProblem({ ru: [social("vk", "https://hoyo.link/aaaa1111"), social("youtube", "https://www.youtube.com/@a")], en: [social("x", "https://twitter.com/a")] }), null);
  for (const kind of SOCIAL_KINDS) assert.equal(socialsProblem({ en: [social(kind, "https://hoyo.link/aaaa1111")] }), null, kind);
  assert.notEqual(socialsProblem({}), null, "нет ни одного списка — поля быть не должно");
  assert.notEqual(socialsProblem({ ru: [] }), null, "пустой список — ключа быть не должно");
  assert.notEqual(socialsProblem({ de: [social("vk", "https://vk.com/a")] }), null, "только ru и en");
  assert.notEqual(socialsProblem({ ru: [social("vk", "https://vk.com/a")], ja: [] }), null);
  for (const value of [null, [], "x", 5, { ru: "x" }, { ru: [null] }, { ru: ["https://vk.com/a"] }]) assert.notEqual(socialsProblem(value), null, JSON.stringify(value));
});

test("проверка списков: kind не из списка, хост не к kind, плохой адрес, длина, повторы и больше десяти", () => {
  const bad: unknown[] = [
    { ru: [{ kind: "whatsapp", url: "https://wa.me/1" }] },
    { ru: [{ kind: "VK", url: "https://vk.com/a" }] },
    { ru: [{ kind: "shop", url: "https://store.example.test/a" }] },
    { ru: [social("youtube", "https://x.com/a")] },
    { ru: [social("vk", "https://vk.com.evil.example/a")] },
    { ru: [social("reddit", "https://reddit.com/r/a")] },
    { ru: [social("vk", "http://vk.com/a")] },
    { ru: [social("vk", "https://u:p@vk.com/a")] },
    { ru: [social("vk", "https://vk.com:8443/a")] },
    { ru: [social("vk", "https://vk.com/a b")] },
    { ru: [social("vk", "https://vk.com/a/../b")] },
    { ru: [social("vk", `https://vk.com/${"a".repeat(500)}`)] },
    { ru: [social("vk", "https://vk.com/a"), social("vk", "https://vk.com/a")] },
    { ru: Array.from({ length: SOCIALS_MAX + 1 }, (_, i) => social("vk", `https://vk.com/g${i}`)) },
    { ru: [{ kind: "vk" }] },
    { ru: [{ url: "https://vk.com/a" }] },
    { ru: [{ kind: "vk", url: 5 }] },
  ];
  for (const value of bad) assert.notEqual(socialsProblem(value), null, JSON.stringify(value).slice(0, 100));
  assert.equal(socialsProblem({ ru: [social("vk", `https://vk.com/${"a".repeat(512 - "https://vk.com/".length)}`)] }), null, "ровно 512 знаков проходит");
  assert.notEqual(socialsProblem({ ru: [social("vk", `https://vk.com/${"a".repeat(513 - "https://vk.com/".length)}`)] }), null, "513 — уже нет");
  assert.equal(socialsProblem({ ru: Array.from({ length: SOCIALS_MAX }, (_, i) => social("vk", `https://vk.com/g${i}`)) }), null, "ровно десять проходит");
});

test("ручные списки Wuthering Waves и Endfield проходят проверку и совпадают с официальными сайтами", () => {
  const { wuthering, endfield } = MANUAL_SOCIALS;
  assert.equal(socialsProblem(wuthering), null);
  assert.equal(socialsProblem(endfield), null);
  assert.deepEqual(wuthering.ru, wuthering.en, "у Wuthering Waves русской версии сайта нет — один список на оба языка");
  assert.deepEqual(wuthering.en?.map((s) => s.kind), ["x", "facebook", "youtube", "discord", "reddit", "instagram", "tiktok"]);
  assert.deepEqual(endfield.ru?.map((s) => s.kind), ["vk", "telegram", "discord"]);
  assert.deepEqual(endfield.en?.map((s) => s.kind), ["x", "tiktok", "facebook", "youtube", "discord", "instagram"]);
  assert.notDeepEqual(endfield.ru, endfield.en);
  assert.deepEqual(endfield.ru?.map((s) => s.url), ["https://vk.com/akendfieldru", "https://t.me/AKEndfieldRU", "https://discord.gg/akendfield"]);
  assert.equal(wuthering.en?.[0]?.url, "https://twitter.com/Wuthering_Waves");
  assert.equal(endfield.en?.[3]?.url, "https://www.youtube.com/channel/UCowPaVRBzg8CE6K4CB6LJfw");
  const all = [...(wuthering.ru ?? []), ...(wuthering.en ?? []), ...(endfield.ru ?? []), ...(endfield.en ?? [])];
  assert.ok(all.every((s) => !/whatsapp|wa\.me|skport/i.test(s.url)));
});

type Game = HubData["games"][number];
const game = (id: Game["id"]): Game => ({ id, title: id, match: { steamAppIds: [], epicAppNames: [], folderNames: [] } });
const hubOf = (...ids: Game["id"][]): HubData => ({ version: 2, updatedAt: 1, games: ids.map(game), codes: [], banners: [], videos: [] });

test("соцсети ставятся играм файла: из памяти — играм HoYoPlay, ручные — Wuthering Waves и Endfield; нечего ставить — тот же объект", () => {
  const hub = hubOf("genshin", "hsr", "wuthering", "endfield");
  const memory = { genshin: { ru: [social("vk", "https://hoyo.link/aaaa1111")] } };
  const filled = withSocials(hub, memory);
  assert.deepEqual(filled.games[0]!.socials, { ru: [social("vk", "https://hoyo.link/aaaa1111")] });
  assert.equal(filled.games[1]!.socials, undefined, "по Star Rail в памяти пока ничего нет");
  assert.deepEqual(filled.games[2]!.socials, MANUAL_SOCIALS.wuthering);
  assert.deepEqual(filled.games[3]!.socials, MANUAL_SOCIALS.endfield);
  assert.equal(hub.games[0]!.socials, undefined, "исходные данные не меняются");
  const hoyoOnly = hubOf("genshin", "hsr", "zzz");
  assert.equal(withSocials(hoyoOnly, {}), hoyoOnly);
});

test("соцсети: память без списков не создаёт поле", () => {
  const hub = hubOf("zzz");
  assert.equal(withSocials(hub, { zzz: {} }), hub);
});

// Сбор целиком: ответы HoYoPlay подменяются, настоящих запросов нет.

const basicInfo = (...entries: [string, string][]) => ({ retcode: 0, message: "OK", data: { game_info_list: entries.map(([biz, id]) => ({ game: { biz, id } })) } });
const IDS = basicInfo(["hk4e_global", "gid-genshin"], ["hkrpg_global", "gid-hsr"], ["nap_global", "gid-zzz"], ["bh3_global", "gid-honkai"]);
const GAMES = ["genshin", "hsr", "zzz"] as const;
const body = (value: unknown): HttpResponse => ({ status: 200, body: JSON.stringify(value), validators: {} });

/** Http по таблице «адрес → ответ или ошибка» и переходы коротких ссылок; журнал всех запросов подряд. */
function fakeNet(replies: Record<string, unknown>, redirectMap: Record<string, string | Error | null> = {}) {
  const calls: string[] = [];
  const http: Http = {
    async get(url, ...rest) {
      calls.push(url);
      assert.deepEqual(rest, [], "условные заголовки не нужны: тело нужно целиком");
      const next = replies[url];
      if (next instanceof Error) throw next;
      if (next === undefined) throw new StatusError(404, url);
      return body(next);
    },
  };
  const redirects: Redirects = {
    async location(url) {
      calls.push(url);
      const target = redirectMap[url];
      if (target instanceof Error) throw target;
      return target ?? null;
    },
  };
  return { net: { ...http, ...redirects }, calls };
}

/** Ответ getGameContent из одних прямых ссылок. */
const content = (...links: string[]) => reply(links.map((link) => linkEntry(link)));
const allReplies = (): Record<string, unknown> => {
  const replies: Record<string, unknown> = { [HOYOPLAY_URL]: IDS };
  for (const game of GAMES) {
    replies[contentUrl(`gid-${game}`, "ru-ru")] = content(`https://vk.com/${game}ru`, `https://t.me/${game}ru`);
    replies[contentUrl(`gid-${game}`, "en-us")] = content(`https://x.com/${game}en`);
  }
  return replies;
};

test("номера игр: по game.biz из getAllGameBasicInfo, чужие игры и мусор пропускаются; не та форма — null", () => {
  assert.deepEqual(parseHoyoplayGameIds(IDS), { genshin: "gid-genshin", hsr: "gid-hsr", zzz: "gid-zzz" });
  assert.deepEqual(parseHoyoplayGameIds({ retcode: 0, data: { game_info_list: [null, {}, { game: { biz: "nap_global", id: 5 } }, { game: { biz: "nap_global", id: "" } }] } }), {});
  assert.equal(parseHoyoplayGameIds({ retcode: 1, data: { game_info_list: [] } }), null);
  assert.equal(parseHoyoplayGameIds({ retcode: 0, data: {} }), null);
  assert.equal(parseHoyoplayGameIds("x"), null);
});

test("адрес getGameContent: лаунчер, номер игры и язык", () => {
  assert.equal(
    contentUrl("gid-zzz", "ru-ru"),
    "https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api/getGameContent?launcher_id=VYTpXlbWo8&game_id=gid-zzz&language=ru-ru",
  );
});

test("сбор: три игры на двух языках, запросы подряд, соцсети в памяти по играм и языкам", async () => {
  const f = fakeNet(allReplies());
  const memory = emptyMemory();
  assert.deepEqual(await fetchSocials(f.net, memory), { ok: true });
  assert.deepEqual(memory.socials.genshin, { ru: [social("vk", "https://vk.com/genshinru"), social("telegram", "https://t.me/genshinru")], en: [social("x", "https://x.com/genshinen")] });
  assert.deepEqual(Object.keys(memory.socials), ["genshin", "hsr", "zzz"]);
  assert.deepEqual(f.calls, [HOYOPLAY_URL, ...GAMES.flatMap((game) => [contentUrl(`gid-${game}`, "ru-ru"), contentUrl(`gid-${game}`, "en-us")])]);
});

test("сбор: короткие ссылки определяются по переходу, запросы за ними идут подряд внутри списка", async () => {
  const replies = allReplies();
  replies[contentUrl("gid-hsr", "ru-ru")] = reply([hubEntry("https://www.hoyolab.com/home?lang=ru-ru"), linkEntry("https://hoyo.link/aaaa1111"), linkEntry("https://hoyo.link/wa000002")]);
  const f = fakeNet(replies, { "https://hoyo.link/aaaa1111": "https://discord.com/invite/example", "https://hoyo.link/wa000002": "https://api.whatsapp.com/send" });
  const memory = emptyMemory();
  assert.deepEqual(await fetchSocials(f.net, memory), { ok: true });
  assert.deepEqual(memory.socials.hsr!.ru, [social("hoyolab", "https://www.hoyolab.com/home?lang=ru-ru"), social("discord", "https://hoyo.link/aaaa1111")]);
  const at = f.calls.indexOf(contentUrl("gid-hsr", "ru-ru"));
  assert.deepEqual(f.calls.slice(at, at + 3), [contentUrl("gid-hsr", "ru-ru"), "https://hoyo.link/aaaa1111", "https://hoyo.link/wa000002"]);
});

test("сбор: сбой одного списка оставляет его прошлое значение, остальные обновляются, итог — ошибка", async () => {
  const replies = allReplies();
  replies[contentUrl("gid-genshin", "en-us")] = new StatusError(500, "x");
  replies[contentUrl("gid-hsr", "ru-ru")] = { retcode: -1 };
  replies[contentUrl("gid-zzz", "en-us")] = reply([linkEntry("https://wa.me/1"), linkEntry("")]);
  const f = fakeNet(replies);
  const memory = emptyMemory();
  const old = { ru: [social("vk", "https://vk.com/old")], en: [social("x", "https://x.com/old")] };
  memory.socials = { genshin: structuredClone(old), hsr: structuredClone(old), zzz: structuredClone(old) };
  const result = await fetchSocials(f.net, memory);
  assert.equal(result.ok, false);
  const error = (result as { error: string }).error;
  assert.match(error, /genshin\/en/);
  assert.match(error, /hsr\/ru/);
  assert.match(error, /zzz\/en/);
  assert.deepEqual(memory.socials.genshin, { ru: [social("vk", "https://vk.com/genshinru"), social("telegram", "https://t.me/genshinru")], en: old.en });
  assert.deepEqual(memory.socials.hsr, { ru: old.ru, en: [social("x", "https://x.com/hsren")] });
  assert.deepEqual(memory.socials.zzz, { ru: [social("vk", "https://vk.com/zzzru"), social("telegram", "https://t.me/zzzru")], en: old.en }, "ни одной подходящей записи — не повод стирать прошлое");
  assert.equal(f.calls.length, 7, "запросы шли дальше после сбоя ответа, без повторов в цикле");
});

test("сбор: сбой связи останавливает всё, остальные списки ждут следующего прогона", async () => {
  const replies = allReplies();
  replies[contentUrl("gid-genshin", "en-us")] = new TypeError("fetch failed");
  const f = fakeNet(replies);
  const memory = emptyMemory();
  const result = await fetchSocials(f.net, memory);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(memory.socials), ["genshin"]);
  assert.deepEqual(Object.keys(memory.socials.genshin!), ["ru"]);
  assert.deepEqual(f.calls, [HOYOPLAY_URL, contentUrl("gid-genshin", "ru-ru"), contentUrl("gid-genshin", "en-us")]);

  const slowShort = allReplies();
  slowShort[contentUrl("gid-genshin", "ru-ru")] = content("https://hoyo.link/aaaa1111");
  const g = fakeNet(slowShort, { "https://hoyo.link/aaaa1111": new DOMException("timeout", "TimeoutError") });
  const other = emptyMemory();
  assert.equal((await fetchSocials(g.net, other)).ok, false);
  assert.deepEqual(other.socials, {});
  assert.equal(g.calls.length, 3, "после зависшей короткой ссылки больше никуда не ходим");
});

test("сбор: сбой списка игр, не та форма и ни одной из трёх игр — ошибка, прошлое остаётся", async () => {
  const memory = emptyMemory();
  memory.socials = { zzz: { en: [social("x", "https://x.com/old")] } };
  const before = structuredClone(memory.socials);
  assert.equal((await fetchSocials(fakeNet({ [HOYOPLAY_URL]: new StatusError(500, HOYOPLAY_URL) }).net, memory)).ok, false);
  assert.deepEqual(await fetchSocials(fakeNet({ [HOYOPLAY_URL]: { retcode: -1 } }).net, memory), { ok: false, error: "ответ HoYoPlay не той формы" });
  assert.deepEqual(await fetchSocials(fakeNet({ [HOYOPLAY_URL]: basicInfo(["bh3_global", "x"]) }).net, memory), {
    ok: false,
    error: "в ответе HoYoPlay нет ни одной из трёх игр",
  });
  assert.deepEqual(memory.socials, before);
});
