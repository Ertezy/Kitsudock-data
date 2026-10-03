import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusError, type Http, type HttpResponse, type Validators } from "../src/http.ts";
import { APP_RELEASE_URL, fetchAppRelease, parseAppRelease } from "../src/sources/appRelease.ts";
import { emptyMemory } from "../src/sources/registry.ts";

const RELEASE = { tag_name: "v0.1.1", html_url: "https://github.com/Ertezy/Kitsudock/releases/tag/v0.1.1", draft: false, prerelease: false };

test("номер без v и ссылка из ответа GitHub", () => {
  assert.deepEqual(parseAppRelease(RELEASE), { version: "0.1.1", url: RELEASE.html_url });
  assert.deepEqual(parseAppRelease({ ...RELEASE, tag_name: "0.2.0" }), { version: "0.2.0", url: RELEASE.html_url });
});

test("ответ не той формы — null", () => {
  assert.equal(parseAppRelease({ ...RELEASE, tag_name: "v0.2" }), null, "не три числа");
  assert.equal(parseAppRelease({ ...RELEASE, tag_name: "v0.2.0-beta" }), null, "хвост после чисел");
  assert.equal(parseAppRelease({ ...RELEASE, html_url: "http://github.com/x" }), null, "не https");
  assert.equal(parseAppRelease({ ...RELEASE, prerelease: true }), null, "пробная версия");
  assert.equal(parseAppRelease({ ...RELEASE, draft: true }), null, "черновик");
  assert.equal(parseAppRelease({ html_url: RELEASE.html_url }), null, "нет tag_name");
  assert.equal(parseAppRelease([RELEASE]), null, "список");
  assert.equal(parseAppRelease(null), null);
});

/** Фальшивый Http: отдаёт ответы по очереди (или бросает), записывает запросы. */
function fakeHttp(replies: (HttpResponse | Error)[]) {
  const calls: { url: string; validators: Validators | undefined; headers: Record<string, string> | undefined }[] = [];
  const http: Http = {
    async get(url, validators, headers) {
      calls.push({ url, validators, headers });
      const next = replies.shift();
      if (next === undefined) throw new Error("лишний запрос");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { http, calls };
}

const ok = (value: unknown, etag?: string): HttpResponse => ({ status: 200, body: JSON.stringify(value), validators: etag ? { etag } : {} });

test("200: версия и метка ответа в памяти, токен и заголовки API в запросе", async () => {
  const f = fakeHttp([ok(RELEASE, '"r1"')]);
  const memory = emptyMemory();
  assert.deepEqual(await fetchAppRelease(f.http, memory, "secret"), { ok: true });
  assert.deepEqual(memory.appRelease, { version: "0.1.1", url: RELEASE.html_url });
  assert.deepEqual(memory.validators[APP_RELEASE_URL], { etag: '"r1"' });
  assert.equal(f.calls[0]!.url, APP_RELEASE_URL);
  assert.equal(f.calls[0]!.headers?.Authorization, "Bearer secret");
  assert.equal(f.calls[0]!.headers?.Accept, "application/vnd.github+json");
});

test("без токена — без Authorization; условный запрос с прошлой меткой", async () => {
  const f = fakeHttp([{ status: 304, body: "", validators: { etag: '"r1"' } }]);
  const memory = emptyMemory();
  memory.appRelease = { version: "0.1.1", url: RELEASE.html_url };
  memory.validators[APP_RELEASE_URL] = { etag: '"r1"' };
  assert.deepEqual(await fetchAppRelease(f.http, memory, undefined), { ok: true });
  assert.equal(f.calls[0]!.headers?.Authorization, undefined);
  assert.deepEqual(f.calls[0]!.validators, { etag: '"r1"' });
  assert.deepEqual(memory.appRelease, { version: "0.1.1", url: RELEASE.html_url }, "304 ничего не меняет");
});

test("404: опубликованных релизов нет — поле и метка убираются", async () => {
  const f = fakeHttp([new StatusError(404, APP_RELEASE_URL)]);
  const memory = emptyMemory();
  memory.appRelease = { version: "0.1.1", url: RELEASE.html_url };
  memory.validators[APP_RELEASE_URL] = { etag: '"r1"' };
  assert.deepEqual(await fetchAppRelease(f.http, memory, "secret"), { ok: true });
  assert.equal(memory.appRelease, null);
  assert.equal(memory.validators[APP_RELEASE_URL], undefined);
});

test("сбой или ответ не той формы — ошибка, прошлое значение остаётся", async () => {
  const memory = emptyMemory();
  memory.appRelease = { version: "0.1.1", url: RELEASE.html_url };
  const broken = await fetchAppRelease(fakeHttp([new StatusError(500, APP_RELEASE_URL)]).http, memory, "secret");
  assert.equal(broken.ok, false);
  const odd = await fetchAppRelease(fakeHttp([ok({ message: "Not Found" })]).http, memory, "secret");
  assert.deepEqual(odd, { ok: false, error: "ответ GitHub не той формы" });
  assert.deepEqual(memory.appRelease, { version: "0.1.1", url: RELEASE.html_url });
});

test("страница релиза — только релизы Kitsudock на GitHub, без логина, порта и IP", () => {
  for (const url of [
    "https://github.com/someone-else/Kitsudock/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Other/releases/tag/v0.1.1",
    "https://example.org/Ertezy/Kitsudock/releases/tag/v0.1.1",
    "https://github.com@example.org/Ertezy/Kitsudock/releases/tag/v0.1.1",
    "https://github.com:8443/Ertezy/Kitsudock/releases/tag/v0.1.1",
    "https://192.168.1.1/Ertezy/Kitsudock/releases/tag/v0.1.1",
    `https://github.com/Ertezy/Kitsudock/releases/tag/${"a".repeat(2100)}`,
  ]) {
    assert.equal(parseAppRelease({ ...RELEASE, html_url: url }), null, url.slice(0, 80));
  }
});

test("страница релиза: «..» и «%2e%2e» не уводят с префикса на чужой путь на github.com", () => {
  for (const url of [
    "https://github.com/Ertezy/Kitsudock/releases/../../other/repo/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Kitsudock/releases/%2e%2e/%2e%2e/other/repo/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Kitsudock/releases/%2E%2E/%2E%2E/other/repo/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Kitsudock/releases/.%2e/.%2e/other/repo/releases/tag/v0.1.1",
    "https://github.com/Ertezy/Kitsudock/releases/./tag/v0.1.1",
  ]) {
    assert.equal(parseAppRelease({ ...RELEASE, html_url: url }), null, url);
  }
});
