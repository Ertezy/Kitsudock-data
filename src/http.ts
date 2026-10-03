// Все запросы сборщика идут отсюда: одна подпись, таймаут, один повтор,
// условные заголовки и очередь по хосту, чтобы не нагружать чужие сайты.

export const USER_AGENT = "KitsudockCollector/1.0 (+https://github.com/Ertezy/Kitsudock-data)";

export interface Validators {
  etag?: string;
  lastModified?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
  validators: Validators;
}

/** Ответ fetch в той части, что нужна сборщику. Настоящий Response подходит как есть. */
export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** Адрес ответа после всех перенаправлений (у Response — res.url). Нет или пуст — не проверяется. */
  url?: string;
  /**
   * Тело потоком: fetch отдаёт уже распакованные байты, и читаются они с обрывом на потолке
   * размера. Нет потока (null или поля нет) — тело берётся целиком из text().
   */
  body?: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>;

export interface HttpOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Минимальная пауза между запросами к хосту, мс. */
  hostGapMs?: Record<string, number>;
  maxBytes?: number;
}

export interface Http {
  /** headers — дополнительные заголовки запроса (например, токен API); подпись и условные заголовки ставятся всегда. */
  get(url: string, validators?: Validators, headers?: Record<string, string>): Promise<HttpResponse>;
}

/** Пауза для ennead.cc: их объявленный лимит — 2 запроса в секунду. */
export const DEFAULT_HOST_GAPS: Record<string, number> = { "api.ennead.cc": 500 };

const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);

export function createHttp(options: HttpOptions = {}): Http {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const hostGapMs = options.hostGapMs ?? DEFAULT_HOST_GAPS;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const queues = new Map<string, Promise<unknown>>();
  const lastStart = new Map<string, number>();

  async function attempt(url: string, validators: Validators, extra: Record<string, string>): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...extra, "User-Agent": USER_AGENT };
    if (validators.etag) headers["If-None-Match"] = validators.etag;
    if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    // fetch сам идёт по перенаправлениям, а res.url — конечный адрес. Если он ушёл с https,
    // ответ не читается: по http содержимое мог бы подменить любой, кто сидит на канале.
    if (res.url && !res.url.startsWith("https://")) {
      discard(res);
      throw new NotHttpsError(res.url, url);
    }
    const fresh: Validators = {};
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    if (etag) fresh.etag = etag;
    if (lastModified) fresh.lastModified = lastModified;
    if (res.status === 304) {
      discard(res);
      return { status: 304, body: "", validators: validators };
    }
    if (res.status !== 200) {
      discard(res);
      throw new StatusError(res.status, url);
    }
    return { status: 200, body: await readBody(res, url), validators: fresh };
  }

  /** Отпускает соединение, не читая тело. */
  function discard(res: FetchResponse): void {
    void res.body?.cancel().catch(() => {});
  }

  /**
   * Тело как строка. Байты считаются по ходу чтения (уже распакованные), и как только их
   * больше потолка, чтение обрывается, а поток отменяется: сжатый ответ не вырастет в памяти сверх потолка.
   */
  async function readBody(res: FetchResponse, url: string): Promise<string> {
    if (!res.body) {
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new TooLargeError(maxBytes, url);
      return text;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new TooLargeError(maxBytes, url);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return new TextDecoder().decode(Buffer.concat(chunks, total));
  }

  async function withRetry(url: string, validators: Validators, extra: Record<string, string>): Promise<HttpResponse> {
    try {
      return await attempt(url, validators, extra);
    } catch (error) {
      // Не повторяем превышение потолка размера, уход с https и коды ответа не из RETRYABLE
      // (например, 404) — это не временные сбои. Сеть, таймаут и повторяемые коды
      // получают один повтор после паузы.
      if (error instanceof TooLargeError || error instanceof NotHttpsError) throw error;
      if (error instanceof StatusError && !RETRYABLE.has(error.status)) throw error;
      await sleep(retryDelayMs);
      return attempt(url, validators, extra);
    }
  }

  return {
    get(url, validators = {}, headers = {}) {
      if (!url.startsWith("https://")) return Promise.reject(new NotHttpsError(url));
      const host = new URL(url).host;
      const previous = queues.get(host) ?? Promise.resolve();
      const task = previous
        .catch(() => undefined)
        .then(async () => {
          const gap = hostGapMs[host] ?? 0;
          const since = Date.now() - (lastStart.get(host) ?? 0);
          if (gap > 0 && since < gap) await sleep(gap - since);
          lastStart.set(host, Date.now());
          return withRetry(url, validators, headers);
        });
      queues.set(host, task);
      return task;
    },
  };
}

/**
 * Сбой связи, а не ответа: таймаут, обрыв, нет соединения. Это не про один адрес — сайт не
 * отвечает, и следующие запросы к нему в этом прогоне зависнут так же. Поэтому циклы по
 * адресам на таком сбое останавливаются, а остаток ждёт следующего прогона. Ответ с кодом
 * (StatusError), слишком большое тело, уход с https и прочие ошибки — про один ответ, цикл их переживает.
 */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof StatusError || error instanceof TooLargeError || error instanceof NotHttpsError) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  // fetch (undici) при сбое соединения кидает TypeError «fetch failed», при обрыве тела ответа — «terminated».
  return error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated");
}

export class StatusError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`ответ ${status}: ${url}`);
    this.status = status;
  }
}

class TooLargeError extends Error {
  constructor(maxBytes: number, url: string) {
    super(`ответ превысил потолок ${maxBytes} байт: ${url}`);
  }
}

/** Адрес запроса или конечный адрес после перенаправлений не https. */
class NotHttpsError extends Error {
  constructor(url: string, requested?: string) {
    super(requested === undefined ? `только https: ${url}` : `только https: ${url} (перенаправление с ${requested})`);
  }
}
