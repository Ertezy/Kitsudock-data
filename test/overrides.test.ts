import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverrides, bannerStarts, parseMoment, parseOverrides } from "../src/overrides.ts";
import type { Banner, Code, HubData } from "../src/types.ts";

const utc = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const NOW = utc(2026, 9, 16, 12, 0);

test("время с поясом; без пояса — ошибка", () => {
  assert.equal(parseMoment("2026-10-01 23:59 UTC+8"), utc(2026, 10, 1, 15, 59));
  assert.equal(parseMoment("2026-09-29 11:59 UTC+1"), utc(2026, 9, 29, 10, 59));
  assert.equal(parseMoment("2026-10-01 UTC+0"), utc(2026, 10, 1, 23, 59, 59));
  assert.equal(parseMoment("2026-10-01 23:59"), null);
  assert.equal(parseMoment("завтра UTC+3"), null);
});

test("разбор правок: все ошибки сразу", () => {
  const r = parseOverrides({
    codes: [{ game: "nope", code: "ABCD1234" }, { game: "endfield", code: "BAD CODE" }, { game: "endfield", code: "GOODCODE", expires: "soon" }],
    banners: [{ game: "wuthering", title: "T", starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-01 10:00 UTC+1" }],
    hide: [{ game: "genshin" }],
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errors.length, 5);
  assert.match(r.errors[0]!, /^codes\[0\]/);
});

test("пустой и частичный файл правок читается", () => {
  const r = parseOverrides({ codes: [] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.overrides, { codes: [], banners: [], hide: [] });
  assert.equal(parseOverrides([]).ok, false);
});

const wikiCode: Code = { gameId: "hsr", code: "WIKICODE1", rewards: "Stellar Jade ×50", expiresAt: null, region: "all", source: "https://wiki" };
const wikiBanner: Banner = { gameId: "wuthering", title: "Known Banner", featured: ["A"], rarity: 5, image: null, startsAt: NOW - 100, endsAt: NOW + 100, url: "https://wiki/b" };
const hub: HubData = { version: 2, updatedAt: NOW, games: [], codes: [wikiCode], banners: [wikiBanner], videos: [] };

test("код: новый добавляется, совпавший берёт награду и срок из правки, скрытый исчезает", () => {
  const parsed = parseOverrides({
    codes: [
      { game: "endfield", code: "ENDFIELDGIFT", rewards: "150 Oroberyl", expires: "2026-10-01 23:59 UTC+8" },
      { game: "hsr", code: "wikicode1", rewards: "Stellar Jade ×60", expires: "2026-09-30 UTC+0" },
      { game: "endfield", code: "OLDCODE1", expires: "2026-09-01 10:00 UTC+0" },
    ],
    hide: [{ game: "hsr", code: "NOSUCH12" }],
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const out = applyOverrides(hub, parsed.overrides, NOW);
  assert.deepEqual(out.codes, [
    { ...wikiCode, rewards: "Stellar Jade ×60", expiresAt: utc(2026, 9, 30, 23, 59, 59) },
    { gameId: "endfield", code: "ENDFIELDGIFT", rewards: "150 Oroberyl", expiresAt: utc(2026, 10, 1, 15, 59), region: "all", source: null },
  ]);
  const hidden = parseOverrides({ hide: [{ game: "hsr", code: "WIKICODE1" }] });
  assert.ok(hidden.ok);
  if (hidden.ok) assert.deepEqual(applyOverrides(hub, hidden.overrides, NOW).codes, []);
});

test("баннер: новый добавляется, известный источнику не дублируется, скрытый исчезает", () => {
  const parsed = parseOverrides({
    banners: [
      { game: "wuthering", title: "Thousand Futures Mirrored in Snow", featured: ["Hiyuki"], starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-29 11:59 UTC+1" },
      { game: "wuthering", title: "known banner", starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-29 11:59 UTC+1" },
    ],
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const out = applyOverrides(hub, parsed.overrides, NOW);
  // Баннеры одной игры идут по началу: добавленный начался 10 сентября, известный — только что.
  assert.deepEqual(out.banners.map((b) => b.title), ["Thousand Futures Mirrored in Snow", "Known Banner"]);
  assert.deepEqual(out.banners[0], {
    gameId: "wuthering",
    title: "Thousand Futures Mirrored in Snow",
    featured: ["Hiyuki"],
    rarity: 5,
    image: null,
    startsAt: utc(2026, 9, 10, 9, 0),
    endsAt: utc(2026, 9, 29, 10, 59),
    url: null,
  });
  const hidden = parseOverrides({ hide: [{ game: "wuthering", banner: "KNOWN BANNER" }] });
  assert.ok(hidden.ok);
  if (hidden.ok) assert.deepEqual(applyOverrides(hub, hidden.overrides, NOW).banners, []);
});

test("null и неправильный тип в записях — ошибка, не throw", () => {
  const r = parseOverrides({ codes: [null], banners: [null], hide: [null] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0]!, /^codes\[0\]/);
  assert.match(r.errors[1]!, /^banners\[0\]/);
  assert.match(r.errors[2]!, /^hide\[0\]/);
});

test("верхний уровень: неправильный тип поля", () => {
  const r = parseOverrides({ codes: {} });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /^codes:/);
});

test("начала баннеров игры из файла правок: чужие игры и коды не в счёт", () => {
  const parsed = parseOverrides({
    banners: [
      { game: "wuthering", title: "First", starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-29 11:59 UTC+1" },
      { game: "hsr", title: "Other Game", starts: "2026-09-11 10:00 UTC+8", ends: "2026-09-30 11:59 UTC+8" },
      { game: "wuthering", title: "Second", starts: "2026-10-01 12:00 UTC+8", ends: "2026-10-20 11:59 UTC+8" },
    ],
    codes: [{ game: "wuthering", code: "ABCD1234" }],
    hide: [{ game: "wuthering", banner: "Hidden" }],
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(bannerStarts(parsed.overrides, "wuthering"), [utc(2026, 9, 10, 9, 0), utc(2026, 10, 1, 4, 0)]);
  assert.deepEqual(bannerStarts(parsed.overrides, "hsr"), [utc(2026, 9, 11, 2, 0)]);
  assert.deepEqual(bannerStarts(parsed.overrides, "genshin"), []);
  assert.deepEqual(bannerStarts({ codes: [], banners: [], hide: [] }, "wuthering"), []);
});

// check-overrides должен отвергать всё, что отвергла бы проверка файла перед выкладкой.
test("правки: больше 10 имён в featured, имя длиннее 80 знаков и пустое имя — ошибки", () => {
  const banner = (featured: unknown) => ({ game: "wuthering", title: "T", featured, starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-29 11:59 UTC+1" });
  const names = (n: number) => Array.from({ length: n }, (_, i) => `Name ${i}`);
  assert.equal(parseOverrides({ banners: [banner(names(10))] }).ok, true, "десять имён — предел");
  assert.equal(parseOverrides({ banners: [banner(["x".repeat(80)])] }).ok, true, "80 знаков — предел");
  for (const bad of [names(11), ["x".repeat(81)], [""], ["  "]]) {
    const r = parseOverrides({ banners: [banner(bad)] });
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 40));
    if (!r.ok) assert.match(r.errors[0]!, /^banners\[0\]: featured/);
  }
});

test("правки: название баннера, код и награда проверяются теми же правилами, что и файл", () => {
  const starts = { starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-29 11:59 UTC+1" };
  assert.equal(parseOverrides({ banners: [{ game: "hsr", title: "x".repeat(200), ...starts }] }).ok, true);
  assert.equal(parseOverrides({ banners: [{ game: "hsr", title: "x".repeat(201), ...starts }] }).ok, false);
  assert.equal(parseOverrides({ banners: [{ game: "hsr", title: "   ", ...starts }] }).ok, false);
  assert.equal(parseOverrides({ codes: [{ game: "hsr", code: "ABCD", rewards: "x".repeat(300) }] }).ok, true);
  assert.equal(parseOverrides({ codes: [{ game: "hsr", code: "ABCD", rewards: "x".repeat(301) }] }).ok, false);
  assert.equal(parseOverrides({ codes: [{ game: "hsr", code: "ABC" }] }).ok, false);
  assert.equal(parseOverrides({ codes: [{ game: "hsr", code: "a1".repeat(20) + "z" }] }).ok, false);
});

test("правки: image и url — только обычные https-адреса, как в проверке файла", () => {
  const banner = (extra: Record<string, unknown>) => ({ game: "wuthering", title: "T", starts: "2026-09-10 10:00 UTC+1", ends: "2026-09-29 11:59 UTC+1", ...extra });
  const good = [
    "https://static.wikia.nocookie.net/example-wiki/images/a/ab/Example.png/revision/latest/scale-to-width-down/400?cb=20260101000000",
    "https://wutheringwaves.fandom.com/wiki/Example_Banner/2026-01-01",
  ];
  for (const url of good) {
    assert.equal(parseOverrides({ banners: [banner({ image: url })] }).ok, true, url);
    assert.equal(parseOverrides({ banners: [banner({ url })] }).ok, true, url);
  }
  const bad = [
    "http://cdn.example.test/a.png",
    "https://u:p@cdn.example.test/a.png",
    "https://cdn.example.test:8443/a.png",
    "https://192.168.1.1/a.png",
    "https://[::1]/a.png",
    "https://cdn.example.test/a b.png",
    `https://cdn.example.test/${"a".repeat(2100)}`,
  ];
  for (const url of bad) {
    for (const field of ["image", "url"]) {
      const r = parseOverrides({ banners: [banner({ [field]: url })] });
      assert.equal(r.ok, false, `${field}: ${url.slice(0, 60)}`);
      if (!r.ok) assert.match(r.errors[0]!, /^banners\[0\]: image и url/);
    }
  }
});
