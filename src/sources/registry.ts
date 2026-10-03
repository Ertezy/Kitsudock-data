// Какие источники есть, как часто их спрашивать и как из ответа получить записи.

import { OUT_OF_TIME, timeIsUp } from "../deadline.ts";
import { isTransportError, type Http, type Validators } from "../http.ts";
import { isLive, judge } from "../items.ts";
import { ENDFIELD_WIKI, categoryMembers, expandTemplates, fandom, lastRevisions, pageWikitext, thumbnails, type Wiki } from "../mediawiki.ts";
import { GAME_IDS, VIDEO_LANGS, type AppRelease, type Banner, type Code, type GameBackground, type GameId, type Item, type Section, type SourceRun, type VideoLang } from "../types.ts";
import { KURO_ARTICLES_BUDGET_MS, MAX_BANNERS_PER_GAME, MAX_KURO_ARTICLES_PER_RUN } from "../validate.ts";
import type { ArtMemory } from "./art.ts";
import { BANNER_PAGES, parseBannerPage, parseEndfieldTable, parseEnneadBanners, recentBannerPages, type BannerDraft, type BannerPageSpec, type PageOutcome } from "./banners.ts";
import { parseEnneadCodes, parseRowCodes, parseWuwaCodes } from "./codes.ts";
import {
  KURO_ARTICLE_JSON_DIR,
  KURO_MENU_URL,
  articleText,
  articleTitle,
  conveneAnnouncements,
  hasLiveBanner,
  isFresh,
  kuroArticleJsonUrl,
  kuroBannerFacts,
  kuroBanners,
  maintenanceEnd,
  type Announcement,
  type AnnouncementFacts,
  type KuroBannerFact,
  type PatchNotes,
} from "./kuro.ts";
import { CHANNELS, feedUrl, parseYoutubeFeed } from "./videos.ts";

export interface SourceMemory {
  revisions: Record<string, number>;
  pages: Record<string, { rev: number; outcome: PageOutcome }>;
  validators: Record<string, Validators>;
  /** Анонсы баннеров персонажей из меню Kuro: свежие (не старше 21 дня) и старше, пока идёт их баннер; новые первыми. */
  kuro: Announcement[];
  /** Свежие патчноуты из меню: при ответе 304 по ним видно, какие статьи ещё читать. */
  kuroPatchNotes: PatchNotes[];
  /**
   * Баннеры, прочитанные из статьи анонса, — по номеру статьи строкой. Только факты, текста нет.
   * Ключ есть — статья прочитана (пустой список: баннеров в ней не нашлось); ключа нет — её ещё не удалось прочитать.
   */
  kuroFacts: Record<string, KuroBannerFact[]>;
  /** Конец техработ версии, из её патчноута, — по номеру версии. */
  kuroReleases: Record<string, number>;
  /**
   * Статьи, при чтении которых был сбой связи (таймаут, обрыв), — по номеру статьи строкой, со временем (секунды) последнего сбоя.
   * Такие статьи читаются после остальных, самая давно отложенная первой, а удачное чтение снимает отметку:
   * статья, что всегда не отвечает, не должна держать все остальные. Отметка живёт, пока статья в свежем окне меню.
   */
  kuroDeferred: Record<string, number>;
  /** Арт прошлого запуска для баннеров без картинки (sources/art.ts). */
  bannerArt: ArtMemory;
  /** Последняя опубликованная версия приложения (sources/appRelease.ts); null — релизов нет или ещё не спрашивали. */
  appRelease: AppRelease | null;
  /** Фоны официального лаунчера HoYoPlay по играм (sources/launcherArt.ts). */
  launcherArt: Partial<Record<GameId, GameBackground>>;
}

export const emptyMemory = (): SourceMemory => ({
  revisions: {},
  pages: {},
  validators: {},
  kuro: [],
  kuroPatchNotes: [],
  kuroFacts: {},
  kuroReleases: {},
  kuroDeferred: {},
  bannerArt: {},
  appRelease: null,
  launcherArt: {},
});

export interface SourceContext {
  http: Http;
  now: number;
  memory: SourceMemory;
  /** Монотонные часы в миллисекундах для бюджетов времени; по умолчанию performance.now (в тестах подставляются свои). */
  clock?: () => number;
  /** Срок прогона по тем же часам (RUN_BUDGET_MS от старта процесса): после него новые запросы не начинаются. Нет — срока нет. */
  deadline?: number;
}

export interface SourceDef {
  id: string;
  game: GameId;
  section: Section;
  /** Только у видео: язык канала. Входит в ключ раздела (`genshin:videos:ja`). */
  lang?: VideoLang;
  label: string;
  everyHours: number;
  fallback: boolean;
  /**
   * Источники одной ленты — с общим хостом: запросы к нему всё равно встают в очередь (http.ts). Они идут один за
   * другим, и между ними видно, что срок вышел или сайт не отвечает, — остаток пропускается. Без ленты источник идёт сам по себе.
   */
  lane?: string;
  run(ctx: SourceContext): Promise<SourceRun<Item>>;
}

const TITLES: Record<GameId, string> = {
  genshin: "Genshin Impact",
  hsr: "Honkai: Star Rail",
  zzz: "Zenless Zone Zero",
  wuthering: "Wuthering Waves",
  endfield: "Arknights: Endfield",
};

const ENNEAD_SLUGS: Record<"genshin" | "hsr" | "zzz", string> = { genshin: "genshin", hsr: "starrail", zzz: "zenless" };

/** Любое исключение внутри источника превращается в его поломку; у сбоя связи (isTransportError) она с пометкой. */
async function guarded(run: () => Promise<SourceRun<Item>>): Promise<SourceRun<Item>> {
  try {
    return await run();
  } catch (error) {
    const message = (error as Error).message;
    return isTransportError(error) ? { kind: "broken", error: message, transport: true } : { kind: "broken", error: message };
  }
}

/** Не хватило времени прогона: источник пропущен, прошлые данные остаются, поломкой это не считается. */
const outOfTime = (): SourceRun<Item> => ({ kind: "skipped", reason: OUT_OF_TIME });

/**
 * Коды, что попадут в файл: ещё не сгоревшие (сгоревшие mergeHub всё равно выбросит). Предел
 * MAX_CODES_PER_GAME считается по ним: страница с длинной историей сгоревших кодов — не поток.
 */
const liveCodes = (codes: Code[], now: number): Code[] => codes.filter((c) => isLive("codes", c, now));

function fandomCodes(id: string, game: GameId, subdomain: string, page: string, template: "Code Row" | "Redemption Code Row" | "wuwa"): SourceDef {
  return {
    id,
    game,
    section: "codes",
    label: `коды ${TITLES[game]} (фандом)`,
    everyHours: 1,
    fallback: false,
    run: ({ http, now, memory }) =>
      guarded(async () => {
        const wiki = fandom(subdomain);
        const rev = (await lastRevisions(http, wiki, [page])).get(page);
        if (rev === undefined) return { kind: "broken", error: `страница ${page} не найдена` };
        const key = `${wiki.api}|${page}`;
        if (memory.revisions[key] === rev) return { kind: "unchanged" };
        const text = await pageWikitext(http, wiki, page);
        const url = wiki.pageUrl(page);
        const r = template === "wuwa" ? parseWuwaCodes(text, url) : parseRowCodes(text, template, game, url);
        const verdict = judge("codes", r.found, liveCodes(r.codes, now), r.parsed, r.dropped);
        if (verdict.kind === "ok") memory.revisions[key] = rev;
        return verdict;
      }),
  };
}

/** GET с условными заголовками: 304 — null; метки версий отдаются вызвавшему, чтобы запомнить после разбора. */
async function conditional(ctx: SourceContext, url: string): Promise<{ body: string; validators: Validators } | null> {
  const res = await ctx.http.get(url, ctx.memory.validators[url] ?? {});
  return res.status === 304 ? null : { body: res.body, validators: res.validators };
}

function ennead(game: "genshin" | "hsr" | "zzz", section: "codes" | "banners"): SourceDef {
  const url = `https://api.ennead.cc/mihoyo/${ENNEAD_SLUGS[game]}/${section === "codes" ? "codes" : "calendar"}`;
  return {
    id: `${game}-${section}-ennead`,
    game,
    section,
    label: `${section === "codes" ? "коды" : "баннеры"} ${TITLES[game]} (ennead.cc)`,
    everyHours: section === "codes" ? 1 : 6,
    fallback: true,
    lane: "ennead",
    run: (ctx) =>
      guarded(async () => {
        const res = await conditional(ctx, url);
        if (res === null) return { kind: "unchanged" };
        const data: unknown = JSON.parse(res.body);
        const verdict =
          section === "codes"
            ? (() => {
                const r = parseEnneadCodes(data, game);
                return judge("codes", r.found, liveCodes(r.codes, ctx.now), r.parsed, r.dropped);
              })()
            : (() => {
                const r = parseEnneadBanners(data, game);
                return judge("banners", r.found, newestLive(r.banners, (b) => b, ctx.now), r.parsed, r.dropped);
              })();
        if (verdict.kind === "ok") ctx.memory.validators[url] = res.validators;
        return verdict;
      }),
  };
}

/**
 * Баннеры, что попадут в файл: идущие и будущие (закончившиеся mergeHub всё равно
 * выбросит), самые новые первыми и не больше MAX_BANNERS_PER_GAME. Так у всех источников
 * баннеров один предел, а миниатюры просятся только для оставшихся: сколько бы строк ни
 * отдала страница, это один запрос.
 */
export function newestLive<T>(items: T[], bannerOf: (item: T) => Banner, now: number): T[] {
  return items
    .filter((item) => isLive("banners", bannerOf(item), now))
    .sort((a, b) => bannerOf(b).startsAt - bannerOf(a).startsAt)
    .slice(0, MAX_BANNERS_PER_GAME);
}

const publishable = (drafts: BannerDraft[], now: number): BannerDraft[] => newestLive(drafts, (d) => d.banner, now);

/**
 * Баннеры с миниатюрами. null — миниатюры нужны, а срок прогона вышел: источник пропускается и оставляет прошлые
 * баннеры вместе с их картинками, а не заменяет их баннерами без картинок.
 */
async function withThumbnails(ctx: SourceContext, wiki: Wiki, drafts: BannerDraft[]): Promise<Banner[] | null> {
  const files = drafts.flatMap((d) => (d.imageFile ? [d.imageFile] : []));
  let thumbs = new Map<string, string>();
  if (files.length > 0) {
    if (timeIsUp(ctx)) return null;
    try {
      thumbs = await thumbnails(ctx.http, wiki, files);
    } catch {
      // Без миниатюр баннеры остаются с градиентом в приложении; источник не ломается.
    }
  }
  return drafts.map((d) => ({ ...d.banner, image: d.imageFile ? (thumbs.get(d.imageFile.replace(/_/g, " ")) ?? null) : null }));
}

function fandomBanners(spec: BannerPageSpec): SourceDef {
  return {
    id: `${spec.gameId}-banners`,
    game: spec.gameId,
    section: "banners",
    label: `баннеры ${TITLES[spec.gameId]} (фандом)`,
    everyHours: 6,
    fallback: false,
    run: (ctx) =>
      guarded(async () => {
        const { http, now, memory } = ctx;
        const wiki = fandom(spec.wiki);
        const titles = recentBannerPages(await categoryMembers(http, wiki, spec.category, MAX_BANNERS_PER_GAME), now);
        const revs = titles.length > 0 ? await lastRevisions(http, wiki, titles) : new Map<string, number>();
        const drafts: BannerDraft[] = [];
        let parsed = 0;
        let dropped = 0;
        const current = new Set<string>();
        for (const title of titles) {
          const rev = revs.get(title);
          if (rev === undefined) continue;
          const key = `${wiki.api}|${title}`;
          current.add(key);
          let outcome = memory.pages[key]?.rev === rev ? memory.pages[key]!.outcome : undefined;
          if (outcome === undefined) {
            // Срок вышел — страницы не дочитываются: уже разобранные лежат в памяти, остальные дочитает следующий прогон.
            if (timeIsUp(ctx)) return outOfTime();
            outcome = parseBannerPage(await pageWikitext(http, wiki, title), spec, title, wiki.pageUrl(title));
            // Сломанная страница не запоминается — её нужно перечитать в следующий раз,
            // когда шаблон поправят; удачный разбор (баннер или сознательный skip) кешируется.
            if (outcome.kind !== "bad") memory.pages[key] = { rev, outcome };
          }
          if (outcome.kind === "banner") {
            parsed++;
            drafts.push(outcome.draft);
          } else if (outcome.kind === "bad") {
            parsed++;
            dropped++;
          }
        }
        for (const key of Object.keys(memory.pages)) {
          if (key.startsWith(`${wiki.api}|`) && !current.has(key)) delete memory.pages[key];
        }
        const banners = await withThumbnails(ctx, wiki, publishable(drafts, now));
        return banners === null ? outOfTime() : judge("banners", true, banners, parsed, dropped);
      }),
  };
}

const endfieldBanners: SourceDef = {
  id: "endfield-banners",
  game: "endfield",
  section: "banners",
  label: "баннеры Arknights: Endfield (wiki.gg)",
  everyHours: 6,
  fallback: false,
  run: (ctx) =>
    guarded(async () => {
      const { http, now } = ctx;
      const text = await expandTemplates(http, ENDFIELD_WIKI, "{{Banner table|current}}\n{{Banner table|upcoming}}");
      const r = parseEndfieldTable(text, ENDFIELD_WIKI.pageUrl("Headhunting/Banners"));
      const banners = await withThumbnails(ctx, ENDFIELD_WIKI, publishable(r.drafts, now));
      return banners === null ? outOfTime() : judge("banners", true, banners, r.parsed, r.dropped);
    }),
};

const LANG_LABELS: Record<VideoLang, string> = { en: "англ.", ja: "япон." };

function youtube(game: GameId, lang: VideoLang): SourceDef {
  const channel = CHANNELS[lang][game];
  const url = feedUrl(channel);
  return {
    id: `${game}-videos-${lang}`,
    game,
    section: "videos",
    lang,
    label: `видео ${TITLES[game]} (YouTube, ${LANG_LABELS[lang]})`,
    everyHours: 1,
    fallback: false,
    lane: "youtube",
    run: (ctx) =>
      guarded(async () => {
        const res = await conditional(ctx, url);
        if (res === null) return { kind: "unchanged" };
        const r = parseYoutubeFeed(res.body, game, channel, lang);
        const verdict = judge("videos", r.found, r.videos, r.parsed, r.dropped);
        if (verdict.kind === "ok") ctx.memory.validators[url] = res.validators;
        return verdict;
      }),
  };
}

export const SOURCES: SourceDef[] = [
  fandomCodes("genshin-codes", "genshin", "genshin-impact", "Promotional_Code", "Code Row"),
  ennead("genshin", "codes"),
  fandomCodes("hsr-codes", "hsr", "honkai-star-rail", "Redemption_Code", "Redemption Code Row"),
  ennead("hsr", "codes"),
  fandomCodes("zzz-codes", "zzz", "zenless-zone-zero", "Redemption_Code", "Redemption Code Row"),
  ennead("zzz", "codes"),
  fandomCodes("wuthering-codes", "wuthering", "wutheringwaves", "Redemption_Code", "wuwa"),
  fandomBanners(BANNER_PAGES.genshin),
  ennead("genshin", "banners"),
  fandomBanners(BANNER_PAGES.hsr),
  ennead("hsr", "banners"),
  fandomBanners(BANNER_PAGES.zzz),
  ennead("zzz", "banners"),
  fandomBanners(BANNER_PAGES.wuthering),
  endfieldBanners,
  ...GAME_IDS.flatMap((game) => VIDEO_LANGS.map((lang) => youtube(game, lang))),
];

export const KURO_SIGNAL = { id: "wuthering-signal", label: "анонсы баннеров Wuthering Waves (сайт Kuro Games)", everyHours: 6 } as const;

/**
 * Меню Kuro и статьи из него: анонсы баннеров и патчноуты. Всё условными запросами;
 * то, что уже разобрано, лежит в памяти. Сбой меню — поломка источника; сбой статьи
 * (сеть, статус не 200, не JSON) — предупреждение: прошлые факты остаются, статья перечитывается
 * в следующий раз. Ответ 200 без текста статьи — другое дело: статья считается прочитанной без баннеров.
 * Окно в 21 день ограничивает, какие анонсы читаются и берутся для сигнала (это
 * `announcements` в ответе); в памяти (`memory.kuro`) анонс остаётся, пока идёт хотя
 * бы один его баннер.
 */
export async function fetchKuroAnnouncements(
  ctx: SourceContext,
): Promise<{ ok: true; announcements: Announcement[]; warnings: string[] } | { ok: false; error: string }> {
  try {
    const { memory, now } = ctx;
    const res = await conditional(ctx, KURO_MENU_URL);
    let announcements: Announcement[];
    let patchNotes: PatchNotes[];
    if (res === null) {
      // Меню не менялось; списки из памяти тоже стареют.
      announcements = memory.kuro.filter((a) => isFresh(a.publishedAt, now));
      patchNotes = memory.kuroPatchNotes.filter((p) => isFresh(p.publishedAt, now));
    } else {
      const r = conveneAnnouncements(JSON.parse(res.body), now);
      if (!r.found) return { ok: false, error: "список новостей не разобрался" };
      announcements = r.announcements;
      patchNotes = r.patchNotes;
      memory.validators[KURO_MENU_URL] = res.validators;
    }
    // Вышедший из окна анонс не читается заново, но его баннеры идут, пока не закончатся.
    const freshIds = new Set(announcements.map((a) => a.articleId));
    const retained = memory.kuro.filter((a) => !freshIds.has(a.articleId) && hasLiveBanner(memory.kuroFacts[String(a.articleId)], now));
    memory.kuro = [...announcements, ...retained].sort((a, b) => b.publishedAt - a.publishedAt);
    memory.kuroPatchNotes = patchNotes;
    return { ok: true, announcements, warnings: await readKuroArticles(ctx, announcements, patchNotes) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Читает статьи анонсов и патчноутов, запоминает факты и забывает всё, что устарело. Возвращает предупреждения.
 * Меню может отдать сколько угодно статей, а читается за прогон не больше MAX_KURO_ARTICLES_PER_RUN самых
 * новых; остальные — не ошибка: их прочтёт следующий прогон, когда новее них станет меньше, или они устареют.
 * Время тоже ограничено: сбой связи (таймаут, обрыв) обрывает чтение — сайт не отвечает, остальным статьям
 * не лучше, — и вышедший бюджет KURO_ARTICLES_BUDGET_MS или срок всего прогона (ctx.deadline) обрывает его так же.
 * Без этого тридцать статей по 45 секунд (таймаут и повтор) не укладывались бы в лимит прогона, и состояние не сохранялось бы.
 * Ответ с кодом (404 и подобные) и не JSON — про одну статью: чтение идёт дальше.
 * Статья, на которой был сбой связи, откладывается (`memory.kuroDeferred`) и в следующие прогоны читается последней:
 * иначе самая новая статья, что всегда не отвечает, обрывала бы чтение каждый раз и ни одна старая не прочиталась бы.
 * Среди отложенных первой идёт отложенная раньше, так что они чередуются.
 */
async function readKuroArticles(ctx: SourceContext, announcements: Announcement[], patchNotes: PatchNotes[]): Promise<string[]> {
  const { memory } = ctx;
  const published = new Map<number, number>();
  for (const { articleId, publishedAt } of [...announcements, ...patchNotes]) {
    published.set(articleId, Math.max(published.get(articleId) ?? publishedAt, publishedAt));
  }
  let ids = [...published.keys()];
  if (ids.length > MAX_KURO_ARTICLES_PER_RUN) {
    const newest = new Set([...ids].sort((a, b) => published.get(b)! - published.get(a)!).slice(0, MAX_KURO_ARTICLES_PER_RUN));
    ids = ids.filter((id) => newest.has(id)); // порядок прежний: сперва анонсы, затем патчноуты
  }
  // Отложенные — в конец; остальные в прежнем порядке (сперва анонсы, затем патчноуты), отложенные — самая давняя первой.
  const deferred = memory.kuroDeferred;
  const isDeferred = (id: number) => Object.hasOwn(deferred, String(id));
  ids = [...ids.filter((id) => !isDeferred(id)), ...ids.filter(isDeferred).sort((a, b) => deferred[String(a)]! - deferred[String(b)]!)];
  // Поиски по номеру статьи и версии — через таблицы: поиск перебором по спискам на каждую статью вырос бы в квадрат.
  const announced = new Set(announcements.map((a) => a.articleId));
  const notesOf = new Map<number, PatchNotes[]>();
  const newestOfVersion = new Map<string, number>(); // версия → статья самого нового её патчноута (список идёт от новых к старым)
  for (const note of patchNotes) {
    const same = notesOf.get(note.articleId);
    if (same) same.push(note);
    else notesOf.set(note.articleId, [note]);
    if (!newestOfVersion.has(note.version)) newestOfVersion.set(note.version, note.articleId);
  }
  const warnings: string[] = [];
  const clock = ctx.clock ?? (() => performance.now());
  const started = clock();
  for (const id of ids) {
    if (clock() - started >= KURO_ARTICLES_BUDGET_MS || timeIsUp(ctx)) {
      warnings.push("чтение статей Kuro остановлено: вышло время, остальные — в следующий прогон");
      break;
    }
    const url = kuroArticleJsonUrl(id);
    try {
      const res = await conditional(ctx, url);
      delete deferred[String(id)]; // ответ пришёл (200 или 304) — статья снова отвечает
      if (res === null) continue; // не менялась — прошлый результат остаётся
      const article: unknown = JSON.parse(res.body);
      // Ответ 200 без текста статьи (не объект, нет articleContent или он не строка) — статья прочитана, баннеров
      // в ней нет: так смена формата JSON не остаётся незамеченной, а по свежему анонсу открывается задача.
      // Уже найденные баннеры такой ответ не стирает — разовый сбой сайта не прячет их из панели.
      const text = articleText(article);
      if (text === null) warnings.push(`статья Kuro ${id}: в ответе нет текста статьи — считается прочитанной без баннеров`);
      const lines = text ?? [];
      // Ключ в kuroFacts появляется, только когда статья прочитана; пустой список — баннеров в ней не нашлось.
      // Статья, которую не удалось открыть (сеть, статус не 200, не JSON), ключа не получает (и не даёт сигнала),
      // а прошлые факты остаются.
      if (announced.has(id)) {
        const key = String(id);
        const previous = memory.kuroFacts[key];
        const keep = text === null && previous !== undefined && previous.length > 0;
        memory.kuroFacts[key] = keep ? previous : kuroBannerFacts(lines, articleTitle(article));
      }
      const end = maintenanceEnd(lines);
      for (const { version } of notesOf.get(id) ?? []) {
        // Строки техработ нет — уже известный срок версии не трогается. Два патчноута одной версии:
        // побеждает более новый (патчноуты идут от новых к старым), старый пишет, только если срока нет.
        const newest = newestOfVersion.get(version) === id;
        if (end !== null && (newest || memory.kuroReleases[version] === undefined)) memory.kuroReleases[version] = end;
      }
      memory.validators[url] = res.validators;
    } catch (error) {
      warnings.push(`статья Kuro ${id}: ${(error as Error).message}`);
      if (isTransportError(error)) {
        deferred[String(id)] = ctx.now;
        warnings.push("чтение статей Kuro остановлено: сайт не отвечает, остальные — в следующий прогон");
        break;
      }
    }
  }
  // Факты и сроки версий живут, пока анонс в памяти (свежий или с идущим баннером).
  const factIds = new Set(memory.kuro.map((a) => String(a.articleId)));
  for (const key of Object.keys(memory.kuroFacts)) if (!factIds.has(key)) delete memory.kuroFacts[key];
  const versions = new Set(patchNotes.map((p) => p.version));
  for (const banners of Object.values(memory.kuroFacts)) {
    for (const { start } of banners) if (start.kind === "release") versions.add(start.version);
  }
  for (const version of Object.keys(memory.kuroReleases)) if (!versions.has(version)) delete memory.kuroReleases[version];
  for (const key of Object.keys(deferred)) if (!published.has(Number(key))) delete deferred[key]; // статья вышла из свежего окна меню
  const urls = new Set(ids.map(kuroArticleJsonUrl));
  for (const url of Object.keys(memory.validators)) if (url.startsWith(KURO_ARTICLE_JSON_DIR) && !urls.has(url)) delete memory.validators[url];
  return warnings;
}

/** Анонсы вместе с баннерами, что разобраны из их статей и лежат в памяти. */
export const kuroFactsFromMemory = (memory: SourceMemory, announcements: Announcement[]): AnnouncementFacts[] =>
  announcements.map((announcement) => ({ announcement, banners: memory.kuroFacts[String(announcement.articleId)] ?? [] }));

/**
 * Баннеры Kuro для файла: из памяти, идущие и будущие, самые новые первыми и не больше
 * MAX_BANNERS_PER_GAME — тот же предел, что у баннеров любого другого источника. Так
 * число баннеров Kuro и запросов арта к ним не зависит от того, сколько их отдали статьи.
 */
export const kuroBannersFromMemory = (memory: SourceMemory, now: number): Banner[] =>
  newestLive(kuroBanners(kuroFactsFromMemory(memory, memory.kuro), memory.kuroReleases, now), (banner) => banner, now);
