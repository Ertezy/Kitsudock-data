import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseFromPublished, emptyState, isDue, loadState, missingPrevious, pruneState, recordRun, runStatus, saveState } from "../src/state.ts";
import type { Failure } from "../src/issues.ts";
import { KURO_MENU_URL, kuroArticleUrl } from "../src/sources/kuro.ts";
import { KURO_SIGNAL } from "../src/sources/registry.ts";
import type { HubData, Item, SourceRun } from "../src/types.ts";

const NOW = 1_000_000;

test("пора ли опрашивать", () => {
  assert.equal(isDue(undefined, 6, NOW), true);
  assert.equal(isDue(NOW - 3600, 1, NOW), true);
  assert.equal(isDue(NOW - 3400, 1, NOW), true, "запуск сдвинулся на несколько минут");
  assert.equal(isDue(NOW - 3000, 1, NOW), false);
  assert.equal(isDue(NOW - 5 * 3600, 6, NOW), false);
});

test("isDue: ровно на границе запаса — уже пора, секундой раньше — ещё нет", () => {
  const everyHours = 2;
  const boundary = NOW - (everyHours * 3600 - 300);
  assert.equal(isDue(boundary, everyHours, NOW), true);
  assert.equal(isDue(boundary + 1, everyHours, NOW), false);
});

test("счётчик неудач", () => {
  const failures: Record<string, Failure> = {};
  recordRun(failures, "a", { kind: "broken", error: "503" }, NOW - 3600);
  recordRun(failures, "a", { kind: "broken", error: "429" }, NOW);
  assert.deepEqual(failures.a, { consecutive: 2, since: NOW - 3600, lastError: "429", lastAttempt: NOW });
  recordRun(failures, "a", { kind: "skipped" }, NOW + 1);
  assert.equal(failures.a?.consecutive, 2);
  recordRun(failures, "a", { kind: "unchanged" }, NOW + 2);
  assert.equal(failures.a, undefined);
});

test("счётчик неудач: успешный запуск (ok) тоже стирает запись", () => {
  const failures: Record<string, Failure> = { b: { consecutive: 3, since: NOW - 100, lastError: "x", lastAttempt: NOW - 50 } };
  recordRun(failures, "b", { kind: "ok", items: [], parsed: 1, dropped: 0 }, NOW);
  assert.equal(failures.b, undefined);
});

test("состояние сохраняется и читается; испорченное — null", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const state = emptyState();
  state.lastRun.x = NOW;
  saveState(state, path);
  assert.deepEqual(loadState(path), state);
  writeFileSync(path, "{broken");
  assert.equal(loadState(path), null);
  writeFileSync(path, JSON.stringify({ version: 99 }));
  assert.equal(loadState(path), null);
  assert.equal(loadState(join(dir, "missing.json")), null);
});

test("состояние без memory или с неполным memory считается отсутствующим", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ version: 1, base: null, published: null, lastPublishedAt: null, lastRun: {}, failures: {} }));
  assert.equal(loadState(path), null, "memory отсутствует целиком");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      base: null,
      published: null,
      lastPublishedAt: null,
      lastRun: {},
      failures: {},
      memory: { revisions: {}, pages: {}, validators: {} },
    }),
  );
  assert.equal(loadState(path), null, "у memory нет kuro");
});

test("состояние с испорченным base или published считается отсутствующим", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const valid = emptyState();
  writeFileSync(path, JSON.stringify({ ...valid, base: {} }));
  assert.equal(loadState(path), null, "base — не HubData");
  writeFileSync(path, JSON.stringify({ ...valid, published: { codes: [], banners: [] } }));
  assert.equal(loadState(path), null, "у published нет videos");
});

test("из выложенного файла убираются записи владельца", () => {
  const hub: HubData = {
    version: 2,
    updatedAt: NOW,
    games: [],
    codes: [
      { gameId: "hsr", code: "WIKICODE", rewards: "", expiresAt: null, region: "all", source: "https://wiki" },
      { gameId: "endfield", code: "OWNERCODE", rewards: "", expiresAt: null, region: "all", source: null },
    ],
    banners: [
      { gameId: "hsr", title: "Wiki", featured: [], rarity: 5, image: null, startsAt: 1, endsAt: 2, url: "https://wiki/b" },
      { gameId: "wuthering", title: "Owner", featured: [], rarity: 5, image: null, startsAt: 1, endsAt: 2, url: null },
    ],
    videos: [],
  };
  const base = baseFromPublished(hub);
  assert.deepEqual(base.codes.map((c) => c.code), ["WIKICODE"]);
  assert.deepEqual(base.banners.map((b) => b.title), ["Wiki"]);
});

test("baseFromPublished не трогает остальные поля файла", () => {
  const hub: HubData = {
    version: 2,
    updatedAt: 12345,
    games: [{ id: "genshin", title: "Genshin Impact", match: { steamAppIds: [], epicAppNames: [], folderNames: [] } }],
    codes: [],
    banners: [],
    videos: [{ gameId: "genshin", lang: "en", title: "T", url: "https://www.youtube.com/watch?v=1", thumb: null, publishedAt: 1, duration: null, premiere: false }],
  };
  const base = baseFromPublished(hub);
  assert.equal(base.version, 2);
  assert.equal(base.updatedAt, 12345);
  assert.deepEqual(base.games, hub.games);
  assert.deepEqual(base.videos, hub.videos);
});

test("без прошлых данных сломанный или пропущенный раздел — ошибка", () => {
  const runs = new Map<string, SourceRun<Item>>([
    ["genshin:codes", { kind: "broken", error: "503" }],
    ["genshin:banners", { kind: "skipped" }],
    ["hsr:codes", { kind: "ok", items: [], parsed: 1, dropped: 0 }],
  ]);
  const errors = missingPrevious(runs, false);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes("genshin:codes")));
  assert.ok(errors.some((e) => e.includes("genshin:banners")));
});

test("без прошлых данных, но запасной источник заполнил раздел — без ошибки", () => {
  const runs = new Map<string, SourceRun<Item>>([["genshin:codes", { kind: "ok", items: [], parsed: 1, dropped: 0 }]]);
  assert.deepEqual(missingPrevious(runs, false), []);
});

test("прошлые данные есть — сломанный или пропущенный раздел не страшен", () => {
  const runs = new Map<string, SourceRun<Item>>([
    ["genshin:codes", { kind: "broken", error: "503" }],
    ["genshin:banners", { kind: "skipped" }],
  ]);
  assert.deepEqual(missingPrevious(runs, true), []);
});

test("из состояния уходят записи об источниках, которых больше нет", () => {
  const state = emptyState();
  state.lastRun = { "genshin-videos": 1, "genshin-videos-en": 2, "wuthering-signal": 3 };
  state.failures = {
    "genshin-videos": { consecutive: 3, since: 1, lastError: "x", lastAttempt: 1 },
    "hsr-codes": { consecutive: 1, since: 2, lastError: "y", lastAttempt: 2 },
  };
  const removed = pruneState(state, new Set(["genshin-videos-en", "wuthering-signal", "hsr-codes"]));
  assert.deepEqual(removed, ["genshin-videos"]);
  assert.deepEqual(Object.keys(state.lastRun).sort(), ["genshin-videos-en", "wuthering-signal"]);
  assert.deepEqual(Object.keys(state.failures), ["hsr-codes"]);
  assert.deepEqual(pruneState(state, new Set(["genshin-videos-en", "wuthering-signal", "hsr-codes"])), []);
});

test("состояние прошлой версии без фактов Kuro загружается с пустыми умолчаниями, а меню будет прочитано заново", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const kuroMemory = { revisions: { a: 1 }, pages: {}, validators: { [KURO_MENU_URL]: { etag: '"k1"' }, other: { etag: '"o1"' } }, kuro: [] };
  writeFileSync(
    path,
    JSON.stringify({ version: 1, base: null, published: null, lastPublishedAt: null, lastRun: {}, failures: {}, memory: kuroMemory }),
  );
  const loaded = loadState(path);
  assert.ok(loaded);
  assert.deepEqual(loaded.memory.kuroFacts, {});
  assert.deepEqual(loaded.memory.kuroReleases, {});
  assert.deepEqual(loaded.memory.kuroPatchNotes, []);
  assert.deepEqual(loaded.memory.revisions, { a: 1 }, "остальная память на месте");
  // Без этого меню при ответе 304 оставило бы патчноуты неизвестными до следующего анонса.
  assert.deepEqual(loaded.memory.validators, { other: { etag: '"o1"' } });
});

test("обновление состояния прошлой версии забывает и отметку запуска сигнала Kuro, остальные отметки остаются", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const old = { version: 1, base: null, published: null, lastPublishedAt: null, failures: {} };
  const lastRun = { [KURO_SIGNAL.id]: NOW - 60, "genshin-codes": NOW - 120 };
  const oldMemory = { revisions: {}, pages: {}, validators: {}, kuro: [] };
  writeFileSync(path, JSON.stringify({ ...old, lastRun, memory: oldMemory }));
  const upgraded = loadState(path);
  assert.ok(upgraded);
  assert.deepEqual(upgraded.lastRun, { "genshin-codes": NOW - 120 }, "первый запуск после обновления сразу идёт на сайт Kuro");
  assert.equal(isDue((upgraded.lastRun as Record<string, number>)[KURO_SIGNAL.id], KURO_SIGNAL.everyHours, NOW), true);
  // Состояние уже нового вида не трогается: отметка сигнала остаётся.
  writeFileSync(path, JSON.stringify({ ...old, lastRun, memory: { ...oldMemory, kuroFacts: {}, kuroReleases: {}, kuroPatchNotes: [] } }));
  assert.deepEqual(loadState(path)?.lastRun, lastRun);
});

test("состояние без памяти об арте получает пустую, остальное не трогается", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const lastRun = { [KURO_SIGNAL.id]: NOW - 60 };
  const memory = { revisions: {}, pages: {}, validators: { [KURO_MENU_URL]: { etag: '"k1"' } }, kuro: [], kuroFacts: {}, kuroReleases: {}, kuroPatchNotes: [] };
  writeFileSync(path, JSON.stringify({ version: 1, base: null, published: null, lastPublishedAt: null, lastRun, failures: {}, memory }));
  const loaded = loadState(path);
  assert.ok(loaded);
  assert.deepEqual(loaded.memory.bannerArt, {});
  assert.deepEqual(loaded.lastRun, lastRun, "сигнал Kuro не перезапускается");
  assert.deepEqual(loaded.memory.validators, memory.validators, "метки меню остаются");
});

test("память об арте не того вида — состояние считается отсутствующим, правильная читается как есть", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const valid = emptyState();
  writeFileSync(path, JSON.stringify({ ...valid, memory: { ...valid.memory, bannerArt: [] } }));
  assert.equal(loadState(path), null, "bannerArt — список");
  valid.memory.bannerArt["zzz|Test Banner"] = { image: "https://example.test/a.png", checkedAt: NOW };
  saveState(valid, path);
  assert.deepEqual(loadState(path), valid);
});

test("состояние без памяти о версии приложения получает null, остальное не трогается", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const lastRun = { [KURO_SIGNAL.id]: NOW - 60 };
  const memory = { revisions: {}, pages: {}, validators: { [KURO_MENU_URL]: { etag: '"k1"' } }, kuro: [], kuroFacts: {}, kuroReleases: {}, kuroPatchNotes: [], bannerArt: {} };
  writeFileSync(path, JSON.stringify({ version: 1, base: null, published: null, lastPublishedAt: null, lastRun, failures: {}, memory }));
  const loaded = loadState(path);
  assert.ok(loaded);
  assert.equal(loaded.memory.appRelease, null);
  assert.deepEqual(loaded.lastRun, lastRun, "сигнал Kuro не перезапускается");
  assert.deepEqual(loaded.memory.validators, memory.validators, "метки меню остаются");
});

test("версия приложения не того вида — состояние считается отсутствующим, правильная читается как есть", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const valid = emptyState();
  writeFileSync(path, JSON.stringify({ ...valid, memory: { ...valid.memory, appRelease: "0.1.1" } }));
  assert.equal(loadState(path), null, "appRelease — строка");
  valid.memory.appRelease = { version: "0.1.1", url: "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.1" };
  saveState(valid, path);
  assert.deepEqual(loadState(path), valid);
});

test("состояние без памяти о фонах лаунчера получает пустую, остальное не трогается", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const lastRun = { [KURO_SIGNAL.id]: NOW - 60 };
  const memory = { revisions: {}, pages: {}, validators: { [KURO_MENU_URL]: { etag: '"k1"' } }, kuro: [], kuroFacts: {}, kuroReleases: {}, kuroPatchNotes: [], bannerArt: {}, appRelease: null };
  writeFileSync(path, JSON.stringify({ version: 1, base: null, published: null, lastPublishedAt: null, lastRun, failures: {}, memory }));
  const loaded = loadState(path);
  assert.ok(loaded);
  assert.deepEqual(loaded.memory.launcherArt, {});
  assert.deepEqual(loaded.lastRun, lastRun, "сигнал Kuro не перезапускается");
});

test("фоны лаунчера не того вида — состояние считается отсутствующим, правильные читаются как есть", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const valid = emptyState();
  writeFileSync(path, JSON.stringify({ ...valid, memory: { ...valid.memory, launcherArt: [] } }));
  assert.equal(loadState(path), null, "launcherArt — список");
  valid.memory.launcherArt = { zzz: { image: "https://cdn.example.test/z.webp", video: "https://cdn.example.test/z.webm" } };
  saveState(valid, path);
  assert.deepEqual(loadState(path), valid);
});

test("факты Kuro в состоянии сохраняются и читаются как есть, метки меню остаются", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const state = emptyState();
  state.memory.kuroFacts["9001"] = [{ title: "Test Banner", featured: "Resonator A", start: { kind: "release", version: "9.9" }, endsAt: NOW }];
  state.memory.kuroReleases["9.9"] = NOW - 100;
  state.memory.kuroPatchNotes = [{ articleId: 9101, version: "9.9", publishedAt: NOW - 200 }];
  state.memory.validators[KURO_MENU_URL] = { etag: '"k2"' };
  saveState(state, path);
  assert.deepEqual(loadState(path), state);
});

test("факты Kuro не того вида — состояние считается отсутствующим", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-"));
  const path = join(dir, "state.json");
  const valid = emptyState();
  writeFileSync(path, JSON.stringify({ ...valid, memory: { ...valid.memory, kuroFacts: [] } }));
  assert.equal(loadState(path), null, "kuroFacts — список");
  writeFileSync(path, JSON.stringify({ ...valid, memory: { ...valid.memory, kuroReleases: 5 } }));
  assert.equal(loadState(path), null, "kuroReleases — число");
  writeFileSync(path, JSON.stringify({ ...valid, memory: { ...valid.memory, kuroPatchNotes: {} } }));
  assert.equal(loadState(path), null, "kuroPatchNotes — не список");
});

test("из выложенного файла убираются и баннеры Kuro: они пересчитываются из памяти каждый прогон", () => {
  const hub: HubData = {
    version: 2,
    updatedAt: NOW,
    games: [],
    codes: [],
    banners: [
      { gameId: "wuthering", title: "Wiki", featured: [], rarity: 5, image: null, startsAt: 1, endsAt: 2, url: "https://wiki/b" },
      { gameId: "wuthering", title: "Kuro", featured: ["A"], rarity: 5, image: null, startsAt: 1, endsAt: 2, url: kuroArticleUrl(9001) },
    ],
    videos: [],
  };
  assert.deepEqual(baseFromPublished(hub).banners.map((b) => b.title), ["Wiki"]);
});

test("из выложенного файла в основу не попадает и версия приложения: она из памяти", () => {
  const hub: HubData = {
    version: 2,
    updatedAt: NOW,
    games: [],
    codes: [],
    banners: [],
    videos: [],
    app: { version: "0.1.1", url: "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.1" },
  };
  assert.equal("app" in baseFromPublished(hub), false);
});

test("счётчик неудач: в lastError попадает одна короткая строка без «@» и «::» в начале", () => {
  const failures: Record<string, Failure> = {};
  recordRun(failures, "a", { kind: "broken", error: `::error::p\n@victim ${"x".repeat(1000)}` }, NOW);
  const lastError = failures.a!.lastError;
  assert.equal(lastError.length, 200);
  assert.doesNotMatch(lastError, /[\r\n]/);
  assert.doesNotMatch(lastError, /^\s*::/);
  assert.match(lastError, /@\u200Bvictim/);
  assert.equal(failures.a!.consecutive, 1);
});

test("строка о запуске в журнале: у поломки текст ошибки чистится, у остальных — только вид", () => {
  assert.equal(runStatus({ kind: "broken", error: "a\n::error::b @c" }), "сломан — a ::error::b @\u200Bc");
  assert.equal(runStatus({ kind: "broken", error: "x".repeat(1000) }).length, "сломан — ".length + 200);
  assert.equal(runStatus({ kind: "unchanged" }), "unchanged");
  assert.equal(runStatus({ kind: "skipped" }), "skipped");
  assert.equal(runStatus({ kind: "ok", items: [], parsed: 0, dropped: 0 }), "ok");
});
