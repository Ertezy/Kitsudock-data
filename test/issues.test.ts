import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanErrorText, createGitHub, formatTime, keyOf, planIssues, withKey, type IssueInputs } from "../src/issues.ts";

const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const NOW = utc(2026, 9, 16, 14, 17);

const base = (patch: Partial<IssueInputs> = {}): IssueInputs => ({
  failures: {},
  labels: { "wuthering-codes": "коды Wuthering Waves (фандом)" },
  validationErrors: [],
  overridesErrors: [],
  wuwaSignal: null,
  daysSinceHumanCommit: 3,
  open: [],
  now: NOW,
  runUrl: "https://github.com/Ertezy/Kitsudock-data/actions/runs/1",
  repoUrl: "https://github.com/Ertezy/Kitsudock-data",
  ...patch,
});

const failure = (consecutive: number) => ({ consecutive, since: NOW - 7200, lastError: "ответ 503", lastAttempt: NOW });

test("время по-русски", () => {
  assert.equal(formatTime(NOW), "16 сентября 2026, 14:17 UTC");
});

test("метка ключа в тексте", () => {
  assert.equal(keyOf(withKey("source:x", "текст")), "source:x");
  assert.equal(keyOf("без метки"), null);
});

test("одна неудача — задачи нет", () => {
  assert.deepEqual(planIssues(base({ failures: { "wuthering-codes": failure(1) } })), []);
});

test("две неудачи подряд — задача с понятным заголовком и меткой", () => {
  const actions = planIssues(base({ failures: { "wuthering-codes": failure(2) } }));
  assert.equal(actions.length, 1);
  const a = actions[0]!;
  assert.equal(a.type, "open");
  if (a.type !== "open") return;
  assert.equal(a.title, "Не работает: коды Wuthering Waves (фандом)");
  assert.equal(keyOf(a.body), "source:wuthering-codes");
  assert.match(a.body, /ответ 503/);
  assert.match(a.body, /actions\/runs\/1/);
});

test("открытая задача — только обновление текста", () => {
  const actions = planIssues(base({ failures: { "wuthering-codes": failure(5) }, open: [{ number: 7, key: "source:wuthering-codes" }] }));
  assert.deepEqual(actions.map((a) => a.type), ["update"]);
});

test("источник заработал — комментарий и закрытие", () => {
  const actions = planIssues(base({ open: [{ number: 7, key: "source:wuthering-codes" }] }));
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.type, "close");
  if (actions[0]!.type === "close") assert.equal(actions[0]!.comment, "Заработал в 16 сентября 2026, 14:17 UTC.");
});

test("проверка файла и файл правок", () => {
  const opened = planIssues(base({ validationErrors: ["codes[0].code: плохо"], overridesErrors: ["codes[1]: плохо"] }));
  assert.deepEqual(opened.map((a) => (a.type === "open" ? keyOf(a.body) : a.type)), ["validation", "overrides"]);
  const closed = planIssues(base({ open: [{ number: 3, key: "validation" }, { number: 4, key: "overrides" }] }));
  assert.deepEqual(closed.map((a) => a.type), ["close", "close"]);
});

test("45 дней без коммита — задача; меньше — закрытие", () => {
  assert.equal(planIssues(base({ daysSinceHumanCommit: 45 }))[0]?.type, "open");
  assert.equal(planIssues(base({ daysSinceHumanCommit: 44, open: [{ number: 9, key: "inactivity" }] }))[0]?.type, "close");
  assert.deepEqual(planIssues(base({ daysSinceHumanCommit: null })), []);
});

test("сигнал о баннере: открыть, сменить на новый анонс, закрыть", () => {
  const signal = (id: number) => ({ articleId: id, publishedAt: NOW - 86400, url: `https://wutheringwaves.kurogames.com/en/main/news/detail/${id}` });
  const opened = planIssues(base({ wuwaSignal: signal(5431) }));
  assert.equal(opened[0]?.type === "open" ? keyOf(opened[0].body) : null, "wuwa-signal:5431");
  if (opened[0]?.type === "open") {
    assert.equal(opened[0].title, "Анонс баннера Wuthering Waves не разобрался");
    assert.match(opened[0].body, /news\/detail\/5431/);
    assert.match(opened[0].body, /не смог прочитать из неё название и сроки баннера персонажа/);
    assert.doesNotMatch(opened[0].body, /Фандом этого цикла ещё не знает/);
    assert.match(opened[0].body, /закроется на следующем прогоне после того, как в overrides\.json появится баннер/);
  }
  const moved = planIssues(base({ wuwaSignal: signal(5500), open: [{ number: 11, key: "wuwa-signal:5431" }] }));
  assert.deepEqual(moved.map((a) => a.type).sort(), ["close", "open"]);
  const gone = planIssues(base({ open: [{ number: 11, key: "wuwa-signal:5431" }] }));
  assert.deepEqual(gone.map((a) => a.type), ["close"]);
  if (gone[0]?.type === "close") assert.match(gone[0].comment, /баннер вписан в overrides\.json/);
});

test("чужие открытые задачи не трогаются", () => {
  assert.deepEqual(planIssues(base({ open: [{ number: 1, key: "something-else" }] })), []);
});

test("источника больше нет — открытая задача о нём закрывается, живой источник — по обычному правилу и не дважды", () => {
  const actions = planIssues(
    base({
      open: [
        { number: 7, key: "source:genshin-videos" },
        { number: 8, key: "source:wuthering-codes" },
      ],
    }),
  );
  assert.deepEqual(actions.map((a) => a.type), ["close", "close"]);
  assert.deepEqual(actions.map((a) => (a.type === "close" ? a.number : null)).sort(), [7, 8]);
});

test("клиент GitHub: список, открытие, закрытие", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/issues?state=open")) {
      return new Response(JSON.stringify([
        { number: 7, body: withKey("source:a", "x") },
        { number: 8, body: "без метки" },
        { number: 9, body: withKey("source:b", "x"), pull_request: {} },
      ]));
    }
    if (url.endsWith("/labels")) return new Response("{}", { status: 422 });
    if (url.includes("/commits")) {
      return new Response(JSON.stringify([
        { author: { login: "github-actions[bot]", type: "Bot" }, commit: { committer: { date: "2026-09-16T10:00:00Z" } } },
        { author: { login: "Ertezy", type: "User" }, commit: { committer: { date: "2026-09-01T10:00:00Z" } } },
      ]));
    }
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const gh = createGitHub({ token: "t", repo: "Ertezy/Kitsudock-data", fetch: fakeFetch });
  assert.deepEqual(await gh.listOpen(), [{ number: 7, key: "source:a" }]);
  await gh.open("Заголовок", "Текст");
  assert.deepEqual(calls.slice(-2).map((c) => [c.method, c.url.replace("https://api.github.com/repos/Ertezy/Kitsudock-data", "")]), [
    ["POST", "/labels"],
    ["POST", "/issues"],
  ]);
  assert.deepEqual((calls.at(-1)!.body as { labels: string[] }).labels, ["сборщик"]);
  await gh.close(7, "Заработал.");
  assert.deepEqual(calls.slice(-2).map((c) => c.method), ["POST", "PATCH"]);
  assert.equal(await gh.lastHumanCommitAt(), Date.UTC(2026, 8, 1, 10, 0) / 1000);
});

const ZWSP = "\u200B";

test("текст ошибки: одна строка, нулевой пробел после «@», «::» не в начале", () => {
  const cleaned = cleanErrorText("x\n::error::p @victim");
  assert.equal(cleaned, `x ::error::p @${ZWSP}victim`);
  assert.doesNotMatch(cleaned, /[\r\n]/);
  assert.equal(cleaned.startsWith("::"), false);
});

test("текст ошибки: пробельные и управляющие знаки любого вида сворачиваются в один пробел", () => {
  assert.equal(cleanErrorText("a \t\r\n\u2028\u00A0 b\u001b[31m\u0085c"), "a b [31m c");
  assert.equal(cleanErrorText("  \n tail \n "), "tail");
  assert.equal(cleanErrorText(""), "");
});

test("текст ошибки: «::» в начале обезвреживается, сам текст остаётся", () => {
  for (const raw of ["::error::boom", "\n\n  ::error::boom", ":::warning::x", "\t::set-output name=a::b", "::"]) {
    const cleaned = cleanErrorText(raw);
    assert.doesNotMatch(cleaned, /^\s*::/, JSON.stringify(raw));
    assert.equal(cleaned.replaceAll(ZWSP, ""), raw.replace(/\s+/g, " ").trim(), "знаки на месте, добавлен только нулевой пробел");
  }
  assert.equal(cleanErrorText("a::b"), "a::b", "«::» не в начале не трогается");
});

test("текст ошибки: каждая «@» получает нулевой пробел за собой, один раз", () => {
  assert.equal(cleanErrorText("@a @b@c"), `@${ZWSP}a @${ZWSP}b@${ZWSP}c`);
  assert.equal(cleanErrorText(`@${ZWSP}a`), `@${ZWSP}a`, "уже обезвреженная не получает второй");
});

test("текст ошибки: длиннее 200 знаков обрезается ровно до 200", () => {
  assert.equal(cleanErrorText("x".repeat(1000)).length, 200);
  assert.equal(cleanErrorText("x".repeat(201)).length, 200);
  assert.equal(cleanErrorText("x".repeat(200)), "x".repeat(200));
  assert.equal(cleanErrorText("x".repeat(199)), "x".repeat(199));
  // Нулевые пробелы, добавленные после «@», в предел входят: итог не длиннее 200 и при сплошных «@».
  assert.equal(cleanErrorText("@".repeat(1000)).length, 200);
});

test("текст ошибки: обрезка не оставляет половину суррогатной пары и пробел на конце", () => {
  const split = cleanErrorText("a".repeat(199) + "😀");
  assert.equal(split, "a".repeat(199));
  assert.equal(split, split.toWellFormed());
  assert.equal(cleanErrorText("a".repeat(199) + " b"), "a".repeat(199));
  // Одинокая половина пары в самом ответе заменяется знаком подстановки, а не доезжает до журнала.
  const lone = String.fromCharCode(0xd83d);
  assert.equal(cleanErrorText(`a${lone}b`), "a" + String.fromCharCode(0xfffd) + "b");
  assert.equal(cleanErrorText(`x ${lone}${lone}`), "x " + String.fromCharCode(0xfffd, 0xfffd));
});

test("текст ошибки: повторная чистка ничего не меняет", () => {
  const everyCf = [0x202e, 0x202a, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0xad, 0x61c, 0xe0041]
    .map((code) => String.fromCodePoint(code))
    .join("");
  const samples = [
    "x\n::error::p @victim",
    "a".repeat(199) + "@b",
    "@".repeat(300),
    "::x",
    "a".repeat(199) + "😀",
    "a".repeat(199) + " b",
    "  ::  @ ",
    MARKER,
    "-->".repeat(100),
    "<".repeat(300),
    "a".repeat(198) + "-->",
    "a".repeat(197) + "-->x",
    "a".repeat(199) + "<!--",
    `a${everyCf} @${everyCf}b ::`,
    `${everyCf}::${everyCf}`,
  ];
  for (const raw of samples) {
    const once = cleanErrorText(raw);
    assert.equal(cleanErrorText(once), once, JSON.stringify(raw));
  }
});

test("текст ошибки: сообщение JSON.parse с кусочком чужого ответа тоже сводится к одной строке", () => {
  let message = "";
  try {
    JSON.parse('{"a":\n::error::x @victim');
  } catch (error) {
    message = (error as Error).message;
  }
  const cleaned = cleanErrorText(message);
  assert.doesNotMatch(cleaned, /[\r\n]/);
  assert.doesNotMatch(cleaned, /^\s*::/);
  assert.doesNotMatch(cleaned, /@(?!\u200B)/);
});

test("тело задачи: тексты ошибок чистятся, даже если в состоянии остался сырой текст", () => {
  const raw = "ответ 503\n::error::p @victim " + "x".repeat(500);
  const actions = planIssues(
    base({
      failures: { "wuthering-codes": { consecutive: 2, since: NOW - 7200, lastError: raw, lastAttempt: NOW } },
      validationErrors: ["codes[0].code: плохо\n::error::p @victim", "x".repeat(500)],
      overridesErrors: ["не читается как JSON: \n::error::p @victim"],
    }),
  );
  assert.deepEqual(actions.map((a) => (a.type === "open" ? keyOf(a.body) : a.type)), ["source:wuthering-codes", "validation", "overrides"]);
  for (const a of actions) {
    if (a.type !== "open") continue;
    assert.doesNotMatch(a.body, /@(?!\u200B)/, a.title);
    assert.equal(
      a.body.split("\n").some((line) => line.startsWith("::")),
      false,
      a.title,
    );
    assert.ok(a.body.split("\n").every((line) => line.length <= 300), `строки тела короткие: ${a.title}`);
  }
  const source = actions[0]!;
  if (source.type !== "open") return;
  const line = source.body.split("\n").find((l) => l.startsWith("Что сломалось: "))!;
  assert.equal(line, `Что сломалось: \`${cleanErrorText(raw)}\``);
  assert.equal(line.length, "Что сломалось: ".length + 200 + 2);
  // Структура тела та же, что и была: одна строка на запись ошибки.
  const validation = actions[1]!;
  if (validation.type === "open") assert.equal(validation.body.split("\n").filter((l) => l.startsWith("- ")).length, 2);
});

const MARKER = "<!-- collector-key: validation -->";

test("метка задачи читается только в конце тела: метка из середины не в счёт", () => {
  const forged = `Что сломалось: ${MARKER}`;
  assert.equal(keyOf(withKey("source:x", forged)), "source:x");
  assert.equal(keyOf(withKey("source:x", `${forged}\n\n<!-- collector-key: overrides -->\nещё`)), "source:x");
  assert.equal(keyOf(`${withKey("source:x", "t")}\r\n\r\n`), "source:x", "хвостовые пробелы и переводы строк не мешают");
  assert.equal(keyOf(`${MARKER}\n\nтекст после`), null, "метка не в конце — это не метка сборщика");
});

test("текст ошибки: «<!--» и «-->» разорваны, метку задачи из чужого текста не составить", () => {
  for (const raw of [MARKER, "<!--", "a-->b", "-->", "<img src=x onerror=1>", "<<!--", "--->", "<!-->", "<!--\u200B-->"]) {
    const cleaned = cleanErrorText(raw);
    assert.doesNotMatch(cleaned, /<!--|-->/, raw);
    assert.doesNotMatch(cleaned, /<(?!\u200B)/, raw);
    assert.equal(cleaned.replaceAll(ZWSP, ""), raw.replaceAll(ZWSP, ""), "знаки на месте, добавлены только нулевые пробелы");
  }
  assert.equal(cleanErrorText("<a>"), `<${ZWSP}a>`);
  assert.equal(cleanErrorText("a-->b"), `a--${ZWSP}>b`);
  assert.equal(keyOf(withKey("source:x", `Что: ${cleanErrorText(MARKER)}`)), "source:x");
});

test("текст ошибки: невидимые знаки форматирования (Cf) убираются, остаётся только нулевой пробел самой чистки", () => {
  const rlo = String.fromCodePoint(0x202e);
  const everyCf = [0x202e, 0x202a, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0xad, 0x61c, 0xe0041]
    .map((code) => String.fromCodePoint(code))
    .join("");
  assert.equal(cleanErrorText(`a${everyCf}b`), "ab");
  assert.equal(cleanErrorText(`gpj.${rlo}exe @a`), `gpj.exe @${ZWSP}a`);
  assert.equal(cleanErrorText(`a ${everyCf} b`), "a b", "пробелы по обе стороны сворачиваются в один");
  assert.equal(cleanErrorText(`${everyCf}::x`), `:${ZWSP}:x`, "«::» находится и под невидимым знаком");
  assert.equal(cleanErrorText(`@${ZWSP}${ZWSP}a`), `@${ZWSP}a`, "чужие нулевые пробелы снимаются, свой ставится один раз");
});

test("текст ошибки: обратные кавычки в журнале остаются как есть", () => {
  assert.equal(cleanErrorText("a`b"), "a`b");
});

test("текст ошибки: часть с нулевым пробелом не режется пополам, итог не длиннее 200", () => {
  assert.equal(cleanErrorText("a".repeat(199) + "@b"), "a".repeat(199));
  assert.equal(cleanErrorText("a".repeat(198) + "@b"), "a".repeat(198) + `@${ZWSP}`);
  assert.equal(cleanErrorText("a".repeat(198) + "-->"), "a".repeat(198));
  assert.equal(cleanErrorText("<".repeat(300)).length, 200);
  assert.equal(cleanErrorText("-->".repeat(300)).length, 200);
});

test("тело задачи: текст ошибки лежит в строчном коде, обратные кавычки заменены — «#123», ссылки и теги не оживают", () => {
  const hostile = "`] **жирно** #123 org/repo#9 <img src=x> [x](https://evil.example) https://evil.example @victim ``` конец";
  const actions = planIssues(
    base({
      failures: { "wuthering-codes": { consecutive: 2, since: NOW - 7200, lastError: hostile, lastAttempt: NOW } },
      validationErrors: [hostile, ""],
      overridesErrors: [hostile],
    }),
  );
  assert.equal(actions.length, 3);
  for (const a of actions) {
    if (a.type !== "open") continue;
    assert.doesNotMatch(a.body, /<img/, a.title);
    assert.equal(a.body.split("<!--").length - 1, 1, `одна «<!--» — метка сборщика: ${a.title}`);
    const spans = a.body.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("Что сломалось: "));
    assert.ok(spans.length >= 1, a.title);
    for (const line of spans) assert.match(line, /^(?:- |Что сломалось: )`[^`]+`$/, `${a.title}: ${line}`);
  }
  const source = actions[0]!;
  if (source.type === "open") assert.match(source.body, /Что сломалось: `ʼ\] \*\*жирно\*\* #123 org\/repo#9 </);
  const validation = actions[1]!;
  if (validation.type === "open") assert.match(validation.body, /^- `—`$/m, "пустой текст — тире, а не пустой код");
});

test("метка в тексте ошибки не уводит задачу: она читается под своим ключом, следующий прогон её только обновляет", () => {
  for (const lastError of [MARKER, cleanErrorText(MARKER), `до ${MARKER} после`]) {
    const failures = { "wuthering-codes": { consecutive: 2, since: NOW - 7200, lastError, lastAttempt: NOW } };
    const first = planIssues(base({ failures }));
    assert.equal(first.length, 1);
    const opened = first[0]!;
    assert.equal(opened.type, "open");
    if (opened.type !== "open") return;
    assert.equal(keyOf(opened.body), "source:wuthering-codes", lastError);
    // Задача открыта; GitHub отдаёт её тело, и ключ читается из него.
    const second = planIssues(base({ failures, open: [{ number: 7, key: keyOf(opened.body)! }] }));
    assert.deepEqual(second.map((a) => [a.type, a.type === "update" ? a.number : null]), [["update", 7]], "ни открытий, ни закрытий");
  }
});

test("клиент GitHub: у каждого запроса есть сигнал таймаута, и зависший запрос обрывается", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const answering = (async (_url: string, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Response("[]");
  }) as typeof fetch;
  const gh = createGitHub({ token: "t", repo: "Ertezy/Kitsudock-data", fetch: answering });
  await gh.listOpen();
  await gh.lastHumanCommitAt();
  await gh.open("t", "b");
  await gh.update(1, "b");
  await gh.close(1, "c");
  assert.ok(signals.length >= 7, "список, коммиты, метка, задача, правка, комментарий, закрытие");
  assert.ok(signals.every((s) => s instanceof AbortSignal && !s.aborted), "на каждом запросе живой сигнал");
  // Зависший ответ обрывается по таймауту; ошибка уходит вызывающему, как и любая другая.
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))) as typeof fetch;
  const slow = createGitHub({ token: "t", repo: "Ertezy/Kitsudock-data", fetch: hanging, timeoutMs: 20 });
  await assert.rejects(slow.listOpen(), (error: Error) => error.name === "TimeoutError");
});
