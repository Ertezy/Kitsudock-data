// Разбор вызовов шаблонов MediaWiki. Страницы вики хранят коды и баннеры
// шаблонами, и вытащить параметры надёжнее, чем разбирать отрисованный HTML.

/** Вырезает комментарии, включая незакрытый в конце: его редакторы оставляют чаще, чем кажется. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/**
 * Согласованные пары `open`/`close` — обычным стеком, за один проход: [позиция
 * открывающего, позиция закрывающего], по возрастанию позиции открывающего.
 * Незакрытый (или лишний закрывающий) токен в результат не попадает.
 */
function braceSpans(text: string, open: string, close: string): [number, number][] {
  const starts: number[] = [];
  const ends: number[] = [];
  const stack: number[] = [];
  for (let j = 0; j < text.length - 1; j++) {
    if (text.startsWith(open, j)) {
      stack.push(starts.length);
      starts.push(j);
      ends.push(-1);
      j++;
    } else if (text.startsWith(close, j)) {
      const k = stack.pop();
      if (k !== undefined) ends[k] = j;
      j++;
    }
  }
  const spans: [number, number][] = [];
  for (let k = 0; k < starts.length; k++) {
    if (ends[k] !== -1) spans.push([starts[k]!, ends[k]!]);
  }
  return spans;
}

/** Индекс первого `|` или перевода строки начиная с from; -1, если их больше нет. */
function nextSeparator(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "|" || text[j] === "\n") return j;
  }
  return -1;
}

/**
 * Все вызовы шаблона name — содержимое без внешних скобок. Ищет и внутри других
 * шаблонов, но не внутри найденного. Незакрытая `{{` читается как обычный текст:
 * вызовы после неё по-прежнему находятся.
 */
export function findTemplates(text: string, name: string): string[] {
  const clean = stripComments(text);
  const found: string[] = [];
  let skipUntil = 0;
  // Начала идут по возрастанию, поэтому следующий разделитель ищется заново, только
  // когда прежний остался позади: весь обход — один проход по тексту.
  let separator = -2; // -2 — ещё не искали, -1 — разделителей больше нет
  for (const [start, end] of braceSpans(clean, "{{", "}}")) {
    if (start < skipUntil) continue;
    const from = start + 2;
    if (separator !== -1 && separator < from) separator = nextSeparator(clean, from);
    const headEnd = separator === -1 || separator > end ? end : separator;
    if (clean.slice(from, headEnd).trim() === name) {
      found.push(clean.slice(from, end));
      skipUntil = end + 2;
    }
  }
  return found;
}

/**
 * Позиции `open`/`close`, которые реально образуют согласованную пару. Незакрытый
 * (или лишний закрывающий) токен в набор не попадает и ниже читается как обычный
 * текст, а не как открывающая/закрывающая скобка.
 */
function matchedPairs(text: string, open: string, close: string): Set<number> {
  const matched = new Set<number>();
  for (const [start, end] of braceSpans(text, open, close)) {
    matched.add(start);
    matched.add(end);
  }
  return matched;
}

/**
 * Делит по `|` верхнего уровня: вложенные `{{ }}` и `[[ ]]` не режутся.
 * Глубина ссылок и шаблонов считается раздельно, и растёт только у токенов из
 * согласованной пары — один незакрытый `[[` (или `{{`) не переводит счётчик в
 * бесконечный плюс и не прячет остаток строки: он читается как обычный текст,
 * а оставшиеся `|` по-прежнему делят поля.
 */
export function splitTopLevel(inner: string): string[] {
  const templatePairs = matchedPairs(inner, "{{", "}}");
  const linkPairs = matchedPairs(inner, "[[", "]]");
  const parts: string[] = [];
  let templateDepth = 0;
  let linkDepth = 0;
  let current = "";
  for (let j = 0; j < inner.length; j++) {
    const two = inner.slice(j, j + 2);
    if (two === "{{" && templatePairs.has(j)) {
      templateDepth++;
      current += two;
      j++;
    } else if (two === "}}" && templatePairs.has(j)) {
      templateDepth--;
      current += two;
      j++;
    } else if (two === "[[" && linkPairs.has(j)) {
      linkDepth++;
      current += two;
      j++;
    } else if (two === "]]" && linkPairs.has(j)) {
      linkDepth--;
      current += two;
      j++;
    } else if (inner[j] === "|" && templateDepth === 0 && linkDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += inner[j];
    }
  }
  parts.push(current);
  return parts;
}

export interface TemplateParams {
  positional: string[];
  named: Map<string, string>;
}

const NAME = /^[A-Za-z0-9_ ]+$/;

/** Параметры вызова: первая часть — имя шаблона, остальные — позиционные или «имя = значение». */
export function templateParams(inner: string): TemplateParams {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (const part of splitTopLevel(inner).slice(1)) {
    // Имя — всё до первого «=»; на похожесть на имя проверяется уже обрезанное,
    // так что длинные серии пробелов регулярным выражением не перебираются.
    const eq = part.indexOf("=");
    const name = eq === -1 ? "" : part.slice(0, eq).trim();
    if (NAME.test(name)) named.set(name, part.slice(eq + 1).trim());
    else positional.push(part.trim());
  }
  return { positional, named };
}

/** «Primogem*60;Mora*10000» или {{Item List|…}} / {{Card List|…}} → «Primogem ×60, Mora ×10000». */
export function rewardsText(value: string): string {
  let list = value.trim();
  const inTemplate = /^\{\{\s*(?:Item List|Card List)\s*\|([^|}]*)/.exec(list);
  if (inTemplate) list = inTemplate[1]!;
  return list
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const m = /^(.*?)\*([\d,]+)$/.exec(entry);
      return m ? `${m[1]!.trim()} ×${m[2]!.replace(/,/g, "")}` : entry;
    })
    .join(", ");
}

/** Ссылки [[A|B]] → B, жирный и теги убираются, пробелы схлопываются. */
export function plainText(value: string): string {
  return value
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
