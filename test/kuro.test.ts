import { test } from "node:test";
import assert from "node:assert/strict";
import {
  articleText,
  articleTitle,
  conveneAnnouncements,
  isWeaponOnly,
  kuroArticleUrl,
  kuroBannerFacts,
  kuroBanners,
  maintenanceEnd,
  patchNotesVersion,
  unreadableAnnouncement,
  withKuroBanners,
  type Announcement,
  type KuroBannerFact,
} from "../src/sources/kuro.ts";
import type { Banner, HubData } from "../src/types.ts";
import { MAX_KURO_BANNERS_PER_ARTICLE } from "../src/validate.ts";
import { runBounded } from "./bounded.ts";

const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const NOW = utc(2026, 9, 15, 12, 0);

// Меню целиком придумано: номера, названия и даты.
const MENU = [
  { articleId: 9200, articleTitle: "Convene Details", startTime: "2024-05-23 10:00:00" },
  { articleId: 9201, articleTitle: "Resonator Review | Test", startTime: "2026-09-09 18:00:00" },
  { articleId: 9202, articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase II]", startTime: "2026-09-09 11:15:00" },
  { articleId: 9203, articleTitle: "[Test Weapon] Featured Weapon Convene", startTime: "2026-09-12 14:50:38" },
  { articleId: 9204, articleTitle: "[Old] Featured Resonator Convene", startTime: "2026-06-01 10:00:00" },
];

test("анонсы: только Convene, без справки и оружейных, не старше 21 дня, время UTC+8", () => {
  const r = conveneAnnouncements(MENU, NOW);
  assert.equal(r.found, true);
  // 9203 — только про оружие, 9204 опубликована 1 июня — старше 21 дня, 9200 — справка.
  assert.deepEqual(r.announcements, [
    { articleId: 9202, publishedAt: utc(2026, 9, 9, 3, 15), url: kuroArticleUrl(9202) },
  ]);
});

test("не массив — not found", () => {
  assert.equal(conveneAnnouncements({ error: 1 }, NOW).found, false);
});

test("список с null и другим мусором не роняет разбор", () => {
  const r = conveneAnnouncements(
    [null, 42, "x", { articleId: 9202, articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase II]", startTime: "2026-09-09 11:15:00" }],
    NOW
  );
  assert.equal(r.found, true);
  assert.equal(r.announcements.length, 1);
  assert.equal(r.announcements[0]?.articleId, 9202);
});

// Синтетическая статья: имена и даты придуманы, от настоящих анонсов взяты только служебные фразы.
const ARTICLE = {
  articleId: 9001,
  articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]",
  startTime: "2026-10-01 11:15:00",
  articleContent:
    "<p>[Test Banner] Featured Resonator Convene</p>" +
    "<p>During the event, 5-Star Resonator: Resonator A, 4-Star Resonators: B, C, and D receive boosted drop rates!</p>" +
    "<p>&#10022;Duration&#10022;</p><p>Version 9.9 update - 2026-10-22 09:59 (server time)</p>" +
    "<p>[Test Weapon] Featured Weapon Convene</p>" +
    "<p>During the event, 5-Star Weapon: Blade X receive boosted drop rates!</p>" +
    "<p>Version 9.9 update - 2026-10-22 09:59 (server time)</p>" +
    "<p>[Second Banner] Featured Resonator Convene</p>" +
    "<p>During the event, 5-Star Resonator: Resonator E, 4-Star Resonators: F receive boosted drop rates!</p>" +
    "<p>Duration</p><p>2026-10-22 10:00 - 2026-11-11 11:59 (server time)</p>",
};

test("факты баннеров: название, 5★, начало и конец; блок оружия пропущен", () => {
  assert.deepEqual(kuroBannerFacts(articleText(ARTICLE)!), [
    {
      title: "Test Banner",
      featured: "Resonator A",
      start: { kind: "release", version: "9.9" },
      endsAt: utc(2026, 10, 22, 8, 59),
    },
    {
      title: "Second Banner",
      featured: "Resonator E",
      start: { kind: "at", at: utc(2026, 10, 22, 9, 0) },
      endsAt: utc(2026, 11, 11, 10, 59),
    },
  ]);
});

test("текст статьи: теги убраны, блочные теги и <br> — переводы строк, сущности раскрыты", () => {
  const article = {
    articleContent:
      "<div><h3>Head &amp; Tail</h3><ul><li>one</li><li>two</li></ul></div>" +
      "<p>&#10022;Duration&#x2726;<br>Line&nbsp;two<br/><span>a</span><img src=\"x.png\">b</p>" +
      "<p>   </p><p>x &lt;b&gt; y &quot;z&quot; &#39;w&#39;</p>",
  };
  assert.deepEqual(articleText(article), [
    "Head & Tail",
    "one",
    "two",
    "✦Duration✦",
    "Line two",
    "ab",
    "x <b> y \"z\" 'w'",
  ]);
});

test("текст статьи: не объект или нет articleContent — null", () => {
  assert.equal(articleText(null), null);
  assert.equal(articleText("text"), null);
  assert.equal(articleText([]), null);
  assert.equal(articleText({ articleId: 1 }), null);
  assert.equal(articleText({ articleContent: 42 }), null);
});

test("блок резонатора без строки дат или без имени 5★ пропускается, остальные читаются", () => {
  const lines = articleText({
    articleContent:
      // Нет строки дат: даты следующего блока (оружия) ему не принадлежат.
      "<p>[No Dates] Featured Resonator Convene</p>" +
      "<p>During the event, 5-Star Resonator: Resonator A, 4-Star Resonators: B receive boosted drop rates!</p>" +
      "<p>[Test Weapon] Featured Weapon Convene</p>" +
      "<p>During the event, 5-Star Weapon: Blade X receive boosted drop rates!</p>" +
      "<p>Version 9.9 update - 2026-10-22 09:59 (server time)</p>" +
      // Нет имени 5★.
      "<p>[No Name] Featured Resonator Convene</p>" +
      "<p>Version 9.9 update - 2026-10-22 09:59 (server time)</p>" +
      "<p>[Good Banner] Featured Resonator Convene</p>" +
      "<p>During the event, 5-Star Resonator: Resonator E receive boosted drop rates!</p>" +
      "<p>2026-10-22 10:00 - 2026-11-11 11:59 (server time)</p>",
  })!;
  assert.deepEqual(kuroBannerFacts(lines), [
    {
      title: "Good Banner",
      featured: "Resonator E",
      start: { kind: "at", at: utc(2026, 10, 22, 9, 0) },
      endsAt: utc(2026, 11, 11, 10, 59),
    },
  ]);
});

test("блок пропускается, если начало не разобрать или оно не раньше конца", () => {
  const featured = "During the event, 5-Star Resonator: Resonator A receive boosted drop rates!";
  assert.deepEqual(
    kuroBannerFacts([
      "[Bad Start] Featured Resonator Convene",
      featured,
      "Soon - 2026-10-22 09:59 (server time)",
      "[Backwards] Featured Resonator Convene",
      featured,
      "2026-11-11 10:00 - 2026-10-22 09:59 (server time)",
      "[Empty] Featured Resonator Convene",
    ]),
    []
  );
  assert.deepEqual(kuroBannerFacts([]), []);
  assert.deepEqual(kuroBannerFacts(["No banners here", "Duration"]), []);
});

test("конец техработ: время после тире в строке Maintenance Time, UTC+8", () => {
  const lines = articleText({
    articleContent:
      "<p>Version 9.9 update</p><p>&#10022;Maintenance Time:    2026-09-30 04:00 - 2026-09-30 11:00 (UTC+8)</p>",
  })!;
  assert.equal(maintenanceEnd(lines), utc(2026, 9, 30, 3, 0));
  assert.equal(maintenanceEnd(["Maintenance Time:    2026-09-30 04:00 - 2026-09-30 11:00 (UTC+8)"]), utc(2026, 9, 30, 3, 0));
  assert.equal(maintenanceEnd(["Version 9.9 update", "Duration"]), null);
  assert.equal(maintenanceEnd([]), null);
});

test("версия патчноута берётся только из заголовка патчноута", () => {
  assert.equal(patchNotesVersion("Patch Notes for Wuthering Waves Version 9.9: Something"), "9.9");
  assert.equal(patchNotesVersion("[Version 9.9 Featured Resonator/Weapon Convene: Phase I]"), null);
  assert.equal(patchNotesVersion("Patch Notes without a number"), null);
});

test("версия патчноута: 9.9.1 — другая версия, а не 9.9; знак препинания после версии не мешает", () => {
  assert.equal(patchNotesVersion("Patch Notes for Wuthering Waves Version 9.9.1: Synthetic Hotfix"), null);
  assert.equal(patchNotesVersion("Patch Notes for Version 9.9.12"), null);
  assert.equal(patchNotesVersion("Patch Notes for Wuthering Waves Version 9.9: Synthetic Title"), "9.9");
  assert.equal(patchNotesVersion("Patch Notes for Version 9.9."), "9.9");
  assert.equal(patchNotesVersion("Patch Notes for Version 9.10 Synthetic"), "9.10");
  const menu = [
    { articleId: 9110, articleTitle: "Patch Notes for Wuthering Waves Version 9.9.1: Synthetic Hotfix", startTime: "2026-09-13 12:00:00" },
  ];
  assert.deepEqual(conveneAnnouncements(menu, NOW).patchNotes, [], "патчноут 9.9.1 в список не попадает");
});

// Меню с патчноутами: названия и номера придуманы.
const MENU_WITH_NOTES = [
  { articleId: 9101, articleTitle: "Patch Notes for Wuthering Waves Version 9.9: Synthetic Title", startTime: "2026-09-12 12:00:00" },
  { articleId: 9100, articleTitle: "Patch Notes for Wuthering Waves Version 9.8: Old Synthetic Title", startTime: "2026-08-01 12:00:00" },
  { articleId: 9102, articleTitle: "Patch Notes without a number", startTime: "2026-09-12 13:00:00" },
  { articleId: 9103, articleTitle: "Patch Notes for Wuthering Waves Version 10.0: From The Future", startTime: "2026-09-20 12:00:00" },
  { articleId: 9104, articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]", startTime: "2026-09-13 11:15:00" },
  { articleId: 9105, articleTitle: "Resonator Review | Synthetic", startTime: "2026-09-13 18:00:00" },
];

test("меню: свежие патчноуты возвращаются отдельно от анонсов, время UTC+8", () => {
  const r = conveneAnnouncements(MENU_WITH_NOTES, NOW);
  assert.equal(r.found, true);
  // 9100 старше 21 дня, 9102 без номера версии, 9103 «из будущего».
  assert.deepEqual(r.patchNotes, [{ articleId: 9101, version: "9.9", publishedAt: utc(2026, 9, 12, 4, 0) }]);
  assert.deepEqual(r.announcements.map((a) => a.articleId), [9104]);
});

test("не массив — патчноутов тоже нет", () => {
  assert.deepEqual(conveneAnnouncements({ error: 1 }, NOW).patchNotes, []);
  assert.deepEqual(conveneAnnouncements([], NOW), { found: true, announcements: [], patchNotes: [] });
});

const announcement = (articleId: number, publishedAt: number): Announcement => ({ articleId, publishedAt, url: kuroArticleUrl(articleId) });
const RELEASE_FACT: KuroBannerFact = { title: "Test Banner", featured: "Resonator A", start: { kind: "release", version: "9.9" }, endsAt: utc(2026, 10, 22, 8, 59) };
const AT_FACT: KuroBannerFact = { title: "Second Banner", featured: "Resonator E", start: { kind: "at", at: utc(2026, 10, 22, 9, 0) }, endsAt: utc(2026, 11, 11, 10, 59) };
const PUBLISHED = utc(2026, 9, 30, 3, 15);

test("баннер из факта: только факты, ссылка на анонс, начало «с версией» — из конца техработ", () => {
  const banners = kuroBanners([{ announcement: announcement(9001, PUBLISHED), banners: [RELEASE_FACT, AT_FACT] }], { "9.9": utc(2026, 10, 1, 3, 0) }, NOW);
  assert.deepEqual(banners, [
    {
      gameId: "wuthering",
      title: "Test Banner",
      featured: ["Resonator A"],
      rarity: 5,
      image: null,
      startsAt: utc(2026, 10, 1, 3, 0),
      endsAt: utc(2026, 10, 22, 8, 59),
      url: kuroArticleUrl(9001),
    },
    {
      gameId: "wuthering",
      title: "Second Banner",
      featured: ["Resonator E"],
      rarity: 5,
      image: null,
      startsAt: utc(2026, 10, 22, 9, 0),
      endsAt: utc(2026, 11, 11, 10, 59),
      url: kuroArticleUrl(9001),
    },
  ]);
});

test("баннер из факта: версия без известных техработ — начало во время публикации анонса", () => {
  const banners = kuroBanners([{ announcement: announcement(9001, PUBLISHED), banners: [RELEASE_FACT] }], { "9.8": utc(2026, 9, 1, 3, 0) }, NOW);
  assert.equal(banners.length, 1);
  assert.equal(banners[0]?.startsAt, PUBLISHED);
});

test("баннер из факта: закончившийся, с концом не позже начала и не влезающий в пределы файла отбрасываются", () => {
  const facts = (list: KuroBannerFact[]) => [{ announcement: announcement(9001, PUBLISHED), banners: list }];
  const ended: KuroBannerFact = { ...AT_FACT, start: { kind: "at", at: utc(2026, 9, 1, 9, 0) }, endsAt: NOW };
  const endsJustAfter: KuroBannerFact = { ...ended, endsAt: NOW + 1 };
  assert.deepEqual(kuroBanners(facts([ended]), {}, NOW), [], "конец ровно сейчас — уже закончился");
  assert.equal(kuroBanners(facts([endsJustAfter]), {}, NOW).length, 1);
  // Версия вышла позже конца баннера — начало получилось бы позже конца.
  assert.deepEqual(kuroBanners(facts([RELEASE_FACT]), { "9.9": utc(2026, 10, 23, 3, 0) }, NOW), []);
  assert.deepEqual(kuroBanners(facts([{ ...AT_FACT, title: "x".repeat(201) }]), {}, NOW), [], "название длиннее 200 знаков валило бы проверку файла");
  assert.deepEqual(kuroBanners(facts([{ ...AT_FACT, featured: "y".repeat(81) }]), {}, NOW), [], "имя длиннее 80 знаков — тоже");
  assert.deepEqual(kuroBanners([], {}, NOW), []);
});

test("баннер из факта: пустое название — баннера нет, пустое имя — баннер без имени", () => {
  const facts = (list: KuroBannerFact[]) => [{ announcement: announcement(9001, PUBLISHED), banners: list }];
  assert.deepEqual(kuroBanners(facts([{ ...AT_FACT, title: "  " }]), {}, NOW), [], "пустое название не пропустила бы проверка файла");
  assert.deepEqual(kuroBanners(facts([{ ...AT_FACT, featured: " " }]), {}, NOW).map((b) => b.featured), [[]]);
});

const wuwa = (title: string, startsAt: number, extra: Partial<Banner> = {}): Banner => ({
  gameId: "wuthering",
  title,
  featured: [],
  rarity: 5,
  image: null,
  startsAt,
  endsAt: startsAt + 21 * 86400,
  url: "https://wiki.example/b",
  ...extra,
});
const hubOf = (banners: Banner[]): HubData => ({ version: 2, updatedAt: NOW, games: [], codes: [], banners, videos: [] });

test("фандом побеждает: то же название без учёта регистра и начало в пределах 2 суток — баннер Kuro не добавляется", () => {
  const start = utc(2026, 10, 1, 3, 0);
  const fandom = wuwa("test banner", start + 3600, { image: "https://static.example/a.jpg" });
  const hub = hubOf([fandom]);
  const result = withKuroBanners(hub, kuroBanners([{ announcement: announcement(9001, PUBLISHED), banners: [RELEASE_FACT] }], { "9.9": start }, NOW));
  assert.deepEqual(result.banners, [fandom]);
  assert.equal(result, hub, "нечего добавлять — тот же файл");
});

test("граница двух суток: ровно 172 800 с — тот же баннер, на секунду больше — другой", () => {
  const start = utc(2026, 10, 1, 3, 0);
  const kuro = wuwa("Test Banner", start, { url: kuroArticleUrl(9001) });
  assert.equal(withKuroBanners(hubOf([wuwa("Test Banner", start + 172800)]), [kuro]).banners.length, 1);
  assert.equal(withKuroBanners(hubOf([wuwa("Test Banner", start - 172800)]), [kuro]).banners.length, 1);
  assert.equal(withKuroBanners(hubOf([wuwa("Test Banner", start + 172801)]), [kuro]).banners.length, 2, "повтор баннера через время — не то же самое");
});

test("другое название добавляется, порядок — по играм и началу; чужая игра с тем же названием не мешает", () => {
  const start = utc(2026, 10, 1, 3, 0);
  const genshin = wuwa("Test Banner", start, { gameId: "genshin" });
  const early = wuwa("Earlier Banner", start - 5 * 86400);
  const kuro = kuroBanners([{ announcement: announcement(9001, PUBLISHED), banners: [RELEASE_FACT, AT_FACT] }], { "9.9": start }, NOW);
  const result = withKuroBanners(hubOf([genshin, early]), kuro);
  assert.deepEqual(result.banners.map((b) => `${b.gameId}:${b.title}`), [
    "genshin:Test Banner",
    "wuthering:Earlier Banner",
    "wuthering:Test Banner",
    "wuthering:Second Banner",
  ]);
  assert.equal(result.updatedAt, NOW);
});

test("один и тот же баннер из двух анонсов Kuro добавляется один раз", () => {
  const start = utc(2026, 10, 1, 3, 0);
  const kuro = kuroBanners(
    [
      { announcement: announcement(9002, PUBLISHED + 3600), banners: [RELEASE_FACT] },
      { announcement: announcement(9001, PUBLISHED), banners: [RELEASE_FACT] },
    ],
    { "9.9": start },
    NOW,
  );
  const result = withKuroBanners(hubOf([]), kuro);
  assert.equal(result.banners.length, 1);
  assert.equal(result.banners[0]?.url, kuroArticleUrl(9002), "побеждает более новый анонс (первый в списке)");
});

// Одиночный баннер: строки «[Название] Featured Resonator Convene» в теле нет, она только в названии статьи.
const SOLO_LINES = articleText({
  articleContent:
    "<p>During the event, 5-Star Resonator: Solo Resonator, 4-Star Resonators: B, C receive boosted drop rates!</p>" +
    "<p>&#10022;Duration&#10022;</p><p>2026-10-22 10:00 - 2026-11-11 11:59 (server time)</p>",
})!;
const SOLO_FACT: KuroBannerFact = {
  title: "Solo Banner",
  featured: "Solo Resonator",
  start: { kind: "at", at: utc(2026, 10, 22, 9, 0) },
  endsAt: utc(2026, 11, 11, 10, 59),
};

test("одиночный баннер: без строки заголовка в теле баннер берётся по названию статьи", () => {
  assert.deepEqual(kuroBannerFacts(SOLO_LINES, "[Solo Banner] Featured Resonator Convene"), [SOLO_FACT]);
  assert.deepEqual(kuroBannerFacts(SOLO_LINES, "  [Solo Banner]   Featured Resonator Convene "), [SOLO_FACT]);
  assert.deepEqual(kuroBannerFacts(SOLO_LINES), [], "названия нет");
  assert.deepEqual(kuroBannerFacts(SOLO_LINES, null), []);
  assert.deepEqual(kuroBannerFacts(SOLO_LINES, "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]"), [], "название не одиночного баннера");
  assert.deepEqual(kuroBannerFacts(SOLO_LINES, "[Solo Banner] Featured Weapon Convene"), [], "название оружейного анонса");
  assert.deepEqual(kuroBannerFacts(SOLO_LINES, "Resonator Review | Test"), []);
});

test("одиночный баннер: блок кончается на первом оружейном заголовке, а название не мешает статье со своими заголовками", () => {
  const withWeapon = [
    ...SOLO_LINES,
    "[Test Weapon] Featured Weapon Convene",
    "During the event, 5-Star Weapon: Blade X receive boosted drop rates!",
    "2026-01-01 10:00 - 2026-01-02 11:59 (server time)",
  ];
  assert.deepEqual(kuroBannerFacts(withWeapon, "[Solo Banner] Featured Resonator Convene"), [SOLO_FACT]);
  const own = kuroBannerFacts(articleText(ARTICLE)!);
  assert.equal(own.length, 2);
  assert.deepEqual(kuroBannerFacts(articleText(ARTICLE)!, "[Other Title] Featured Resonator Convene"), own, "у статьи есть свои заголовки — название не нужно");
});

test("название статьи из JSON: сущности раскрыты, пробелы по краям убраны; нет названия — null", () => {
  assert.equal(articleTitle({ articleTitle: " [A &amp; B] Featured Resonator Convene " }), "[A & B] Featured Resonator Convene");
  assert.equal(articleTitle({ articleId: 1 }), null);
  assert.equal(articleTitle({ articleTitle: 5 }), null);
  assert.equal(articleTitle(null), null);
});

test("оружейный анонс: есть Weapon и нет Resonator в названии", () => {
  assert.equal(isWeaponOnly("[Test Weapon] Featured Weapon Convene"), true);
  assert.equal(isWeaponOnly("[Version 9.9 Featured Resonator/Weapon Convene: Phase I]"), false);
  assert.equal(isWeaponOnly("[Test Banner] Featured Resonator Convene"), false);
  assert.equal(isWeaponOnly("Convene Details"), false);
  assert.equal(isWeaponOnly("[Test Weapon] Reverb Weapon Convene"), true);
  assert.equal(isWeaponOnly("[Test Weapon] Collab Weapon Convene"), true);
  assert.equal(isWeaponOnly("[Test Rerun] Reverb Resonator Convene"), false);
});

test("повторный (Reverb) и совместный (Collab) баннеры персонажей тоже читаются", () => {
  const facts = kuroBannerFacts([
    "[Test Rerun] Reverb Resonator Convene",
    "During the event, selectable 5-Star Resonators: Resonator A, Resonator B, and Resonator C, and 4-Star Resonators: D receive boosted drop rates!",
    "Version 9.9 update - 2026-10-22 09:59 (server time)",
    "[Test Collab] Collab Resonator Convene",
    "During the event, 5-Star Resonator: Resonator Z, 4-Star Resonators: E receive boosted drop rates!",
    "2026-10-22 10:00 - 2026-11-11 11:59 (server time)",
    "[Test Collab Weapon] Collab Weapon Convene",
    "Version 9.9 update - 2026-10-22 09:59 (server time)",
  ]);
  assert.deepEqual(facts, [
    { title: "Test Rerun", featured: "", start: { kind: "release", version: "9.9" }, endsAt: utc(2026, 10, 22, 8, 59) },
    { title: "Test Collab", featured: "Resonator Z", start: { kind: "at", at: utc(2026, 10, 22, 9, 0) }, endsAt: utc(2026, 11, 11, 10, 59) },
  ]);
});

test("баннер с выбором персонажа — без имён в записи", () => {
  const rerun: KuroBannerFact = { title: "Test Rerun", featured: "", start: { kind: "release", version: "9.9" }, endsAt: utc(2026, 10, 22, 8, 59) };
  const banners = kuroBanners([{ announcement: announcement(9001, PUBLISHED), banners: [rerun] }], { "9.9": utc(2026, 10, 1, 3, 0) }, NOW);
  assert.equal(banners.length, 1);
  assert.deepEqual(banners[0]!.featured, []);
});

const T_OLD = announcement(9401, NOW - 3 * 86400);
const T_NEW = announcement(9402, NOW - 86400);

test("сигнал: самый свежий анонс прочитан и баннеров не дал — он; разобран — нет", () => {
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], { "9401": [RELEASE_FACT], "9402": [] }, NOW)?.articleId, 9402);
  assert.equal(unreadableAnnouncement([T_NEW, T_OLD], { "9401": [], "9402": [] }, NOW)?.articleId, 9402, "порядок списка не важен");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], { "9401": [], "9402": [RELEASE_FACT] }, NOW), null, "у самого свежего есть баннер, а у старого нет — сигнала нет");
});

test("сигнал: статья самого свежего анонса ещё не прочитана — сигнала нет, даже если старый анонс пуст", () => {
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], { "9401": [] }, NOW), null);
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], {}, NOW), null);
  assert.equal(unreadableAnnouncement([], {}, NOW), null);
});

test("сигнал: анонсы старше 21 дня не считаются; вышедшие в одну секунду считаются вместе", () => {
  const stale = announcement(9403, NOW - 22 * 86400);
  assert.equal(unreadableAnnouncement([stale], { "9403": [] }, NOW), null);
  assert.equal(unreadableAnnouncement([stale, T_OLD], { "9403": [], "9401": [RELEASE_FACT] }, NOW), null, "старый пустой не подменяет свежий разобранный");
  const twin = announcement(9404, T_NEW.publishedAt);
  assert.equal(unreadableAnnouncement([T_NEW, twin], { "9402": [RELEASE_FACT], "9404": [] }, NOW)?.articleId, 9404);
  assert.equal(unreadableAnnouncement([T_NEW, twin], { "9402": [RELEASE_FACT], "9404": [RELEASE_FACT] }, NOW), null);
});

test("сигнал: оружейный анонс самым свежим не считается, даже если он новее и про него что-то помнится", () => {
  const menu = [
    { articleId: 9302, articleTitle: "[Test Weapon] Featured Weapon Convene", startTime: "2026-09-14 12:00:00" },
    { articleId: 9301, articleTitle: "[Version 9.9 Featured Resonator/Weapon Convene: Phase I]", startTime: "2026-09-13 12:00:00" },
  ];
  const { announcements } = conveneAnnouncements(menu, NOW);
  assert.deepEqual(announcements.map((a) => a.articleId), [9301]);
  assert.equal(unreadableAnnouncement(announcements, { "9302": [], "9301": [RELEASE_FACT] }, NOW), null);
  assert.equal(unreadableAnnouncement(announcements, { "9301": [] }, NOW)?.articleId, 9301, "а пустой анонс баннеров остаётся сигналом");
});

test("сигнал: баннер, вписанный владельцем (начало не раньше выхода анонса минус 2 суток), сигнал гасит", () => {
  const empty = { "9401": [], "9402": [] };
  const published = T_NEW.publishedAt;
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [])?.articleId, 9402, "правок нет — сигнал остаётся");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [published]), null, "начало в момент выхода анонса");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [published + 5 * 86400]), null, "начало через несколько дней после выхода");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [published - 2 * 86400]), null, "ровно за 2 суток до выхода — ещё считается");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [published - 2 * 86400 - 1])?.articleId, 9402, "на секунду раньше — уже баннер прошлого цикла");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [published - 30 * 86400, published - 20 * 86400])?.articleId, 9402, "старые баннеры сигнал не гасят");
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [published - 30 * 86400, published + 86400]), null, "хватает одного подходящего");
});

test("сигнал: правка сверяется с самым свежим анонсом, а не со старым, и гасит всех «близнецов»", () => {
  const empty = { "9401": [], "9402": [] };
  // Начало на 3,5 суток раньше самого свежего анонса: для старого (9401, на 2 суток раньше) оно было бы «своим».
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], empty, NOW, [T_NEW.publishedAt - 3.5 * 86400])?.articleId, 9402);
  const twin = announcement(9404, T_NEW.publishedAt);
  const twins = { "9402": [], "9404": [] };
  assert.equal(unreadableAnnouncement([T_NEW, twin], twins, NOW, [])?.articleId, 9404);
  assert.equal(unreadableAnnouncement([T_NEW, twin], twins, NOW, [T_NEW.publishedAt]), null);
});

test("сигнал: правка ничего не меняет, когда сигнала и так нет", () => {
  assert.equal(unreadableAnnouncement([], {}, NOW, [NOW]), null);
  assert.equal(unreadableAnnouncement([T_OLD, T_NEW], { "9402": [RELEASE_FACT] }, NOW, [NOW]), null);
});

test("баннер фандома с другими кавычками и пробелами в названии — тот же баннер", () => {
  const start = utc(2026, 10, 1, 3, 0);
  const kuro = wuwa("Solo’s “Test”  Banner", start, { url: kuroArticleUrl(9001) });
  for (const title of ["Solo's \"Test\" Banner", "SOLO‘S “TEST” BANNER ", "solo’s \"test\" banner"]) {
    assert.equal(withKuroBanners(hubOf([wuwa(title, start + 3600)]), [kuro]).banners.length, 1, title);
  }
  assert.equal(withKuroBanners(hubOf([wuwa("Solo's Test Banner", start)]), [kuro]).banners.length, 2, "другое название — другой баннер");
});

const BLOCK_HEAD = "[X] Featured Resonator Convene";

test("строки блока: пробелы и табы вокруг имени, «,», «!», «receive» и тире срока не мешают", () => {
  const names = ["5-Star Resonator:   Aino   receive 100 pulls", "5-Star Resonator: Aino , receive", "5-Star Resonator:Aino! more", "5-Star Resonator: Aino"];
  const durations = [
    ["Version 3.7 Update  -  2026-09-30 11:59  (server time)", { kind: "release", version: "3.7" }],
    ["2026-09-01 10:00\t-\t2026-09-30 11:59 (Server Time) extra", { kind: "at", at: utc(2026, 9, 1, 9, 0) }],
  ] as const;
  for (const name of names) {
    for (const [duration, start] of durations) {
      assert.deepEqual(kuroBannerFacts([BLOCK_HEAD, name, duration], null), [{ title: "X", featured: "Aino", start, endsAt: utc(2026, 9, 30, 10, 59) }], `${name} | ${duration}`);
    }
  }
});

test("статья: 50 000 «<p», 200 000 «<» и 20 000 «<br …» без «>» читаются за линейное время", async () => {
  for (const content of ["<p".repeat(50_000), "<".repeat(200_000), `<br${" ".repeat(8)}x`.repeat(20_000)]) {
    assert.deepEqual(await runBounded<string[] | null>("../src/sources/kuro.ts", "articleText", [{ articleContent: content }]), [content]);
  }
});

test("строки блока: 60 000 пробелов внутри имени 5★, начала срока и заголовка читаются за линейное время", async () => {
  const pad = " ".repeat(60_000);
  const lines = [`5-Star Resonator:a${pad}b!`, `a${pad}-${pad}x`, `[a]${pad}]`, `[a]Featured${pad}Resonator Convene${pad}x`];
  for (const line of lines) {
    const facts = await runBounded<KuroBannerFact[]>("../src/sources/kuro.ts", "kuroBannerFacts", [[BLOCK_HEAD, line], null]);
    assert.deepEqual(facts, [], line.slice(0, 20));
  }
});

// Пределы: одна статья и весь список баннеров Kuro не растут вместе с тем, что отдал сайт.

/** Статья из `count` блоков баннеров с придуманными названиями и одним и тем же сроком. */
const blocks = (count: number, prefix = "Synthetic"): string[] =>
  Array.from({ length: count }, (_, i) => [
    `[${prefix} ${i}] Featured Resonator Convene`,
    `5-Star Resonator: Name ${i}, 4-Star Resonators: B receive boosted drop rates!`,
    "2026-10-01 10:00 - 2026-10-22 11:59 (server time)",
  ]).flat();

test("факты: из статьи с 3000 блоками баннеров берутся первые десять", () => {
  assert.equal(MAX_KURO_BANNERS_PER_ARTICLE, 10);
  const facts = kuroBannerFacts(blocks(3000));
  assert.deepEqual(
    facts.map((f) => f.title),
    Array.from({ length: 10 }, (_, i) => `Synthetic ${i}`),
  );
  assert.equal(kuroBannerFacts(blocks(10)).length, 10, "ровно предел — все");
  assert.equal(kuroBannerFacts(blocks(3)).length, 3, "обычный анонс не урезается");
});

test("факты: блок без дат предел не занимает — берутся десять настоящих баннеров", () => {
  const broken = ["[Broken] Featured Resonator Convene", "5-Star Resonator: Nobody"];
  const facts = kuroBannerFacts([...broken, ...broken, ...blocks(30)]);
  assert.equal(facts.length, 10);
  assert.equal(facts[0]!.title, "Synthetic 0");
});

test("баннеры Kuro: сводка с 20 000 баннерами укладывается в предел времени", async () => {
  const start = utc(2026, 10, 1, 3, 0);
  const kuro = Array.from({ length: 20_000 }, (_, i) => wuwa(`Synthetic ${i}`, start + i, { url: kuroArticleUrl(9001) }));
  const merged = await runBounded<HubData>("../src/sources/kuro.ts", "withKuroBanners", [hubOf([wuwa("Fandom", start)]), kuro]);
  assert.equal(merged.banners.length, 20_001);
  // Одно название и начала дальше двух суток друг от друга — все разные баннеры, все в одной связке.
  const same = Array.from({ length: 20_000 }, (_, i) => wuwa("Same Title", start + i * 3 * 86400));
  assert.equal((await runBounded<HubData>("../src/sources/kuro.ts", "withKuroBanners", [hubOf([]), same])).banners.length, 20_000);
  // Одно название и начала в пределах двух суток — один баннер.
  const close = Array.from({ length: 20_000 }, (_, i) => wuwa("Same Title", start + i));
  assert.equal((await runBounded<HubData>("../src/sources/kuro.ts", "withKuroBanners", [hubOf([]), close])).banners.length, 1);
  // Баннеров много и у файла.
  const own = Array.from({ length: 20_000 }, (_, i) => wuwa(`Own ${i}`, start + i));
  const again = await runBounded<HubData>("../src/sources/kuro.ts", "withKuroBanners", [hubOf(own), kuro.slice(0, 10)]);
  assert.equal(again.banners.length, 20_010);
});

/** Прежняя сверка перебором — образец, с которым сравнивается быстрая. */
function naiveWithKuro(hub: HubData, kuro: Banner[]): Banner[] {
  const comparable = (title: string) => title.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
  const same = (a: Banner, b: Banner) => a.gameId === b.gameId && comparable(a.title) === comparable(b.title) && Math.abs(a.startsAt - b.startsAt) <= 172800;
  const banners = [...hub.banners];
  for (const banner of kuro) if (!banners.some((b) => same(b, banner))) banners.push(banner);
  if (banners.length === hub.banners.length) return hub.banners;
  return banners.sort((a, b) => ["genshin", "hsr", "zzz", "wuthering", "endfield"].indexOf(a.gameId) - ["genshin", "hsr", "zzz", "wuthering", "endfield"].indexOf(b.gameId) || a.startsAt - b.startsAt);
}

test("быстрая сверка баннеров Kuro даёт тот же результат, что перебор, в том числе на границах двух суток", () => {
  let seed = 12345;
  const random = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const titles = ["Alpha", "alpha ", "Beta’s Banner", "Beta's  banner", "Gamma"];
  const games = ["wuthering", "genshin"] as const;
  const origin = utc(2026, 10, 1, 3, 0);
  // Сдвиги вокруг границы 172 800 с и вокруг границ окон: целое число окон и «окно ± 1 с».
  const offsets = [0, 1, 172799, 172800, 172801, 345599, 345600, 345601, 86400, 259200];
  const make = (): Banner => wuwa(titles[random(titles.length)]!, origin + offsets[random(offsets.length)]! * (random(2) === 0 ? 1 : -1) + random(5) * 172800, { gameId: games[random(games.length)]! });
  for (let round = 0; round < 50; round++) {
    const hub = hubOf(Array.from({ length: random(15) }, make));
    const kuro = Array.from({ length: random(40) }, make);
    assert.deepEqual(withKuroBanners(hub, kuro).banners, naiveWithKuro(hub, kuro), `раунд ${round}`);
  }
});
