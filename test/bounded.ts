// Общий помощник для тестов линейности разбора. Регулярное выражение и цикл
// выполняются синхронно, поэтому тест в том же потоке при возврате квадратичного
// или откатывающегося разбора завис бы, а не упал. Здесь замер идёт в воркере:
// функция настоящего модуля запускается там на враждебном входе, и если она не
// укладывается в жёсткий предел, воркер прерывается, а тест падает.
//
// Этот же файл служит и кодом воркера: в основном потоке он отдаёт runBounded, в
// воркере — выполняет задание из workerData.

import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

/** Предел времени на порядки щедрее нормы: тест ловит возврат квадратичного или откатывающегося разбора, а не ровность замеров. */
export const TIME_LIMIT_MS = 500;

/** Жёсткий предел: по его истечении воркер прерывается и тест падает, а не висит. */
export const HARD_LIMIT_MS = 2000;

interface Job {
  module: string;
  name: string;
  args: unknown[];
}

type Message = { type: "started" } | { type: "done"; ms: number; value: unknown };

/**
 * Вызывает экспорт name модуля (путь — как в import тестов, от папки test) с args в
 * воркере и возвращает его результат. Падает, если вызов шёл дольше TIME_LIMIT_MS, а
 * если он не завершился за HARD_LIMIT_MS — прерывает воркер и тоже падает. Время
 * считается только вокруг самого вызова, без запуска воркера и загрузки модуля.
 */
export function runBounded<T>(module: string, name: string, args: unknown[]): Promise<T> {
  const job: Job = { module: new URL(module, import.meta.url).href, name, args };
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    worker.on("message", (message: Message) => {
      if (message.type === "started") {
        timer = setTimeout(() => {
          finish(() =>
            reject(new assert.AssertionError({ message: `${name}: не завершилось за ${HARD_LIMIT_MS} мс, воркер прерван` })),
          );
        }, HARD_LIMIT_MS);
        return;
      }
      finish(() => {
        if (message.ms < TIME_LIMIT_MS) resolve(message.value as T);
        else reject(new assert.AssertionError({ message: `${name}: заняло ${message.ms.toFixed(0)} мс при пределе ${TIME_LIMIT_MS}` }));
      });
    });
    worker.on("error", (error) => finish(() => reject(error)));
    // Воркер ушёл, не ответив (сбой при загрузке модуля): без этого тест ждал бы вечно.
    worker.on("exit", (code) => finish(() => reject(new Error(`${name}: воркер завершился с кодом ${code} без ответа`))));
  });
}

if (!isMainThread && parentPort) {
  const job = workerData as Job;
  const mod = (await import(job.module)) as Record<string, (...args: unknown[]) => unknown>;
  parentPort.postMessage({ type: "started" } satisfies Message);
  const started = performance.now();
  const value = mod[job.name]!(...job.args);
  parentPort.postMessage({ type: "done", ms: performance.now() - started, value } satisfies Message);
}
