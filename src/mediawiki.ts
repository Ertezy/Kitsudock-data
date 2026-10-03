// Обёртки над API MediaWiki: фандом и wiki.gg отвечают одинаково.

import type { Http } from "./http.ts";
import { isPublicHttpsUrl } from "./validate.ts";

export interface Wiki {
  api: string;
  pageUrl(title: string): string;
}

function wikiAt(origin: string): Wiki {
  return {
    api: `${origin}/api.php`,
    pageUrl: (title) =>
      `${origin}/wiki/${title
        .replace(/ /g, "_")
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`,
  };
}

export function fandom(subdomain: string): Wiki {
  return wikiAt(`https://${subdomain}.fandom.com`);
}

export const ENDFIELD_WIKI: Wiki = wikiAt("https://endfield.wiki.gg");

interface MwError {
  error?: { code?: string };
}

async function call(http: Http, wiki: Wiki, params: Record<string, string>): Promise<unknown> {
  const query = new URLSearchParams({ ...params, format: "json", formatversion: "2" });
  const res = await http.get(`${wiki.api}?${query}`);
  const json = JSON.parse(res.body) as MwError;
  if (json.error) throw new Error(`MediaWiki: ${json.error.code ?? "ошибка"}`);
  return json;
}

const normalizeTitle = (title: string) => title.replace(/_/g, " ");

/** Номера последних правок; отсутствующие страницы в карту не попадают. Ключ — название, как передали. */
export async function lastRevisions(http: Http, wiki: Wiki, titles: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const json = (await call(http, wiki, { action: "query", prop: "info", titles: batch.join("|") })) as {
      query?: { pages?: { title: string; lastrevid?: number; missing?: boolean }[] };
    };
    const byTitle = new Map((json.query?.pages ?? []).map((p) => [p.title, p]));
    for (const original of batch) {
      const page = byTitle.get(normalizeTitle(original));
      if (page && !page.missing && typeof page.lastrevid === "number") result.set(original, page.lastrevid);
    }
  }
  return result;
}

export async function pageWikitext(http: Http, wiki: Wiki, title: string): Promise<string> {
  const json = (await call(http, wiki, { action: "parse", page: title, prop: "wikitext" })) as {
    parse?: { wikitext?: string };
  };
  const text = json.parse?.wikitext;
  if (typeof text !== "string") throw new Error(`MediaWiki: нет текста страницы ${title}`);
  return text;
}

export async function categoryMembers(http: Http, wiki: Wiki, category: string, limit: number): Promise<string[]> {
  const json = (await call(http, wiki, {
    action: "query",
    list: "categorymembers",
    cmtitle: `Category:${category}`,
    cmsort: "timestamp",
    cmdir: "desc",
    cmlimit: String(limit),
    cmprop: "title",
  })) as { query?: { categorymembers?: { title: string }[] } };
  const members = json.query?.categorymembers;
  if (!Array.isArray(members)) throw new Error(`MediaWiki: нет категории ${category}`);
  return members.map((m) => m.title);
}

/** Ссылки на уменьшенные копии. Ключ — имя файла без «File:», с пробелами. */
export async function thumbnails(http: Http, wiki: Wiki, files: string[], width = 400): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const names = [...new Set(files.map(normalizeTitle))];
  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    const json = (await call(http, wiki, {
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      iiurlwidth: String(width),
      titles: batch.map((name) => `File:${name}`).join("|"),
    })) as { query?: { pages?: { title: string; missing?: boolean; imageinfo?: { thumburl?: string }[] }[] } };
    for (const page of json.query?.pages ?? []) {
      const thumb = page.imageinfo?.[0]?.thumburl;
      if (!page.missing && isPublicHttpsUrl(thumb)) result.set(page.title.replace(/^File:/, ""), thumb);
    }
  }
  return result;
}

/** Файл вики и момент его последней загрузки (секунды). */
export interface WikiFile {
  name: string;
  uploadedAt: number;
}

/** Файлы, имя которых начинается с prefix. Имена — без «File:», с пробелами; порядок — по имени. */
export async function filesWithPrefix(http: Http, wiki: Wiki, prefix: string, limit = 50): Promise<WikiFile[]> {
  const json = (await call(http, wiki, {
    action: "query",
    list: "allimages",
    aiprefix: prefix.replace(/ /g, "_"),
    aiprop: "timestamp",
    ailimit: String(limit),
  })) as { query?: { allimages?: { name: string; timestamp: string }[] } };
  return (json.query?.allimages ?? []).map((f) => ({ name: normalizeTitle(f.name), uploadedAt: Date.parse(f.timestamp) / 1000 }));
}

export async function expandTemplates(http: Http, wiki: Wiki, text: string): Promise<string> {
  const json = (await call(http, wiki, { action: "expandtemplates", text, prop: "wikitext" })) as {
    expandtemplates?: { wikitext?: string };
  };
  const out = json.expandtemplates?.wikitext;
  if (typeof out !== "string") throw new Error("MediaWiki: шаблон не раскрылся");
  return out;
}
