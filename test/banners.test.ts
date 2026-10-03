import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_PAGES, parseBannerPage, parseEndfieldTable, parseEnneadBanners, recentBannerPages } from "../src/sources/banners.ts";
import { ENNEAD_SOURCE } from "../src/sources/codes.ts";
import { runBounded } from "./bounded.ts";

const utc = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

const HSR_PAGE = `{{Warp
|name              = Over the Gilded Tides 2026-09-12
|image             = Over the Gilded Tides 2026-09-12.png
|type              = Character Event
|time_start        = 2026-09-12 12:00:00
<!--|time_start_offset = GMT+8-->
|time_end          = 2026-09-28 3:59:59
|time_end_offset   = GMT+8
|link              = https://www.hoyolab.com/article/46634922
}}
==Item Pool==
{{Warp Pool
|character_5_F = Aventurine • Waveflair
|character_4_F = Sampo; Hook; Guinaifen
}}`;

const GENSHIN_TBA = `{{Wish
|name              = Surging Ballad 2026-09-23
|image             = <!--Surging Ballad 2026-09-23.png-->
|type              = Character Event
|time_start        = 2026-09-23 11:00:00
|time_start_offset = GMT+8
|time_end          = TBA<!--2026-10-13 17:59:59-->
}}`;

const ZZZ_PAGE = `{{Signal Search Infobox
|name              = Paradise Regained 2026-07-29
|image             = Paradise Regained 2026-07-29.png
|type              = Exclusive Channel
|time_start        = 2026-07-29 11:00:00
|time_start_offset = GMT+8
|time_end          = 2026-09-08 14:59:59
}}
{{Signal Search Pool
|agent_S_F    = Remielle Dan
|agent_A_F    = Piper Wheel; Seth Lowell
}}`;

const WUWA_PAGE = `{{Convene
|name              = False Promise for Tomorrow 2026-08-20
|image             = False Promise for Tomorrow 2026-08-20.jpg
|type              = Featured Resonator
|time_start        = 2026-08-20 10:00
|time_end          = 2026-09-10 09:59
|time_start_offset =
|time_end_offset   =
}}
==Pool==
{{Convene/Pool
|resonator_5_F = Denia
|resonator_4_F = Baizhi;Yangyang;Sanhua
}}`;

const WUWA_WEAPON = WUWA_PAGE.replace("Featured Resonator", "Featured Weapon");

test("Star Rail: серверное начало по Европе, конец по GMT+8, персонаж из пула", () => {
  const out = parseBannerPage(HSR_PAGE, BANNER_PAGES.hsr, "Over the Gilded Tides/2026-09-12", "https://hsr/page");
  assert.equal(out.kind, "banner");
  if (out.kind !== "banner") return;
  assert.deepEqual(out.draft, {
    banner: {
      gameId: "hsr",
      title: "Over the Gilded Tides",
      featured: ["Aventurine • Waveflair"],
      rarity: 5,
      image: null,
      startsAt: utc(2026, 9, 12, 11, 0),
      endsAt: utc(2026, 9, 27, 19, 59, 59),
      url: "https://hsr/page",
    },
    imageFile: "Over the Gilded Tides 2026-09-12.png",
  });
});

test("Genshin: конец TBA — страница пропускается", () => {
  assert.deepEqual(parseBannerPage(GENSHIN_TBA, BANNER_PAGES.genshin, "Surging Ballad/2026-09-23", "https://g"), { kind: "skip" });
});

test("ZZZ: глобальное начало и серверный конец", () => {
  const out = parseBannerPage(ZZZ_PAGE, BANNER_PAGES.zzz, "Paradise Regained/2026-07-29", "https://z");
  assert.equal(out.kind, "banner");
  if (out.kind !== "banner") return;
  assert.equal(out.draft.banner.startsAt, utc(2026, 7, 29, 3, 0));
  assert.equal(out.draft.banner.endsAt, utc(2026, 9, 8, 13, 59, 59));
  assert.deepEqual(out.draft.banner.featured, ["Remielle Dan"]);
});

test("Wuthering Waves: пустое смещение — серверное время; оружейный баннер пропускается", () => {
  const out = parseBannerPage(WUWA_PAGE, BANNER_PAGES.wuthering, "False Promise for Tomorrow/2026-08-20", "https://w");
  assert.equal(out.kind, "banner");
  if (out.kind !== "banner") return;
  assert.equal(out.draft.banner.startsAt, utc(2026, 8, 20, 9, 0));
  assert.equal(out.draft.banner.endsAt, utc(2026, 9, 10, 8, 59));
  assert.deepEqual(out.draft.banner.featured, ["Denia"]);
  assert.deepEqual(parseBannerPage(WUWA_WEAPON, BANNER_PAGES.wuthering, "X/2026-08-20", "https://w"), { kind: "skip" });
});

test("страница без шаблона или с концом раньше начала — bad", () => {
  assert.equal(parseBannerPage("просто текст", BANNER_PAGES.hsr, "X/2026-09-12", "https://h").kind, "bad");
  const reversed = HSR_PAGE.replace("2026-09-28 3:59:59", "2026-09-01 3:59:59");
  assert.equal(parseBannerPage(reversed, BANNER_PAGES.hsr, "X/2026-09-12", "https://h").kind, "bad");
});

test("Star Rail: слишком длинное имя персонажа в пуле — bad, не поднимает всю выкладку", () => {
  const longName = "A".repeat(90);
  const page = HSR_PAGE.replace("Aventurine • Waveflair", longName);
  const out = parseBannerPage(page, BANNER_PAGES.hsr, "Over the Gilded Tides/2026-09-12", "https://hsr/page");
  assert.equal(out.kind, "bad");
});

test("свежие датированные подстраницы", () => {
  const titles = ["Surging Ballad", "La Chanson Cerise/7.1", "Surging Ballad/2026-09-23", "Old Banner/2026-01-01", "Surging Ballad/2026-09-23"];
  assert.deepEqual(recentBannerPages(titles, utc(2026, 9, 15, 0, 0)), ["Surging Ballad/2026-09-23"]);
});

const ENDFIELD = `
<table class="wikitable flex-table" width="640px"><tr><th class="hh-banner-column" width="320px">Banner</th><th class="hh-rateup-column">Operators</th></tr>
<tr valign="top"><td style="padding:0;margin:0;"><div class="header" style="background:var(--wiki-accent-color); font-weight:bold; width:100%;">Winter Hunt</div><div>[[File:Winter Hunt banner.png|360px|link=|class=responsive-image]]</div><div style="margin:0.25em;"><div style="display:flex;gap:0.25em;"><b style="flex:1 auto;text-align:left;">Asia:</b> <span style="flex:0 auto;text-align:right;">Sep 02, 2026, 12:00 &ndash; Sep 30, 2026, 11:59 <span class="visually-hidden">(UTC+8)</span></span></div><div style="display:flex;gap:0.25em;"><b style="flex:1 auto;text-align:left;"><abbr title="Americas / Europe">AM / EU</abbr>:</b> <span style="flex:0 auto;text-align:right;">Sep 01, 2026, 23:00 &ndash; Sep 30, 2026, 11:59 <span class="visually-hidden">(UTC&minus;5)</span></span></div></div></td><td style="text-align:left;"><div>'''Limited operators:''' <ul><li><span style="display:inline-block; border-bottom:2px solid #FF7000;">[[File:Typhoeus icon.png|24px|link=Typhoeus]]</span> [[Typhoeus]] </li><li><span style="display:inline-block;">[[File:Liino icon.png|24px|link=Liino]]</span> [[Liino]] </li></ul></div></td></tr>
<tr valign="top"><td>сломанная строка без заголовка</td></tr>
</table>`;

test("Endfield: время AM / EU, первый ограниченный оператор, файл арта", () => {
  const r = parseEndfieldTable(ENDFIELD, "https://endfield.wiki.gg/wiki/Headhunting/Banners");
  assert.equal(r.parsed, 2);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.drafts, [
    {
      banner: {
        gameId: "endfield",
        title: "Winter Hunt",
        featured: ["Typhoeus"],
        rarity: 6,
        image: null,
        startsAt: utc(2026, 9, 2, 4, 0),
        endsAt: utc(2026, 9, 30, 16, 59),
        url: "https://endfield.wiki.gg/wiki/Headhunting/Banners",
      },
      imageFile: "Winter Hunt banner.png",
    },
  ]);
});

test("Endfield: слишком длинное название баннера — строка выброшена и посчитана", () => {
  const longTitle = "W".repeat(210);
  const row = ENDFIELD.replace("Winter Hunt", longTitle);
  const r = parseEndfieldTable(row, "https://endfield.wiki.gg/wiki/Headhunting/Banners");
  assert.equal(r.parsed, 2);
  assert.equal(r.dropped, 2);
  assert.equal(r.drafts.length, 0);
});

test("ennead.cc: баннеры персонажей трёх игр", () => {
  const gi = parseEnneadBanners(
    { banners: [
      { name: "Character Event Wish", characters: [{ name: "Flins", rarity: 5 }, { name: "Aino", rarity: 4 }], start_time: 1788256800, end_time: 1790060399 },
      { name: "Epitome Invocation", characters: [], weapons: [{ name: "Sword", rarity: 5 }], start_time: 1788256800, end_time: 1790060399 },
    ] },
    "genshin",
  );
  assert.equal(gi.found, true);
  assert.deepEqual(gi.banners, [
    { gameId: "genshin", title: "Flins", featured: ["Flins"], rarity: 5, image: null, startsAt: 1788256800, endsAt: 1790060399, url: ENNEAD_SOURCE },
  ]);

  const hsr = parseEnneadBanners(
    { banners: [{ name: "", characters: [{ name: "Aventurine • Waveflair", rarity: 5 }, { name: "Ashveil", rarity: 5 }], start_time: 1789210800, end_time: 1790539140 }] },
    "hsr",
  );
  assert.equal(hsr.banners[0]!.title, "Aventurine • Waveflair / Ashveil");

  const zzz = parseEnneadBanners(
    { banners: [
      { banner_type: "GACHA_TYPE_CHARACTER_UP", agents: [{ name: "Claret", rarity: "S" }, { name: "Anton", rarity: "A" }], start_time: 1788919200, end_time: 1790740799 },
      { banner_type: "GACHA_TYPE_WEAPON_UP", w_engines: [{ name: "X", rarity: "S" }], start_time: 1788919200, end_time: 1790740799 },
    ] },
    "zzz",
  );
  assert.deepEqual(zzz.banners.map((b) => b.featured), [["Claret"]]);
  assert.equal(parseEnneadBanners({ message: "route not found" }, "zzz").found, false);
});

test("ennead.cc: слишком длинное имя персонажа — баннер выброшен и посчитан", () => {
  const longName = "B".repeat(90);
  const r = parseEnneadBanners(
    { banners: [{ characters: [{ name: longName, rarity: 5 }], start_time: 1788256800, end_time: 1790060399 }] },
    "genshin",
  );
  assert.equal(r.found, true);
  assert.equal(r.banners.length, 0);
  assert.equal(r.parsed, 1);
  assert.equal(r.dropped, 1);
});

const ENDFIELD_URL = "https://endfield.wiki.gg/wiki/Headhunting/Banners";
type EndfieldResult = ReturnType<typeof parseEndfieldTable>;

test("Endfield: время с лишними пробелами вокруг &ndash; по-прежнему разбирается", () => {
  const row = ENDFIELD.replace("23:00 &ndash; Sep 30", "23:00 \t &ndash;\n  Sep 30").replace("11:59 <span", "11:59   <span");
  const r = parseEndfieldTable(row, "https://endfield.wiki.gg/wiki/Headhunting/Banners");
  assert.equal(r.drafts.length, 1);
  assert.equal(r.drafts[0]!.banner.startsAt, utc(2026, 9, 2, 4, 0));
  assert.equal(r.drafts[0]!.banner.endsAt, utc(2026, 9, 30, 16, 59));
});

test("Endfield: 20 000 пробелов по обе стороны от &ndash; без закрывающего span — линейное время, строка выброшена", async () => {
  const pad = " ".repeat(20_000);
  const row = `<tr valign="top"><div class="header">Winter Hunt</div><b><abbr title="Americas / Europe">AM / EU</abbr>:</b> <span>${pad}&ndash;${pad}`;
  const r = await runBounded<EndfieldResult>("../src/sources/banners.ts", "parseEndfieldTable", [row, ENDFIELD_URL]);
  assert.equal(r.parsed, 1);
  assert.equal(r.dropped, 1);
  assert.equal(r.drafts.length, 0);
});

test("Endfield: 40 000 «&ndash;» подряд без закрывающего span — линейное время, строка выброшена", async () => {
  const row = `<tr valign="top"><div class="header">Winter Hunt</div><b><abbr title="Americas / Europe">AM / EU</abbr>:</b> <span>${"&ndash;".repeat(40_000)}<b>`;
  const r = await runBounded<EndfieldResult>("../src/sources/banners.ts", "parseEndfieldTable", [row, ENDFIELD_URL]);
  assert.equal(r.dropped, 1);
  assert.equal(r.drafts.length, 0);
});

test("Endfield: оператор — первая ссылка [[…]] сразу после </span>, обрывки до неё пропускаются", () => {
  const withJunk = (junk: string) => ENDFIELD.replace("<ul><li><span", `${junk}<ul><li><span`);
  for (const junk of ["</span>[[Bad|x]]", "</span>[[]]", "</span>[[ no close", "</span> [[Bad|x</span>"]) {
    const r = parseEndfieldTable(withJunk(junk), ENDFIELD_URL);
    assert.deepEqual(r.drafts[0]?.banner.featured, ["Typhoeus"], junk);
  }
});

test("Endfield: около 200 КБ «</span>[[» без закрытия — линейное время, оператора нет", async () => {
  const row = `<tr valign="top"><div class="header">Winter Hunt</div>Limited operators: ${"</span>[[".repeat(25_000)}`;
  const r = await runBounded<EndfieldResult>("../src/sources/banners.ts", "parseEndfieldTable", [row, ENDFIELD_URL]);
  assert.equal(r.parsed, 1);
  assert.equal(r.drafts.length, 0);
});

test("Endfield: оператор находится и после 200 КБ обрывков «</span>[[», оборванных «|»", async () => {
  const row = ENDFIELD.replace("<ul><li><span", `${"</span>[[".repeat(25_000)}|</span> [[Real Name]]<ul><li><span`);
  const r = await runBounded<EndfieldResult>("../src/sources/banners.ts", "parseEndfieldTable", [row, ENDFIELD_URL]);
  assert.deepEqual(r.drafts[0]?.banner.featured, ["Real Name"]);
});
