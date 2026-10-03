import { test } from "node:test";
import assert from "node:assert/strict";
import type { Http } from "../src/http.ts";
import { categoryMembers, expandTemplates, fandom, filesWithPrefix, lastRevisions, pageWikitext, thumbnails } from "../src/mediawiki.ts";

function fakeHttp(bodies: Record<string, unknown>) {
  const urls: string[] = [];
  const http: Http = {
    async get(url) {
      urls.push(url);
      const params = new URL(url).searchParams;
      // Ответ выбирается по запросу: query — по prop или list, parse — «wikitext», остальное — по action.
      const action = params.get("action")!;
      const key = action === "query" ? (params.get("prop") ?? params.get("list")!) : action === "parse" ? "wikitext" : action;
      return { status: 200, body: JSON.stringify(bodies[key]), validators: {} };
    },
  };
  return { http, urls };
}

const WUWA = fandom("wutheringwaves");

test("адрес страницы с подстраницей и пробелами", () => {
  assert.equal(
    WUWA.pageUrl("False Promise for Tomorrow/2026-08-20"),
    "https://wutheringwaves.fandom.com/wiki/False_Promise_for_Tomorrow/2026-08-20",
  );
});

test("номера правок пачкой, с нормализацией названий", async () => {
  const f = fakeHttp({
    info: {
      query: {
        normalized: [{ from: "Redemption_Code", to: "Redemption Code" }],
        pages: [
          { title: "Redemption Code", lastrevid: 136980 },
          { title: "Gone", missing: true },
        ],
      },
    },
  });
  const revs = await lastRevisions(f.http, WUWA, ["Redemption_Code", "Gone"]);
  assert.equal(revs.get("Redemption_Code"), 136980);
  assert.equal(revs.has("Gone"), false);
  const params = new URL(f.urls[0]!).searchParams;
  assert.equal(params.get("titles"), "Redemption_Code|Gone");
  assert.equal(params.get("formatversion"), "2");
});

test("текст страницы и ошибка отсутствующей страницы", async () => {
  assert.equal(await pageWikitext(fakeHttp({ wikitext: { parse: { wikitext: "{{Convene}}" } } }).http, WUWA, "X"), "{{Convene}}");
  await assert.rejects(
    pageWikitext(fakeHttp({ wikitext: { error: { code: "missingtitle" } } }).http, WUWA, "X"),
    /missingtitle/,
  );
});

test("участники категории по времени добавления", async () => {
  const f = fakeHttp({
    categorymembers: { query: { categorymembers: [{ title: "A/2026-09-10" }, { title: "B/2026-08-20" }] } },
  });
  assert.deepEqual(await categoryMembers(f.http, WUWA, "Convene", 30), ["A/2026-09-10", "B/2026-08-20"]);
  const params = new URL(f.urls[0]!).searchParams;
  assert.equal(params.get("cmtitle"), "Category:Convene");
  assert.equal(params.get("cmsort"), "timestamp");
  assert.equal(params.get("cmdir"), "desc");
});

test("миниатюры по именам файлов с подчёркиваниями и пробелами", async () => {
  const f = fakeHttp({
    imageinfo: {
      query: {
        pages: [
          {
            title: "File:False Promise for Tomorrow 2026-08-20.jpg",
            imageinfo: [{ thumburl: "https://static.wikia.nocookie.net/w/a.jpg/revision/latest/scale-to-width-down/400" }],
          },
          { title: "File:Missing.png", missing: true },
        ],
      },
    },
  });
  const thumbs = await thumbnails(f.http, WUWA, ["False_Promise_for_Tomorrow_2026-08-20.jpg", "Missing.png"]);
  assert.equal(thumbs.get("False Promise for Tomorrow 2026-08-20.jpg"), "https://static.wikia.nocookie.net/w/a.jpg/revision/latest/scale-to-width-down/400");
  assert.equal(thumbs.has("Missing.png"), false);
  assert.equal(new URL(f.urls[0]!).searchParams.get("iiurlwidth"), "400");
});

test("файлы по началу имени — с пробелами и временем загрузки", async () => {
  const f = fakeHttp({
    allimages: {
      query: {
        allimages: [
          { name: "Test_Banner_2026-05-21.jpg", title: "File:Test Banner 2026-05-21.jpg", timestamp: "2026-05-21T10:00:00Z" },
          { name: "Test_Banner.png", title: "File:Test Banner.png", timestamp: "2026-01-02T03:04:05Z" },
        ],
      },
    },
  });
  assert.deepEqual(await filesWithPrefix(f.http, WUWA, "Test Banner"), [
    { name: "Test Banner 2026-05-21.jpg", uploadedAt: Date.parse("2026-05-21T10:00:00Z") / 1000 },
    { name: "Test Banner.png", uploadedAt: Date.parse("2026-01-02T03:04:05Z") / 1000 },
  ]);
  const params = new URL(f.urls[0]!).searchParams;
  assert.equal(params.get("list"), "allimages");
  assert.equal(params.get("aiprefix"), "Test_Banner");
  assert.equal(params.get("aiprop"), "timestamp");
  assert.equal(params.get("ailimit"), "50");
});

test("раскрытие шаблонов", async () => {
  const f = fakeHttp({ expandtemplates: { expandtemplates: { wikitext: "<table></table>" } } });
  assert.equal(await expandTemplates(f.http, WUWA, "{{Banner table|current}}"), "<table></table>");
});

test("миниатюры: адрес с логином, портом, IP-адресом или не по https в карту не попадает", async () => {
  const page = (name: string, thumburl: string) => ({ title: `File:${name}`, imageinfo: [{ thumburl }] });
  const f = fakeHttp({
    imageinfo: {
      query: {
        pages: [
          page("Good.png", "https://static.wikia.nocookie.net/w/images/a/ab/Good.png/revision/latest/scale-to-width-down/400?cb=20260101000000"),
          page("Login.png", "https://u:p@static.wikia.nocookie.net/w/Login.png"),
          page("Port.png", "https://static.wikia.nocookie.net:8443/w/Port.png"),
          page("Ip.png", "https://192.168.1.1/w/Ip.png"),
          page("Plain.png", "http://static.wikia.nocookie.net/w/Plain.png"),
        ],
      },
    },
  });
  const thumbs = await thumbnails(f.http, WUWA, ["Good.png", "Login.png", "Port.png", "Ip.png", "Plain.png"]);
  assert.deepEqual([...thumbs.keys()], ["Good.png"]);
});

test("ошибка API: код в сообщении обрезан до 100 знаков, а не строка заменена словом «ошибка»", async () => {
  const long = "x".repeat(1000);
  await assert.rejects(
    pageWikitext(fakeHttp({ wikitext: { error: { code: long } } }).http, WUWA, "X"),
    (error: Error) => {
      assert.equal(error.message, `MediaWiki: ${"x".repeat(100)}`);
      return true;
    },
  );
  await assert.rejects(
    pageWikitext(fakeHttp({ wikitext: { error: { code: { nested: long } } } }).http, WUWA, "X"),
    (error: Error) => {
      assert.equal(error.message, "MediaWiki: ошибка");
      return true;
    },
  );
  await assert.rejects(pageWikitext(fakeHttp({ wikitext: { error: {} } }).http, WUWA, "X"), /^Error: MediaWiki: ошибка$/);
});
