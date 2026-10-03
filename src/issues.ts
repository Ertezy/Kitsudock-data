// Задачи в репозитории: владелец узнаёт о поломке письмом от GitHub, а
// сборщик сам закрывает задачу, когда всё заработало (спека §5.3).

import { USER_AGENT } from "./http.ts";
import type { Announcement } from "./sources/kuro.ts";

export const ISSUE_LABEL = "сборщик";
export const INACTIVITY_DAYS = 45;

export interface Failure {
  consecutive: number;
  since: number;
  lastError: string;
  lastAttempt: number;
}

export interface OpenIssue {
  number: number;
  key: string;
}

export interface IssueInputs {
  failures: Record<string, Failure>;
  labels: Record<string, string>;
  validationErrors: string[];
  overridesErrors: string[];
  wuwaSignal: Announcement | null;
  daysSinceHumanCommit: number | null;
  open: OpenIssue[];
  now: number;
  runUrl: string;
  repoUrl: string;
}

export type IssueAction =
  | { type: "open"; key: string; title: string; body: string }
  | { type: "update"; number: number; body: string }
  | { type: "close"; number: number; comment: string };

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** Самый длинный текст ошибки в журнале и в теле задачи. */
export const ERROR_TEXT_MAX = 200;

/**
 * Текст ошибки из чужого ответа (сообщение разбора JSON цитирует кусок ответа, код ошибки вики
 * приходит как есть) годится в журнал и в задачу только после чистки: одна строка, нулевой пробел
 * после каждой «@» (иначе GitHub упомянет постороннего человека), «::» в начале обезврежено
 * (строка журнала запуска с него читается как команда Actions), длина не больше ERROR_TEXT_MAX.
 * Повторная чистка текст не меняет.
 */
export function cleanErrorText(text: unknown): string {
  let line = String(text)
    .toWellFormed()
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .replace(/@(?!\u200B)/g, "@\u200B");
  if (line.startsWith("::")) line = `:\u200B${line.slice(1)}`;
  // Одинокие половины суррогатных пар заменены выше, а обрезка не оставляет половину пары и пробел на конце:
  // так итог — правильная строка, и повторная чистка его не меняет.
  return line.slice(0, ERROR_TEXT_MAX).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}

export const withKey = (key: string, text: string) => `${text}\n\n<!-- collector-key: ${key} -->`;

export function keyOf(body: string): string | null {
  return /<!-- collector-key: ([^ ]+) -->/.exec(body)?.[1] ?? null;
}

export function planIssues(input: IssueInputs): IssueAction[] {
  const actions: IssueAction[] = [];
  const openByKey = new Map(input.open.map((issue) => [issue.key, issue.number]));

  /** Открыть или обновить, если нужно; закрыть, если не нужно и открыта. */
  const keep = (key: string, needed: boolean, title: string, text: string, closing: string) => {
    const number = openByKey.get(key);
    if (needed) {
      const body = withKey(key, text);
      actions.push(number === undefined ? { type: "open", key, title, body } : { type: "update", number, body });
    } else if (number !== undefined) {
      actions.push({ type: "close", number, comment: closing });
    }
  };

  for (const [id, label] of Object.entries(input.labels)) {
    const f = input.failures[id];
    const key = `source:${id}`;
    if (f && f.consecutive === 1) continue;
    const text = f
      ? [
          `Источник: ${label}`,
          // Состояние живёт в кеше между запусками: в нём мог остаться текст, записанный до чистки.
          `Что сломалось: ${cleanErrorText(f.lastError)}`,
          `Не работает с: ${formatTime(f.since)}`,
          `Последняя попытка: ${formatTime(f.lastAttempt)}`,
          `Запуск: ${input.runUrl}`,
          "",
          "Пока источник не заработает, в файле остаются прошлые данные этого раздела. Задача закроется сама.",
        ].join("\n")
      : "";
    keep(key, f !== undefined && f.consecutive >= 2, `Не работает: ${label}`, text, `Заработал в ${formatTime(input.now)}.`);
  }

  // Источник исчез из реестра — его запись о неудаче тоже исчезла (pruneState), и цикл выше
  // эту задачу больше не посещает. Без этого она осталась бы открытой навсегда.
  for (const [key, number] of openByKey) {
    if (key.startsWith("source:") && !(key.slice("source:".length) in input.labels)) {
      actions.push({ type: "close", number, comment: "Источника больше нет, задача закрыта." });
    }
  }

  const list = (errors: string[]) => errors.map((e) => `- ${cleanErrorText(e)}`).join("\n");
  keep(
    "validation",
    input.validationErrors.length > 0,
    "Файл данных не прошёл проверку",
    `Файл не выложен. Если раньше уже что-то публиковалось, в сети остаётся прошлая версия.\n\nОшибки:\n${list(input.validationErrors)}\n\nЗапуск: ${input.runUrl}`,
    `Файл снова проходит проверку, ${formatTime(input.now)}.`,
  );
  keep(
    "overrides",
    input.overridesErrors.length > 0,
    "Файл правок не читается",
    `Правки пропущены, остальное собирается как обычно.\n\nОшибки:\n${list(input.overridesErrors)}\n\nПравить: ${input.repoUrl}/edit/main/overrides.json`,
    `Файл правок снова читается, ${formatTime(input.now)}.`,
  );

  if (input.daysSinceHumanCommit !== null) {
    keep(
      "inactivity",
      input.daysSinceHumanCommit >= INACTIVITY_DAYS,
      "Сделай любой коммит: расписание скоро выключится",
      `GitHub выключает расписание публичного репозитория после 60 дней без активности. Последний коммит был ${input.daysSinceHumanCommit} дн. назад.\n\nСделай любой коммит — например, поправь README на сайте GitHub, — и задача закроется сама.`,
      "Коммит есть, расписание не выключится.",
    );
  }

  const signalKey = input.wuwaSignal ? `wuwa-signal:${input.wuwaSignal.articleId}` : null;
  for (const [key, number] of openByKey) {
    if (key.startsWith("wuwa-signal:") && key !== signalKey) {
      actions.push({ type: "close", number, comment: "Сборщик разобрал анонс, баннер вписан в overrides.json, вышел более новый анонс или этому анонсу исполнился 21 день — задача закрыта." });
    }
  }
  if (input.wuwaSignal && signalKey) {
    keep(
      signalKey,
      true,
      "Анонс баннера Wuthering Waves не разобрался",
      `Kuro Games опубликовала анонс баннеров: ${input.wuwaSignal.url} (${formatTime(input.wuwaSignal.publishedAt)}).\n\nСборщик открыл статью, но не смог прочитать из неё название и сроки баннера персонажа, поэтому в панели этого цикла нет. Впиши баннер в overrides.json — пример в README. Когда фандом создаст страницу, в панель пойдёт запись оттуда. Задача закроется на следующем прогоне после того, как в overrides.json появится баннер Wuthering Waves, начало которого не раньше чем за двое суток до выхода анонса. Сама она закроется и когда сборщик сможет разобрать анонс, выйдет более новый анонс или этому анонсу исполнится 21 день.`,
      "",
    );
  }

  return actions;
}

export interface GitHub {
  listOpen(): Promise<OpenIssue[]>;
  open(title: string, body: string): Promise<void>;
  update(number: number, body: string): Promise<void>;
  close(number: number, comment: string): Promise<void>;
  lastHumanCommitAt(): Promise<number | null>;
}

export function createGitHub(options: { token: string; repo: string; fetch?: typeof fetch }): GitHub {
  const doFetch = options.fetch ?? fetch;
  const base = `https://api.github.com/repos/${options.repo}`;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  const send = async (method: string, path: string, body?: unknown, okStatuses: number[] = []) => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
    return res;
  };

  return {
    async listOpen() {
      const res = await send("GET", `/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=100`);
      const issues = (await res.json()) as { number: number; body?: string | null; pull_request?: unknown }[];
      return issues
        .filter((issue) => issue.pull_request === undefined)
        .flatMap((issue) => {
          const key = keyOf(issue.body ?? "");
          return key === null ? [] : [{ number: issue.number, key }];
        });
    },
    async open(title, body) {
      await send("POST", "/labels", { name: ISSUE_LABEL, color: "d4c5f9" }, [422]);
      await send("POST", "/issues", { title, body, labels: [ISSUE_LABEL] });
    },
    async update(number, body) {
      await send("PATCH", `/issues/${number}`, { body });
    },
    async close(number, comment) {
      if (comment !== "") await send("POST", `/issues/${number}/comments`, { body: comment });
      await send("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
    },
    async lastHumanCommitAt() {
      const res = await send("GET", "/commits?per_page=30");
      const commits = (await res.json()) as { author?: { login?: string; type?: string } | null; commit: { committer: { date: string } } }[];
      const human = commits.find((c) => c.author?.type !== "Bot" && !(c.author?.login ?? "").endsWith("[bot]"));
      return human ? Math.floor(Date.parse(human.commit.committer.date) / 1000) : null;
    },
  };
}

export async function applyIssueActions(github: GitHub, actions: IssueAction[]): Promise<void> {
  for (const action of actions) {
    if (action.type === "open") await github.open(action.title, action.body);
    else if (action.type === "update") await github.update(action.number, action.body);
    else await github.close(action.number, action.comment);
  }
}
