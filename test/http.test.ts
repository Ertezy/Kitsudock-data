import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHttp, USER_AGENT, type FetchLike } from "../src/http.ts";

function fakeFetch(responses: { status: number; body?: string; headers?: Record<string, string> }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error("сеть недоступна");
    return {
      status: next.status,
      text: async () => next.body ?? "",
      headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
    };
  };
  return { fetch, calls };
}

const noSleep = async () => {};

test("подпись запроса и условные заголовки", async () => {
  const f = fakeFetch([{ status: 200, body: "ok", headers: { etag: '"v2"' } }]);
  const http = createHttp({ fetch: f.fetch, sleep: noSleep });
  const res = await http.get("https://example.org/a", { etag: '"v1"', lastModified: "Wed, 09 Sep 2026 10:01:03 GMT" });
  assert.equal(res.body, "ok");
  assert.equal(res.validators.etag, '"v2"');
  assert.equal(f.calls[0]!.headers["User-Agent"], USER_AGENT);
  assert.equal(f.calls[0]!.headers["If-None-Match"], '"v1"');
  assert.equal(f.calls[0]!.headers["If-Modified-Since"], "Wed, 09 Sep 2026 10:01:03 GMT");
});

test("304 — пустое тело, это не ошибка", async () => {
  const f = fakeFetch([{ status: 304 }]);
  const res = await createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a", { etag: '"v1"' });
  assert.equal(res.status, 304);
  assert.equal(res.body, "");
});

test("503 повторяется один раз", async () => {
  const f = fakeFetch([{ status: 503 }, { status: 200, body: "ok" }]);
  const res = await createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a");
  assert.equal(res.body, "ok");
  assert.equal(f.calls.length, 2);
});

test("после второй неудачи — ошибка с кодом ответа", async () => {
  const f = fakeFetch([{ status: 429 }, { status: 429 }]);
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a"), /429/);
});

test("404 не повторяется", async () => {
  const f = fakeFetch([{ status: 404 }]);
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a"), /404/);
  assert.equal(f.calls.length, 1);
});

test("не https — отказ без запроса", async () => {
  const f = fakeFetch([]);
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep }).get("http://example.org/a"), /https/);
  assert.equal(f.calls.length, 0);
});

test("ответ больше потолка — ошибка, без повтора", async () => {
  const f = fakeFetch([{ status: 200, body: "x".repeat(11) }]);
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep, maxBytes: 10 }).get("https://example.org/a"), /потолок/);
  assert.equal(f.calls.length, 1);
});

test("сетевая ошибка повторяется один раз", async () => {
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return { status: 200, text: async () => "ok", headers: { get: () => null } };
  };
  const res = await createHttp({ fetch, sleep: noSleep }).get("https://example.org/a");
  assert.equal(res.body, "ok");
  assert.equal(calls, 2);
});

test("к одному хосту запросы идут по одному", async () => {
  let active = 0;
  let peak = 0;
  const fetch: FetchLike = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { status: 200, text: async () => "ok", headers: { get: () => null } };
  };
  const http = createHttp({ fetch, sleep: noSleep });
  await Promise.all([http.get("https://example.org/a"), http.get("https://example.org/b"), http.get("https://example.org/c")]);
  assert.equal(peak, 1);
});

test("дополнительные заголовки идут вместе с подписью и условными", async () => {
  const f = fakeFetch([{ status: 200, body: "ok" }]);
  const http = createHttp({ fetch: f.fetch, sleep: noSleep });
  await http.get("https://example.org/a", { etag: '"v1"' }, { Authorization: "Bearer t", Accept: "application/json" });
  assert.equal(f.calls[0]!.headers["User-Agent"], USER_AGENT);
  assert.equal(f.calls[0]!.headers["If-None-Match"], '"v1"');
  assert.equal(f.calls[0]!.headers.Authorization, "Bearer t");
  assert.equal(f.calls[0]!.headers.Accept, "application/json");
});

test("дополнительные заголовки сохраняются и в повторе", async () => {
  const f = fakeFetch([{ status: 503 }, { status: 200, body: "ok" }]);
  await createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a", {}, { Authorization: "Bearer t" });
  assert.equal(f.calls[1]!.headers.Authorization, "Bearer t");
});

// Потоковое чтение тела и проверка адреса после перенаправлений.

interface Probe {
  pulled: number;
  cancelled: boolean;
}

/** Тело без конца, кусками по chunkSize байт. Предел на число кусков нужен, чтобы чтение без потолка падало, а не висело. */
function endlessBody(chunkSize: number, probe: Probe): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (probe.pulled >= 10_000) return controller.error(new Error("тело читалось без потолка"));
      probe.pulled++;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x78));
    },
    cancel() {
      probe.cancelled = true;
    },
  });
}

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const textMustNotBeRead = async (): Promise<string> => {
  throw new Error("тело должно читаться потоком, а не через text()");
};

/** fetch, который отдаёт тело потоком, а адрес ответа (после перенаправлений) берёт у make. */
function streamingFetch(make: () => { body: ReadableStream<Uint8Array> | null; url?: string; status?: number }) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const { body, url: finalUrl, status } = make();
    return { status: status ?? 200, headers: { get: () => null }, body, url: finalUrl, text: textMustNotBeRead };
  };
  return { fetch, calls };
}

test("поток больше потолка: чтение обрывается сразу, поток отменяется, повтора нет", async () => {
  const probe: Probe = { pulled: 0, cancelled: false };
  const f = streamingFetch(() => ({ body: endlessBody(100, probe) }));
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep, maxBytes: 1000 }).get("https://example.org/a"), /потолок/);
  assert.equal(f.calls.length, 1, "без повтора");
  assert.equal(probe.cancelled, true, "поток отменён");
  assert.ok(probe.pulled <= 13, `прочитано ${probe.pulled} кусков по 100 байт при потолке 1000`);
});

test("сжатое тело считается по распакованным байтам, а не по сжатым", async () => {
  // Восемь мегабайт нулей сжимаются в несколько килобайт: по размеру на проводе потолок не нарушен.
  const gz = new Uint8Array(gzipSync(Buffer.alloc(8_000_000)));
  assert.ok(gz.length < 100_000, `сжатое тело ${gz.length} байт`);
  let unpacked = 0;
  const f = streamingFetch(() => ({
    body: new Blob([gz])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            unpacked += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      ),
  }));
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep, maxBytes: 100_000 }).get("https://example.org/a"), /потолок/);
  assert.equal(f.calls.length, 1);
  assert.ok(unpacked < 1_000_000, `распаковано ${unpacked} байт из 8 000 000 при потолке 100 000`);
});

test("сжатое тело в пределах потолка читается целиком", async () => {
  const text = "привет, мир! ".repeat(200);
  const gz = new Uint8Array(gzipSync(Buffer.from(text)));
  const f = streamingFetch(() => ({ body: new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")) }));
  const res = await createHttp({ fetch: f.fetch, sleep: noSleep, maxBytes: 10_000 }).get("https://example.org/a");
  assert.equal(res.body, text);
});

test("ровно потолок проходит, на байт больше — нет", async () => {
  const bytes = (n: number) => bodyOf([new Uint8Array(n).fill(0x78)]);
  const ok = streamingFetch(() => ({ body: bytes(10) }));
  assert.equal((await createHttp({ fetch: ok.fetch, sleep: noSleep, maxBytes: 10 }).get("https://example.org/a")).body, "x".repeat(10));
  const over = streamingFetch(() => ({ body: bytes(11) }));
  await assert.rejects(createHttp({ fetch: over.fetch, sleep: noSleep, maxBytes: 10 }).get("https://example.org/a"), /потолок/);
});

test("многобайтный знак, разрезанный границей кусков, читается целым", async () => {
  const bytes = new TextEncoder().encode("Привет, мир");
  const f = streamingFetch(() => ({ body: bodyOf([bytes.slice(0, 3), bytes.slice(3, 8), bytes.slice(8)]) }));
  assert.equal((await createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a")).body, "Привет, мир");
});

test("пустой ответ со статусом 200 без потока читается как пустая строка", async () => {
  const fetch: FetchLike = async () => ({ status: 200, headers: { get: () => null }, body: null, text: async () => "" });
  assert.equal((await createHttp({ fetch, sleep: noSleep }).get("https://example.org/a")).body, "");
});

test("перенаправление на http — отказ без повтора, тело не читается и отменяется", async () => {
  const probe: Probe = { pulled: 0, cancelled: false };
  const f = streamingFetch(() => ({ body: endlessBody(100, probe), url: "http://example.org/b" }));
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a"), /только https.*http:\/\/example\.org\/b/);
  assert.equal(f.calls.length, 1, "без повтора");
  assert.equal(probe.cancelled, true);
  assert.ok(probe.pulled <= 1, `тело не должно читаться, прочитано ${probe.pulled} кусков`);
});

test("адрес после перенаправления проверяется раньше кода ответа", async () => {
  const f = streamingFetch(() => ({ body: bodyOf([]), url: "http://example.org/b", status: 404 }));
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a"), /только https/);
});

test("перенаправление на другой https-хост и ответ без адреса проходят", async () => {
  const text = new TextEncoder().encode("ok");
  const moved = streamingFetch(() => ({ body: bodyOf([text]), url: "https://cdn.example.org/b" }));
  assert.equal((await createHttp({ fetch: moved.fetch, sleep: noSleep }).get("https://example.org/a")).body, "ok");
  const same = streamingFetch(() => ({ body: bodyOf([text]), url: "https://example.org/a" }));
  assert.equal((await createHttp({ fetch: same.fetch, sleep: noSleep }).get("https://example.org/a")).body, "ok");
  const unknown = streamingFetch(() => ({ body: bodyOf([text]) }));
  assert.equal((await createHttp({ fetch: unknown.fetch, sleep: noSleep }).get("https://example.org/a")).body, "ok");
});

test("ответ с кодом не 200 не читается, а поток отменяется", async () => {
  const probe: Probe = { pulled: 0, cancelled: false };
  const f = streamingFetch(() => ({ body: endlessBody(100, probe), status: 404 }));
  await assert.rejects(createHttp({ fetch: f.fetch, sleep: noSleep }).get("https://example.org/a"), /404/);
  assert.equal(f.calls.length, 1);
  assert.equal(probe.cancelled, true);
  assert.ok(probe.pulled <= 1);
});

// Боевой путь: без своего fetch берётся глобальный, а его ответ — настоящий Response с потоком в res.body и адресом в res.url.

test("по умолчанию: настоящий Response читается потоком и обрывается на потолке", async (t) => {
  const probe: Probe = { pulled: 0, cancelled: false };
  t.mock.method(globalThis, "fetch", async () => new Response(endlessBody(100, probe), { status: 200 }));
  await assert.rejects(createHttp({ sleep: noSleep, maxBytes: 1000 }).get("https://example.org/a"), /потолок/);
  assert.equal(probe.cancelled, true);
  assert.ok(probe.pulled <= 13, `прочитано ${probe.pulled} кусков по 100 байт при потолке 1000`);
});

test("по умолчанию: настоящий Response после перенаправления на http отвергается по res.url", async (t) => {
  const probe: Probe = { pulled: 0, cancelled: false };
  const response = new Response(endlessBody(100, probe), { status: 200 });
  // У собранного вручную Response адрес пустой; у ответа настоящей сети он — конечный адрес после перенаправлений.
  Object.defineProperty(response, "url", { value: "http://example.org/b" });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(createHttp({ sleep: noSleep }).get("https://example.org/a"), /только https/);
  assert.equal(probe.cancelled, true);
});

test("по умолчанию: обычный Response отдаёт тело и проверочные заголовки", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ok", { status: 200, headers: { etag: '"v9"' } }));
  const res = await createHttp({ sleep: noSleep }).get("https://example.org/a");
  assert.equal(res.body, "ok");
  assert.equal(res.validators.etag, '"v9"');
});
