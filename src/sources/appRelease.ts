// Последняя опубликованная версия приложения — для строки «Вышла версия» в панели
// (спека приложения docs/specs/2026-10-01-update-notice-design.md, §2.1).
//
// Адрес releases/latest отдаёт только опубликованный релиз: черновики и пробные
// версии в ответ не попадают. Условный запрос: ответ 304 не тратит лимит API.

import { StatusError, type Http } from "../http.ts";
import type { AppRelease } from "../types.ts";
import { appUrlOk } from "../validate.ts";
import type { SourceMemory } from "./registry.ts";

export const APP_RELEASE_URL = "https://api.github.com/repos/Ertezy/Kitsudock/releases/latest";

export const APP_RELEASE = { id: "app-release", label: "последняя версия приложения (GitHub Releases)", everyHours: 6 } as const;

// Ту же проверку («три числа») делает приложение: `src-tauri/src/hub/schema.rs` и `src/lib/update.ts`.
export const VERSION = /^\d+\.\d+\.\d+$/;

/** Номер (без ведущей «v») и страница релиза из ответа GitHub; ответ не той формы — null. */
export function parseAppRelease(json: unknown): AppRelease | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const { tag_name: tag, html_url: url, draft, prerelease } = json as Record<string, unknown>;
  if (draft === true || prerelease === true) return null;
  // Страница релиза — только релизы Kitsudock на GitHub, как требует и validateHub.
  if (typeof tag !== "string" || !appUrlOk(url)) return null;
  const version = tag.replace(/^v/, "");
  return VERSION.test(version) ? { version, url } : null;
}

/**
 * Обновляет memory.appRelease. 304 — без изменений; 404 — опубликованных релизов нет,
 * поле убирается. Сбой или ответ не той формы — ошибка источника, прошлое значение остаётся.
 */
export async function fetchAppRelease(
  http: Http,
  memory: SourceMemory,
  token: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await http.get(APP_RELEASE_URL, memory.validators[APP_RELEASE_URL] ?? {}, headers);
    if (res.status === 304) return { ok: true };
    const release = parseAppRelease(JSON.parse(res.body));
    if (release === null) return { ok: false, error: "ответ GitHub не той формы" };
    memory.appRelease = release;
    memory.validators[APP_RELEASE_URL] = res.validators;
    return { ok: true };
  } catch (error) {
    if (error instanceof StatusError && error.status === 404) {
      memory.appRelease = null;
      delete memory.validators[APP_RELEASE_URL];
      return { ok: true };
    }
    return { ok: false, error: (error as Error).message };
  }
}
