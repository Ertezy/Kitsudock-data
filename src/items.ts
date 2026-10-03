// Оценка источника за запуск (спека §5.1) и сгоревшее (§5.2).

import type { Banner, Code, Item, Section, SourceRun } from "./types.ts";
import { MAX_CODES_PER_GAME } from "./validate.ts";

export function judge<T extends Item>(section: Section, found: boolean, items: T[], parsed: number, dropped: number): SourceRun<T> {
  if (!found) return { kind: "broken", error: "раздел не найден" };
  // Поток кодов одной игры — не новые данные, а испорченная страница: источник сломан, прошлые коды остаются.
  if (section === "codes" && items.length > MAX_CODES_PER_GAME) return { kind: "broken", error: `кодов ${items.length}, больше предела ${MAX_CODES_PER_GAME}` };
  if (parsed > 0 && dropped * 2 > parsed) return { kind: "broken", error: `выброшено ${dropped} из ${parsed}` };
  if (section === "banners" && parsed === 0) return { kind: "broken", error: "ни одного баннера" };
  if (section === "videos" && items.length === 0) return { kind: "broken", error: "ни одного ролика" };
  return { kind: "ok", items, parsed, dropped };
}

export function isLive(section: Section, item: Item, now: number): boolean {
  if (section === "codes") {
    const expiresAt = (item as Code).expiresAt;
    return expiresAt === null || expiresAt > now;
  }
  if (section === "banners") return (item as Banner).endsAt > now;
  return true;
}
