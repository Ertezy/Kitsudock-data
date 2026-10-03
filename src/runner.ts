// Запуск источников за один прогон: что пора спрашивать, в каком порядке и пока хватает времени.
// Основные источники идут все сразу, запасные — после них, только там, где основной сломан.
// Источник, который не начат из-за срока прогона (RUN_BUDGET_MS) или остановлен им посреди работы,
// получает skipped: прошлые данные раздела остаются (mergeHub), счётчик неудач не трогается,
// отметка запуска не ставится — задача «Не работает» из-за нехватки времени не откроется,
// а источник пойдёт в следующем прогоне.

import { OUT_OF_TIME, timeIsUp } from "./deadline.ts";
import type { Failure } from "./issues.ts";
import { sectionKey } from "./merge.ts";
import type { SourceContext, SourceDef } from "./sources/registry.ts";
import { isDue, recordRun, runStatus } from "./state.ts";
import type { Item, SourceRun } from "./types.ts";

/** Причина пропуска остатка ленты после сбоя связи: сайт не отвечает, и остальным источникам с него не лучше. */
const HOST_SILENT = "сайт не отвечает";

export interface RunnerInput {
  ctx: SourceContext;
  /** Отметки времени последнего запуска источников; пополняются по ходу. */
  lastRun: Record<string, number>;
  /** Счётчики неудач; пополняются по ходу. */
  failures: Record<string, Failure>;
  now: number;
  /** Строки журнала прогона. */
  log?: (line: string) => void;
}

/**
 * Источники лентами: источники одной ленты (общий хост) идут по очереди, остальные — каждый сам по себе.
 * В ленте сперва идут источники без неудач, а тот, что не отвечал в прошлый раз, — последним: после сбоя
 * связи остаток ленты пропускается, и вечно не отвечающий источник иначе не пускал бы к хосту остальных.
 */
function lanesOf(sources: SourceDef[], failures: Record<string, Failure>): SourceDef[][] {
  const lanes = new Map<string, SourceDef[]>();
  for (const source of sources) {
    const key = source.lane === undefined ? `id:${source.id}` : `lane:${source.lane}`;
    const lane = lanes.get(key);
    if (lane) lane.push(source);
    else lanes.set(key, [source]);
  }
  return [...lanes.values()].map((lane) => [
    ...lane.filter((source) => failures[source.id] === undefined),
    ...lane.filter((source) => failures[source.id] !== undefined),
  ]);
}

export function createRunner({ ctx, lastRun, failures, now, log = console.log }: RunnerInput) {
  const skipped = (reason: string): SourceRun<Item> => ({ kind: "skipped", reason });

  /** Почему источник нельзя начинать прямо сейчас (срок вышел, на хосте был сбой связи) — или null. */
  const blocker = (hostSilent: boolean): string | null => (timeIsUp(ctx) ? OUT_OF_TIME : hostSilent ? HOST_SILENT : null);

  async function primaryLane(lane: SourceDef[], runs: Map<string, SourceRun<Item>>): Promise<void> {
    let hostSilent = false;
    for (const source of lane) {
      const key = sectionKey(source.game, source.section, source.lang);
      if (!isDue(lastRun[source.id], source.everyHours, now)) {
        runs.set(key, { kind: "skipped" });
        log(`${source.id}: skipped`);
        continue;
      }
      const reason = blocker(hostSilent);
      if (reason !== null) {
        const run = skipped(reason);
        runs.set(key, run);
        log(`${source.id}: ${runStatus(run)}`);
        continue;
      }
      const run = await source.run(ctx);
      // Источник, которому не хватило времени, не отмечается: он пойдёт в следующем прогоне, а не через свой период.
      if (run.kind !== "skipped") lastRun[source.id] = now;
      recordRun(failures, source.id, run, now);
      runs.set(key, run);
      log(`${source.id}: ${runStatus(run)}`);
      if (run.kind === "broken" && run.transport) hostSilent = true;
    }
  }

  async function fallbackLane(lane: SourceDef[], runs: Map<string, SourceRun<Item>>): Promise<void> {
    let hostSilent = false;
    for (const source of lane) {
      const key = sectionKey(source.game, source.section, source.lang);
      const mainKind = runs.get(key)?.kind;
      if (mainKind !== "broken") {
        // Основной источник пропущен в этом прогоне (не наступил час) — это не «он здоров»,
        // счётчик неудач запасного трогать нельзя, как и recordRun сам не трогает skipped.
        if (mainKind === "ok" || mainKind === "unchanged") delete failures[source.id];
        continue;
      }
      const reason = blocker(hostSilent);
      if (reason !== null) {
        // Результат раздела остаётся результатом основного источника: прошлые данные на месте.
        log(`${source.id} (запасной): ${runStatus(skipped(reason))}`);
        continue;
      }
      const run = await source.run(ctx);
      recordRun(failures, source.id, run, now);
      if (run.kind === "ok") runs.set(key, run);
      log(`${source.id} (запасной): ${runStatus(run)}`);
      if (run.kind === "broken" && run.transport) hostSilent = true;
    }
  }

  return {
    /** Все источники прогона: основные все сразу (ленты — по очереди), затем запасные. Итог по ключу раздела. */
    async runSources(sources: SourceDef[]): Promise<Map<string, SourceRun<Item>>> {
      const runs = new Map<string, SourceRun<Item>>();
      await Promise.all(lanesOf(sources.filter((s) => !s.fallback), failures).map((lane) => primaryLane(lane, runs)));
      await Promise.all(lanesOf(sources.filter((s) => s.fallback), failures).map((lane) => fallbackLane(lane, runs)));
      return runs;
    },

    /**
     * Начинать ли одиночный источник вне реестра (Kuro, версия приложения, фоны лаунчера): пора ли по расписанию
     * и не вышло ли время прогона. Нет времени — строка в журнале, отметка запуска не ставится.
     */
    shouldStart(id: string, everyHours: number): boolean {
      if (!isDue(lastRun[id], everyHours, now)) return false;
      if (!timeIsUp(ctx)) return true;
      log(`${id}: ${runStatus(skipped(OUT_OF_TIME))}`);
      return false;
    },
  };
}
