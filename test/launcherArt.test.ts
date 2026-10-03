import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusError, type Http, type HttpResponse } from "../src/http.ts";
import { HOYOPLAY_URL, fetchLauncherArt, parseHoyoplayArt, withLauncherArt } from "../src/sources/launcherArt.ts";
import { emptyMemory } from "../src/sources/registry.ts";
import type { HubData } from "../src/types.ts";

const IMG = (name: string) => `https://cdn.example.test/bg/${name}.webp`;
const VID = (name: string) => `https://cdn.example.test/bg/${name}.webm`;

const entry = (biz: string, backgrounds: unknown[]) => ({ game: { biz, id: "x" }, backgrounds });
const video = (name: string) => ({ type: "BACKGROUND_TYPE_VIDEO", background: { url: IMG(name) }, video: { url: VID(name) }, theme: { url: IMG(`${name}-theme`) } });
const still = (name: string) => ({ type: "BACKGROUND_TYPE_UNSPECIFIED", background: { url: IMG(name) }, video: { url: "" } });
const reply = (list: unknown[]) => ({ retcode: 0, message: "OK", data: { game_info_list: list } });

test("первый фон каждой из трёх игр: картинка и видео только у видеофона", () => {
  const art = parseHoyoplayArt(
    reply([
      entry("hk4e_global", [video("g1"), still("g2")]),
      entry("hkrpg_global", [still("h1")]),
      entry("nap_global", [video("z1")]),
      entry("bh3_global", [video("b1")]),
    ]),
  );
  assert.deepEqual(art, {
    genshin: { image: IMG("g1"), video: VID("g1") },
    hsr: { image: IMG("h1") },
    zzz: { image: IMG("z1"), video: VID("z1") },
  });
});

test("негодная картинка — у игры нет фона; негодное видео — остаётся одна картинка", () => {
  const art = parseHoyoplayArt(
    reply([
      entry("hk4e_global", [{ type: "BACKGROUND_TYPE_UNSPECIFIED", background: { url: "http://cdn.example.test/bg/g.webp" } }]),
      entry("hkrpg_global", [{ type: "BACKGROUND_TYPE_UNSPECIFIED", background: { url: "https://cdn.example.test/bg/h.svg" } }]),
      entry("nap_global", [{ type: "BACKGROUND_TYPE_VIDEO", background: { url: IMG("z") }, video: { url: "https://cdn.example.test/bg/z.mov" } }]),
    ]),
  );
  assert.deepEqual(art, { zzz: { image: IMG("z") } });
});

test("пустые фоны, чужие и подставные biz пропускаются", () => {
  const art = parseHoyoplayArt(reply([entry("hk4e_global", []), entry("toString", [video("t")]), entry("__proto__", [video("p")]), { game: null }]));
  assert.deepEqual(art, {});
});

test("ответ не той формы — null", () => {
  assert.equal(parseHoyoplayArt({ retcode: -1, data: { game_info_list: [] } }), null);
  assert.equal(parseHoyoplayArt({ retcode: 0, data: {} }), null);
  assert.equal(parseHoyoplayArt([]), null);
  assert.equal(parseHoyoplayArt(null), null);
});

function fakeHttp(replies: (HttpResponse | Error)[]) {
  const calls: string[] = [];
  const http: Http = {
    async get(url) {
      calls.push(url);
      const next = replies.shift();
      if (next === undefined) throw new Error("лишний запрос");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { http, calls };
}

const ok = (value: unknown, etag?: string): HttpResponse => ({ status: 200, body: JSON.stringify(value), validators: etag ? { etag } : {} });

test("200: фоны и метка ответа в памяти", async () => {
  const f = fakeHttp([ok(reply([entry("nap_global", [video("z1")])]), '"a1"')]);
  const memory = emptyMemory();
  memory.launcherArt = { genshin: { image: IMG("old") } };
  assert.deepEqual(await fetchLauncherArt(f.http, memory), { ok: true });
  assert.deepEqual(memory.launcherArt, { zzz: { image: IMG("z1"), video: VID("z1") } }, "игры, которой нет в ответе, больше нет");
  assert.deepEqual(memory.validators[HOYOPLAY_URL], { etag: '"a1"' });
  assert.equal(f.calls[0], HOYOPLAY_URL);
});

test("304 — без изменений; сбой, не та форма или ни одной игры — ошибка, прошлое остаётся", async () => {
  const memory = emptyMemory();
  memory.launcherArt = { hsr: { image: IMG("h") } };
  assert.deepEqual(await fetchLauncherArt(fakeHttp([{ status: 304, body: "", validators: {} }]).http, memory), { ok: true });
  assert.equal((await fetchLauncherArt(fakeHttp([new StatusError(500, HOYOPLAY_URL)]).http, memory)).ok, false);
  assert.deepEqual(await fetchLauncherArt(fakeHttp([ok({ retcode: -1 })]).http, memory), { ok: false, error: "ответ HoYoPlay не той формы" });
  assert.deepEqual(await fetchLauncherArt(fakeHttp([ok(reply([entry("bh3_global", [video("b")])]))]).http, memory), {
    ok: false,
    error: "в ответе HoYoPlay нет ни одной из трёх игр",
  });
  assert.deepEqual(memory.launcherArt, { hsr: { image: IMG("h") } });
});

test("фоны ставятся играм файла; без фонов — тот же объект", () => {
  const hub = {
    version: 2,
    updatedAt: 1,
    games: [{ id: "genshin", title: "G", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }, { id: "endfield", title: "E", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }],
    codes: [],
    banners: [],
    videos: [],
  } as HubData;
  const art = { genshin: { image: IMG("g"), video: VID("g") } };
  const filled = withLauncherArt(hub, art);
  assert.deepEqual(filled.games[0]!.background, { image: IMG("g"), video: VID("g") });
  assert.equal(filled.games[1]!.background, undefined);
  assert.equal(hub.games[0]!.background, undefined, "исходные данные не меняются");
  assert.equal(withLauncherArt(hub, {}), hub);
});

test("фон: картинка и видео с логином, портом или IP-адресом не годятся", () => {
  const unspecified = (url: string) => ({ type: "BACKGROUND_TYPE_UNSPECIFIED", background: { url } });
  const withVideo = (videoUrl: string) => ({ type: "BACKGROUND_TYPE_VIDEO", background: { url: IMG("z") }, video: { url: videoUrl } });
  for (const url of ["https://u:p@cdn.example.test/bg/a.webp", "https://cdn.example.test:8443/bg/a.webp", "https://192.168.1.1/bg/a.webp", "https://[::1]/bg/a.webp", "https://2130706433/bg/a.webp"]) {
    assert.deepEqual(parseHoyoplayArt(reply([entry("hk4e_global", [unspecified(url)])])), {}, `картинка ${url}`);
  }
  for (const url of ["https://u:p@cdn.example.test/bg/a.webm", "https://cdn.example.test:8443/bg/a.mp4", "https://192.168.1.1/bg/a.webm", "https://[::1]/bg/a.mp4"]) {
    assert.deepEqual(parseHoyoplayArt(reply([entry("nap_global", [withVideo(url)])])), { zzz: { image: IMG("z") } }, `видео ${url}`);
  }
});

test("фон: настоящие виды адресов HoYoPlay проходят", () => {
  const image = "https://launcher-webstatic.hoyoverse.com/launcher-public/2026/01/01/0123456789abcdef0123456789abcdef_1234567890123456789.webp";
  const video = "https://fastcdn.hoyoverse.com/static-resource-v2/2026/01/01/0123456789abcdef0123456789abcdef_1234567890123456789.mp4";
  const art = parseHoyoplayArt(reply([entry("hk4e_global", [{ type: "BACKGROUND_TYPE_VIDEO", background: { url: image }, video: { url: video } }])]));
  assert.deepEqual(art, { genshin: { image, video } });
});
