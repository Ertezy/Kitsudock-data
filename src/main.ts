// Один запуск сборщика целиком (спека §3).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { timeIsUp } from "./deadline.ts";
import { createHttp, StatusError } from "./http.ts";
import { applyIssueActions, cleanErrorText, createGitHub, planIssues } from "./issues.ts";
import { mergeHub, sameData } from "./merge.ts";
import { applyOverrides, bannerStarts, parseOverrides, type Overrides } from "./overrides.ts";
import { createRunner } from "./runner.ts";
import { APP_RELEASE, fetchAppRelease } from "./sources/appRelease.ts";
import { refreshArt, withArt } from "./sources/art.ts";
import { unreadableAnnouncement, withKuroBanners } from "./sources/kuro.ts";
import { LAUNCHER_ART, fetchLauncherArt, withLauncherArt } from "./sources/launcherArt.ts";
import { KURO_SIGNAL, SOURCES, fetchKuroAnnouncements, kuroBannersFromMemory, type SourceContext } from "./sources/registry.ts";
import {
  PAGES_URL,
  REPUBLISH_SECONDS,
  SLACK_SECONDS,
  baseFromPublished,
  emptyState,
  loadState,
  looksLikeHub,
  missingPrevious,
  pruneState,
  recordRun,
  saveState,
} from "./state.ts";
import type { HubData, HubGame } from "./types.ts";
import { ISSUES_GRACE_MS, RUN_BUDGET_MS, validateHub } from "./validate.ts";

const dryRun = process.argv.includes("--dry-run");
const now = Math.floor(Date.now() / 1000);
const http = createHttp();
const state = loadState() ?? emptyState();
const knownIds = new Set<string>([...SOURCES.map((s) => s.id), KURO_SIGNAL.id, APP_RELEASE.id, LAUNCHER_ART.id]);
for (const id of pruneState(state, knownIds)) console.log(`Источника ${id} больше нет — запись о нём убрана.`);

// Живой файл проверяется на каждом прогоне, не только когда состояния нет:
// когда состояние есть, он ещё и подтверждает, что прошлая выкладка дошла (см. ниже).
let liveHub: HubData | null = null;
let liveCheckFailed: string | null = null;
try {
  const parsed: unknown = JSON.parse((await http.get(PAGES_URL)).body);
  if (looksLikeHub(parsed)) {
    liveHub = parsed;
  } else {
    // Валидный JSON не той формы — читать оттуда нечего; ведём себя так, будто файла нет,
    // а не роняем прогон исключением где-то ниже по цепочке.
    console.log("Файл на Pages не похож на файл хаба — считаем, что выложенного файла нет.");
  }
} catch (error) {
  if (error instanceof StatusError && error.status === 404) {
    // файла ещё нет — это не сбой, а ожидаемое состояние для нового репозитория
  } else if (state.base === null) {
    // прошлых данных нет нигде, а проверка живого файла провалилась не из-за 404 —
    // неожиданный сбой; пусть процесс упадёт, и GitHub сам напишет владельцу письмом.
    // Текст ошибки идёт в журнал запуска, поэтому перед этим его чистят (см. cleanErrorText).
    throw new Error(`не удалось проверить файл на Pages: ${cleanErrorText((error as Error).message)}`);
  } else {
    liveCheckFailed = cleanErrorText((error as Error).message);
  }
}

if (state.base === null) {
  if (liveHub !== null) {
    const base = baseFromPublished(liveHub);
    state.base = base;
    state.published = liveHub;
    state.lastPublishedAt = liveHub.updatedAt;
    console.log("Состояния нет — прошлые данные взяты с Pages.");
  } else {
    console.log("Состояния нет и на Pages файла нет — сбор с нуля.");
  }
} else if (liveCheckFailed !== null) {
  console.log(`Не удалось проверить, дошла ли прошлая выкладка: ${liveCheckFailed} — пропускаем проверку.`);
} else if (!(liveHub !== null && sameData(state.published, liveHub))) {
  // живого файла нет (окончательный 404) или он отличается от того, что мы выложили —
  // прошлая выкладка не дошла; перевыложим при первой возможности
  state.lastPublishedAt = null;
  console.log("Прошлая выкладка не дошла до Pages — перевыложим при первой возможности.");
}

const catalog = JSON.parse(readFileSync("catalog.json", "utf8")) as HubGame[];

// Источники работают с копией памяти и отметок времени: если итог не пройдёт проверку,
// state.memory и state.lastRun останутся прежними и источники честно перечитаются заново
// на следующем прогоне, а не будут считаться «уже обработанными» (спека §3).
const memory = structuredClone(state.memory);
const lastRun: Record<string, number> = { ...state.lastRun };
// Срок прогона: performance.now() идёт от старта процесса, поэтому срок — просто RUN_BUDGET_MS (см. deadline.ts).
// После срока источники не начинают новых запросов и оставляют прошлые данные; сохранение, выкладка и задачи идут как обычно.
const ctx: SourceContext = { http, now, memory, deadline: RUN_BUDGET_MS };
const report: string[] = [];
const runner = createRunner({ ctx, lastRun, failures: state.failures, now });

const runs = await runner.runSources(SOURCES);

if (runner.shouldStart(KURO_SIGNAL.id, KURO_SIGNAL.everyHours)) {
  const result = await fetchKuroAnnouncements(ctx);
  lastRun[KURO_SIGNAL.id] = now;
  if (result.ok) {
    delete state.failures[KURO_SIGNAL.id];
    // Сбой одной статьи не роняет прогон: факты остаются прошлые, статья перечитается в следующий раз.
    for (const warning of result.warnings) console.log(`${KURO_SIGNAL.id}: ${cleanErrorText(warning)}`);
  } else {
    recordRun(state.failures, KURO_SIGNAL.id, { kind: "broken", error: result.error }, now);
  }
}

// Номер последней опубликованной версии приложения — для строки «Вышла версия» в панели.
if (runner.shouldStart(APP_RELEASE.id, APP_RELEASE.everyHours)) {
  const result = await fetchAppRelease(http, memory, process.env.GITHUB_TOKEN);
  lastRun[APP_RELEASE.id] = now;
  if (result.ok) delete state.failures[APP_RELEASE.id];
  else recordRun(state.failures, APP_RELEASE.id, { kind: "broken", error: result.error }, now);
}

// Фоны официального лаунчера HoYoPlay — ссылки для фона игр в приложении.
if (runner.shouldStart(LAUNCHER_ART.id, LAUNCHER_ART.everyHours)) {
  const result = await fetchLauncherArt(http, memory);
  lastRun[LAUNCHER_ART.id] = now;
  if (result.ok) delete state.failures[LAUNCHER_ART.id];
  else recordRun(state.failures, LAUNCHER_ART.id, { kind: "broken", error: result.error }, now);
}

const hadPrevious = state.base !== null;
const base = mergeHub({ previous: state.base, catalog, runs, now });

// Баннеры по официальным анонсам Kuro — пока фандом их не знает. Считаются каждый прогон
// из памяти (в ней анонсы, пока идёт хотя бы один их баннер) и в state.base не попадают:
// base остаётся данными одного фандома. Число баннеров ограничено, как у остальных источников.
const withKuro = withKuroBanners(base, kuroBannersFromMemory(memory, now));

let overrides: Overrides = { codes: [], banners: [], hide: [] };
let overridesErrors: string[] = [];
try {
  const parsed = parseOverrides(JSON.parse(readFileSync("overrides.json", "utf8")));
  if (parsed.ok) overrides = parsed.overrides;
  else overridesErrors = parsed.errors;
} catch (error) {
  overridesErrors = [`не читается как JSON: ${cleanErrorText((error as Error).message)}`];
}

// Баннерам без картинки — арт прошлого запуска с фандома (sources/art.ts). После правок:
// вписанный вручную баннер без картинки тоже его получает. Сбой вики прогон не роняет.
const withOverrides = applyOverrides(withKuro, overrides, now);
for (const warning of await refreshArt(http, withOverrides.banners, memory.bannerArt, now, ctx.clock, ctx.deadline)) console.log(`арт баннеров: ${cleanErrorText(warning)}`);
const withBannerArt = withArt(withOverrides, memory.bannerArt);
// Версия приложения — из памяти, как баннеры Kuro; в state.base не попадает.
const withRelease: HubData = memory.appRelease ? { ...withBannerArt, app: memory.appRelease } : withBannerArt;
// Фоны лаунчера — из памяти, как версия приложения; в state.base не попадают (игры берутся из каталога).
const hub: HubData = withLauncherArt(withRelease, memory.launcherArt);
const validationErrors = validateHub(hub);
validationErrors.push(...missingPrevious(runs, hadPrevious));

// Задача владельцу — когда самый свежий анонс баннера персонажа прочитан, а баннера из него не вышло.
// Решается по запомненным фактам; статья, которую не удалось открыть, сигнала не даёт.
// Баннер Wuthering Waves, уже вписанный в overrides.json, сигнал гасит: задача закроется.
const wuwaSignal = unreadableAnnouncement(memory.kuro, memory.kuroFacts, now, bannerStarts(overrides, "wuthering"));

const changed = !sameData(state.published, hub);
const stale = state.lastPublishedAt === null || now - state.lastPublishedAt >= REPUBLISH_SECONDS - SLACK_SECONDS;
const publish = validationErrors.length === 0 && (changed || stale);

if (validationErrors.length === 0) {
  state.base = base;
  state.memory = memory;
  state.lastRun = lastRun;
}
if (publish || dryRun) {
  mkdirSync("public", { recursive: true });
  writeFileSync("public/hub.json", JSON.stringify(hub));
}
if (publish && !dryRun) {
  state.published = hub;
  state.lastPublishedAt = now;
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);

const labels = Object.fromEntries([
  ...SOURCES.map((s) => [s.id, s.label] as const),
  [KURO_SIGNAL.id, KURO_SIGNAL.label],
  [APP_RELEASE.id, APP_RELEASE.label],
  [LAUNCHER_ART.id, LAUNCHER_ART.label],
]);
const repo = process.env.GITHUB_REPOSITORY ?? "Ertezy/Kitsudock-data";
const repoUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}`;
const runUrl = process.env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${process.env.GITHUB_RUN_ID}` : repoUrl;

// Состояние сохраняется независимо от того, дозвонимся ли мы до GitHub за задачами:
// прогон не должен терять память и счётчики из-за сбоя одного лишь API задач.
if (!dryRun) saveState(state);

// Шаг задач получает ещё ISSUES_GRACE_MS сверх срока прогона; не успел — остаток сверит следующий прогон.
const issuesTimeIsUp = () => timeIsUp(ctx, ISSUES_GRACE_MS);

if (!dryRun && process.env.GITHUB_TOKEN && issuesTimeIsUp()) {
  report.push("задачи в GitHub не обновлялись: вышло время прогона, их сверит следующий прогон");
} else if (!dryRun && process.env.GITHUB_TOKEN) {
  try {
    const github = createGitHub({ token: process.env.GITHUB_TOKEN, repo });
    const lastCommit = await github.lastHumanCommitAt();
    const actions = planIssues({
      failures: state.failures,
      labels,
      validationErrors,
      overridesErrors,
      wuwaSignal,
      daysSinceHumanCommit: lastCommit === null ? null : Math.floor((now - lastCommit) / 86400),
      open: await github.listOpen(),
      now,
      runUrl,
      repoUrl,
    });
    const applied = await applyIssueActions(github, actions, issuesTimeIsUp);
    report.push(`задачи: ${actions.slice(0, applied).map((a) => a.type).join(", ") || "без изменений"}`);
    if (applied < actions.length) report.push(`задач не обновлено: ${actions.length - applied} — вышло время прогона, их сверит следующий прогон`);
  } catch (error) {
    // Задачи живут на GitHub, а не локально: следующий прогон сам сверится заново.
    // Но владелец должен узнать о сбое — процесс завершится с ошибкой.
    report.push(`задачи в GitHub не обновились: ${cleanErrorText((error as Error).message)}`);
    process.exitCode = 1;
  }
} else {
  const actions = planIssues({
    failures: state.failures,
    labels,
    validationErrors,
    overridesErrors,
    wuwaSignal,
    daysSinceHumanCommit: null,
    open: [],
    now,
    runUrl,
    repoUrl,
  });
  report.push(`задачи (не отправлены): ${actions.map((a) => (a.type === "open" ? a.title : a.type)).join("; ") || "нет"}`);
}

report.push(
  `коды ${hub.codes.length}, баннеры ${hub.banners.length}, видео ${hub.videos.length}`,
  `проверка: ${validationErrors.length === 0 ? "пройдена" : validationErrors.map((e) => cleanErrorText(e)).join(" | ")}`,
  `правки: ${overridesErrors.length === 0 ? "в порядке" : overridesErrors.map((e) => cleanErrorText(e)).join(" | ")}`,
  `выкладка: ${publish ? "да" : "нет"}${dryRun ? " (пробный запуск, файл в public/hub.json)" : ""}`,
);
// Задачу из-за нехватки времени не открывают, поэтому хроническая нехватка видна хотя бы в итоге прогона.
const overrun = runner.overrunReport();
if (overrun !== null) report.push(overrun);
console.log(report.join("\n"));
