import { test } from "node:test";
import assert from "node:assert/strict";
import type { Http } from "../src/http.ts";
import { StatusError } from "../src/http.ts";
import { planIssues, type Failure } from "../src/issues.ts";
import { mergeHub, sectionKey } from "../src/merge.ts";
import { createRunner } from "../src/runner.ts";
import { SOURCES, emptyMemory, type SourceContext, type SourceDef } from "../src/sources/registry.ts";
import { CHANNELS } from "../src/sources/videos.ts";
import { GAME_IDS, type HubGame, type HubData, type Item, type SourceRun, type Video } from "../src/types.ts";
import { RUN_BUDGET_MS } from "../src/validate.ts";

const NOW = Date.UTC(2026, 8, 16, 12, 0) / 1000;
const MINUTE = 60_000;

type RunFn = (ctx: SourceContext) => SourceRun<Item> | Promise<SourceRun<Item>>;

const ok = (): SourceRun<Item> => ({ kind: "ok", items: [], parsed: 1, dropped: 0 });
const timeout: SourceRun<Item> = { kind: "broken", error: "таймаут", transport: true };

/** Выдуманный источник: пять разных (игра, раздел, язык) — по номеру, чтобы ключи разделов не совпадали. */
const fake = (n: number, run: RunFn, over: Partial<SourceDef> = {}): SourceDef => ({
  id: `src-${n}`,
  game: GAME_IDS[n % GAME_IDS.length]!,
  section: "videos",
  lang: n < GAME_IDS.length ? "en" : "ja",
  label: `источник ${n}`,
  everyHours: 1,
  fallback: false,
  run: async (ctx) => run(ctx),
  ...over,
});
const keyOf = (source: SourceDef) => sectionKey(source.game, source.section, source.lang);

/** Прогон с подставными часами: `t.at` — «сколько прошло от старта процесса», мс. */
function env(at = 0, lastRun: Record<string, number> = {}, failures: Record<string, Failure> = {}) {
  const t = { at };
  const lines: string[] = [];
  const ctx: SourceContext = { http: {} as Http, now: NOW, memory: emptyMemory(), clock: () => t.at, deadline: RUN_BUDGET_MS };
  const runner = createRunner({ ctx, lastRun, failures, now: NOW, log: (line) => lines.push(line) });
  return { t, lines, ctx, lastRun, failures, runner };
}

test("прогон далеко от срока идёт как раньше: каждый источник раз, отметки и счётчики прежние", async () => {
  const e = env(0, { "src-2": NOW - 60 });
  const calls: string[] = [];
  const sources = [
    fake(0, () => (calls.push("src-0"), ok())),
    fake(1, () => (calls.push("src-1"), { kind: "broken", error: "ответ 500" })),
    fake(2, () => (calls.push("src-2"), ok())), // час ещё не настал
  ];
  const runs = await e.runner.runSources(sources);
  assert.deepEqual(calls, ["src-0", "src-1"]);
  assert.deepEqual(sources.map((s) => runs.get(keyOf(s))!.kind), ["ok", "broken", "skipped"]);
  assert.equal(runs.size, 3);
  assert.deepEqual(runs.get(keyOf(sources[2]!)), { kind: "skipped" }, "не наступивший час — без причины, как раньше");
  assert.deepEqual(e.lastRun, { "src-0": NOW, "src-1": NOW, "src-2": NOW - 60 });
  assert.deepEqual(Object.keys(e.failures), ["src-1"]);
  assert.equal(e.failures["src-1"]!.consecutive, 1);
  assert.deepEqual(e.lines.sort(), ["src-0: ok", "src-1: сломан — ответ 500", "src-2: skipped"]);
});

test("не связанные источники стартуют вместе, как раньше: один не ждёт другого", async () => {
  const e = env();
  const started: string[] = [];
  const release: (() => void)[] = [];
  const gate = (id: string): RunFn => async () => {
    started.push(id);
    await new Promise<void>((resolve) => release.push(resolve));
    return ok();
  };
  const done = e.runner.runSources([fake(0, gate("a")), fake(1, gate("b")), fake(2, gate("c"))]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"], "ни один не ждёт других");
  release.forEach((r) => r());
  await done;
});

test("лента источников одного хоста идёт по порядку и останавливается на сроке: остальные пропущены с прошлыми данными", async () => {
  const e = env();
  const ran: string[] = [];
  const slow = (id: string): RunFn => () => {
    ran.push(id);
    e.t.at += 4 * MINUTE; // источник «отвечает» 4 минуты
    return ok();
  };
  const sources = [0, 1, 2, 3, 4].map((n) => fake(n, slow(`src-${n}`), { lane: "host" }));
  const runs = await e.runner.runSources(sources);
  assert.deepEqual(ran, ["src-0", "src-1", "src-2"], "0, 4 и 8 минут — до срока; на 12-й минуте лента остановлена");
  assert.deepEqual(sources.map((s) => runs.get(keyOf(s))!.kind), ["ok", "ok", "ok", "skipped", "skipped"]);
  assert.match((runs.get(keyOf(sources[3]!)) as { reason: string }).reason, /время прогона/);
  assert.deepEqual(Object.keys(e.lastRun).sort(), ["src-0", "src-1", "src-2"], "пропущенные по времени не отмечены — они пойдут в следующем прогоне");
  assert.deepEqual(e.failures, {}, "нехватка времени — не поломка источника");
  assert.equal(e.lines.filter((l) => /время прогона/.test(l)).length, 2, "в журнале — по строке на пропущенный источник");
});

test("источники, не начатые к сроку, пропускаются: прошлые данные в файле, задачи о поломке нет, ни разу подряд", async () => {
  const failures: Record<string, Failure> = {};
  const sources = [0, 1, 2].map((n) => fake(n, () => assert.fail("источник не должен запускаться")));
  const previous: HubData = {
    version: 2,
    updatedAt: NOW - 3600,
    games: [],
    codes: [],
    banners: [],
    videos: sources.map((s, i): Video => ({
      gameId: s.game, lang: "en", title: `Прошлый ролик ${i}`, url: `https://www.youtube.com/watch?v=old${i}`, thumb: null, publishedAt: NOW - 100 - i, duration: null, premiere: false,
    })),
  };
  for (let run = 0; run < 3; run++) {
    const e = env(RUN_BUDGET_MS, {}, failures); // срок уже вышел
    const runs = await e.runner.runSources(sources);
    assert.ok([...runs.values()].every((r) => r.kind === "skipped"));
    assert.deepEqual(e.lastRun, {});
    const hub = mergeHub({ previous, catalog: [] as HubGame[], runs, now: NOW });
    assert.deepEqual(hub.videos.map((v) => v.title).sort(), ["Прошлый ролик 0", "Прошлый ролик 1", "Прошлый ролик 2"]);
    const actions = planIssues({
      failures,
      labels: Object.fromEntries(sources.map((s) => [s.id, s.label])),
      validationErrors: [],
      overridesErrors: [],
      wuwaSignal: null,
      daysSinceHumanCommit: null,
      open: [],
      now: NOW,
      runUrl: "https://example.test/run",
      repoUrl: "https://example.test/repo",
    });
    assert.deepEqual(actions, [], "задача «Не работает» не открывается");
  }
  assert.deepEqual(failures, {});
});

test("запасной источник после срока не запускается: у раздела остаются прошлые данные основного", async () => {
  const e = env();
  const primary = fake(0, () => {
    e.t.at = RUN_BUDGET_MS + 1; // основной источник «ответил» ошибкой после срока
    return { kind: "broken", error: "ответ 500" };
  });
  const fallback = fake(0, () => assert.fail("запасной не должен запускаться"), { id: "src-0-fallback", fallback: true });
  const runs = await e.runner.runSources([primary, fallback]);
  assert.deepEqual(runs.get(keyOf(primary)), { kind: "broken", error: "ответ 500" });
  assert.deepEqual(Object.keys(e.failures), ["src-0"], "поломка основного записана, запасной — нет");
  assert.ok(e.lines.some((l) => /src-0-fallback/.test(l) && /время прогона/.test(l)));
});

test("запасной источник до срока работает, как раньше", async () => {
  const e = env();
  const primary = fake(0, () => ({ kind: "broken", error: "ответ 500" }));
  const fallback = fake(0, () => ok(), { id: "src-0-fallback", fallback: true });
  const runs = await e.runner.runSources([primary, fallback]);
  assert.equal(runs.get(keyOf(primary))!.kind, "ok");
  assert.ok(e.lines.includes("src-0-fallback (запасной): ok"));
});

test("источник сам вернул skipped (не хватило времени внутри): отметка запуска не ставится, счётчик неудач не меняется", async () => {
  const e = env(0, {}, { "src-0": { consecutive: 1, since: NOW - 7200, lastError: "было", lastAttempt: NOW - 3600 } });
  const source = fake(0, () => ({ kind: "skipped", reason: "вышло время прогона" }));
  const runs = await e.runner.runSources([source]);
  assert.deepEqual(runs.get(keyOf(source)), { kind: "skipped", reason: "вышло время прогона" });
  assert.deepEqual(e.lastRun, {});
  assert.deepEqual(e.failures["src-0"], { consecutive: 1, since: NOW - 7200, lastError: "было", lastAttempt: NOW - 3600 });
  assert.ok(e.lines.includes("src-0: skipped — вышло время прогона"));
});

test("после сбоя связи на хосте остаток ленты пропускается; сбой с кодом ответа ленту не останавливает", async () => {
  const e = env();
  const ran: string[] = [];
  const lane = (n: number, run: SourceRun<Item>) => fake(n, () => (ran.push(`src-${n}`), run), { lane: "host" });
  const sources = [lane(0, { kind: "broken", error: "ответ 404" }), lane(1, timeout), lane(2, ok()), lane(3, ok())];
  const runs = await e.runner.runSources(sources);
  assert.deepEqual(ran, ["src-0", "src-1"], "после ответа 404 лента идёт дальше, после таймаута — стоит");
  assert.deepEqual(sources.map((s) => runs.get(keyOf(s))!.kind), ["broken", "broken", "skipped", "skipped"]);
  assert.match((runs.get(keyOf(sources[2]!)) as { reason: string }).reason, /не отвечает/);
  assert.deepEqual(Object.keys(e.failures).sort(), ["src-0", "src-1"], "пропущенные не считаются неудачей");
  assert.deepEqual(Object.keys(e.lastRun).sort(), ["src-0", "src-1"]);
});

test("в ленте сперва идут источники без неудач, а тот, что не отвечал, — последним: он не держит остальных", async () => {
  const failing: Failure = { consecutive: 3, since: NOW - 10_000, lastError: "таймаут", lastAttempt: NOW - 3600 };
  const e = env(0, {}, { "src-0": failing });
  const ran: string[] = [];
  const lane = (n: number, run: SourceRun<Item>) => fake(n, () => (ran.push(`src-${n}`), run), { lane: "host" });
  await e.runner.runSources([lane(0, timeout), lane(1, ok()), lane(2, ok())]);
  assert.deepEqual(ran, ["src-1", "src-2", "src-0"]);
  assert.equal(e.failures["src-0"]!.consecutive, 4);
});

test("в ленте несколько источников с неудачами: пропущенный по сбою связи идёт вперёд, поэтому выздоровевший очищается, а не голодает", async () => {
  const failed = (lastAttempt: number): Failure => ({ consecutive: 3, since: NOW - 10_000, lastError: "таймаут", lastAttempt });
  const failures: Record<string, Failure> = { "src-0": failed(NOW - 7200), "src-1": failed(NOW - 7200) }; // равны — порядок реестра
  const ran: string[] = [];
  const lane = (n: number, run: SourceRun<Item>) => fake(n, () => (ran.push(`src-${n}`), run), { lane: "host" });
  // Первый всегда не отвечает, второй уже здоров, третий здоров всегда.
  const sources = [lane(0, timeout), lane(1, ok()), lane(2, ok())];
  const first = env(0, {}, failures);
  await first.runner.runSources(sources);
  assert.deepEqual(ran, ["src-2", "src-0"], "первый не ответил — второй пропущен, его запись не тронута");
  assert.equal(failures["src-0"]!.lastAttempt, NOW);
  assert.equal(failures["src-1"]!.lastAttempt, NOW - 7200);
  ran.length = 0;
  const second = env(0, {}, failures);
  await second.runner.runSources(sources);
  assert.deepEqual(ran, ["src-2", "src-1", "src-0"], "давно не пробовавшийся второй идёт раньше только что не ответившего первого");
  assert.equal("src-1" in failures, false, "выздоровевший очищен — его задача закроется");
  assert.equal(failures["src-0"]!.consecutive, 5);
});

test("пропущено из-за срока: считаются источники ленты, запасные и одиночные; сбой связи, не наступивший час и обычный прогон — нет", async () => {
  const quiet = env();
  await quiet.runner.runSources([fake(0, () => ok()), fake(1, () => ok(), { lane: "host" }), fake(2, () => ok(), { lane: "host" })]);
  assert.equal(quiet.runner.overrunReport(), null, "в срок — строки нет");

  const lane = env();
  const slow = (): SourceRun<Item> => ((lane.t.at += 4 * MINUTE), ok());
  await lane.runner.runSources([0, 1, 2, 3, 4].map((n) => fake(n, slow, { lane: "host" })));
  assert.equal(lane.runner.overrunReport(), "пропущено из-за срока: 2");

  const silent = env(); // сбой связи — не срок
  await silent.runner.runSources([fake(0, () => timeout, { lane: "host" }), fake(1, () => ok(), { lane: "host" })]);
  assert.equal(silent.runner.overrunReport(), null);

  const notDue = env(0, { "src-0": NOW - 60 });
  await notDue.runner.runSources([fake(0, () => ok())]);
  assert.equal(notDue.runner.overrunReport(), null, "час не настал — не срок");

  const inside = env(); // источник сам вернул skipped из-за срока
  await inside.runner.runSources([fake(0, () => ({ kind: "skipped", reason: "вышло время прогона" })), fake(1, () => ({ kind: "skipped" }))]);
  assert.equal(inside.runner.overrunReport(), "пропущено из-за срока: 1");

  const fallbacks = env();
  const main = fake(0, () => ((fallbacks.t.at = RUN_BUDGET_MS + 1), { kind: "broken", error: "ответ 500" }));
  await fallbacks.runner.runSources([main, fake(0, () => ok(), { id: "src-0-fallback", fallback: true })]);
  assert.equal(fallbacks.runner.overrunReport(), "пропущено из-за срока: 1", "запасной, не начатый из-за срока");

  const singles = env(0, { a: NOW - 60 });
  singles.runner.shouldStart("a", 1); // час не настал
  singles.runner.shouldStart("b", 1);
  assert.equal(singles.runner.overrunReport(), null);
  singles.t.at = RUN_BUDGET_MS;
  singles.runner.shouldStart("a", 1);
  singles.runner.shouldStart("b", 1);
  singles.runner.shouldStart("c", 1);
  assert.equal(singles.runner.overrunReport(), "пропущено из-за срока: 2", "считаются только те, которым пора");
});

test("отбор одиночных источников: час не настал — молча нет; срок вышел — нет и строка в журнале", () => {
  const e = env(0, { a: NOW - 60 });
  assert.equal(e.runner.shouldStart("a", 1), false, "час не настал");
  assert.equal(e.runner.shouldStart("b", 1), true);
  assert.deepEqual(e.lines, []);
  e.t.at = RUN_BUDGET_MS;
  assert.equal(e.runner.shouldStart("a", 1), false);
  assert.equal(e.runner.shouldStart("b", 1), false);
  assert.equal(e.lines.length, 1, "строка только про источник, которому пора");
  assert.match(e.lines[0]!, /^b: skipped — вышло время прогона/);
});

// Ленты YouTube настоящего реестра: десять источников на одном хосте.
const youtube = SOURCES.filter((s) => s.section === "videos");
const feedOf = (channel: string) =>
  `<feed><entry><yt:videoId>v1</yt:videoId><yt:channelId>${channel}</yt:channelId><title>T</title><link rel="alternate" href="https://www.youtube.com/watch?v=v1"/><published>2026-09-15T10:00:00+00:00</published></entry></feed>`;
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

function youtubeHttp(failure: (channel: string) => Error | null, onRequest: () => void = () => {}) {
  const requested: string[] = [];
  const http: Http = {
    async get(url) {
      const channel = new URL(url).searchParams.get("channel_id")!;
      requested.push(channel);
      onRequest();
      const error = failure(channel);
      if (error) throw error;
      return { status: 200, body: feedOf(channel), validators: {} };
    },
  };
  return { http, requested };
}

function youtubeEnv(http: Http, failures: Record<string, Failure> = {}) {
  const e = env(0, {}, failures);
  e.ctx.http = http;
  return e;
}

test("YouTube: после первого таймаута остальные девять лент не запрашиваются, прошлые ролики на месте", async () => {
  assert.equal(youtube.length, 10);
  const f = youtubeHttp(() => timeoutError());
  const e = youtubeEnv(f.http);
  const runs = await e.runner.runSources(youtube);
  assert.deepEqual(f.requested, [CHANNELS.en.genshin], "один запрос на всё");
  const kinds = youtube.map((s) => runs.get(keyOf(s))!.kind);
  assert.deepEqual(kinds, ["broken", ...Array(9).fill("skipped")]);
  assert.deepEqual(Object.keys(e.failures), ["genshin-videos-en"], "неудача записана только у ленты, что не ответила");
  const previous: HubData = {
    version: 2, updatedAt: NOW - 3600, games: [], codes: [], banners: [],
    videos: youtube.map((s): Video => ({ gameId: s.game, lang: s.lang!, title: `Прошлый ${s.id}`, url: `https://www.youtube.com/watch?v=${s.id}`, thumb: null, publishedAt: NOW - 100, duration: null, premiere: false })),
  };
  const hub = mergeHub({ previous, catalog: [], runs, now: NOW });
  assert.equal(hub.videos.length, 10, "прошлые ролики всех десяти лент остались");
});

test("YouTube: ответ с кодом (500) ленты не останавливает — десять запросов, как раньше", async () => {
  const f = youtubeHttp((channel) => new StatusError(500, `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`));
  const e = youtubeEnv(f.http);
  const runs = await e.runner.runSources(youtube);
  assert.equal(f.requested.length, 10);
  assert.ok(youtube.every((s) => runs.get(keyOf(s))!.kind === "broken"));
});

test("YouTube: лента, что не отвечала в прошлый раз, идёт последней — здоровые ленты читаются", async () => {
  const failing = CHANNELS.en.genshin;
  const f = youtubeHttp((channel) => (channel === failing ? timeoutError() : null));
  const e = youtubeEnv(f.http, { "genshin-videos-en": { consecutive: 2, since: NOW - 7200, lastError: "таймаут", lastAttempt: NOW - 3600 } });
  const runs = await e.runner.runSources(youtube);
  assert.equal(f.requested.length, 10);
  assert.equal(f.requested.at(-1), failing);
  assert.deepEqual(youtube.map((s) => runs.get(keyOf(s))!.kind), ["broken", ...Array(9).fill("ok")]);
});

test("YouTube: до срока читаются все ленты; когда срок вышел посреди ленты, остальные ждут следующего прогона", async () => {
  const slow = youtubeHttp(() => null, () => {
    e.t.at += 90_000; // каждая лента «отвечает» 90 секунд
  });
  const e = youtubeEnv(slow.http);
  const runs = await e.runner.runSources(youtube);
  assert.equal(slow.requested.length, 7, "запросы стартуют на 0, 90, … 540 секунде; на 630-й срок уже вышел");
  assert.deepEqual(youtube.map((s) => runs.get(keyOf(s))!.kind), [...Array(7).fill("ok"), ...Array(3).fill("skipped")]);
  assert.deepEqual(e.failures, {});
  const quick = youtubeHttp(() => null);
  const normal = youtubeEnv(quick.http);
  const all = await normal.runner.runSources(youtube);
  assert.equal(quick.requested.length, 10);
  assert.ok(youtube.every((s) => all.get(keyOf(s))!.kind === "ok"));
});
