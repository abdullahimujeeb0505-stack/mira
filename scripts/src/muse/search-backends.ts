/**
 * Public web search backends.
 *
 * Muse searches without an API key, which means every backend is a scraped
 * public endpoint that can decide to challenge us. DuckDuckGo's HTML endpoint
 * does exactly that from datacenter IP ranges, and when it did, Muse reported a
 * single undifferentiated "search may be blocked" for every failure.
 *
 * Two things are fixed here:
 *
 * 1. A second backend. `lite.duckduckgo.com` is a separate, much smaller
 *    endpoint with its own challenge behaviour, so a block on the HTML endpoint
 *    does not end the search. Backends are tried in order and the first that
 *    returns hits wins.
 * 2. Honest failure reporting. A bot challenge raises `SearchBlockedError`,
 *    which is distinct from a network failure and distinct from an unreadable
 *    page, so `runResearch` can tell the user which thing actually went wrong.
 *
 * Neither backend is an API and both can change markup without notice. The
 * parsers are written to degrade to zero hits rather than throw on unfamiliar
 * markup, and every parser has fixture tests.
 */
import {
  DEFAULT_MAX_REDIRECTS,
  fetchPublicUrl,
  readBoundedText,
  safeHttpUrl,
} from "./safe-fetch.js";
import { decodeHtml, htmlToText, readHtmlAttribute } from "./html-text.js";

/** Raised when a backend serves a bot challenge instead of results. */
export class SearchBlockedError extends Error {
  constructor(
    readonly backend: string,
    message: string,
  ) {
    super(message);
    this.name = "SearchBlockedError";
  }
}

/** Raised on transient HTTP statuses so the caller can apply its retry policy. */
export class RetryableSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSearchError";
  }
}

export type SearchHit = {
  title: string;
  url: string;
  relevance?: number;
};

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_RESPONSE_LIMIT = 1_000_000;
const GEMINI_SEARCH_RESPONSE_LIMIT = 2_000_000;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_SEARCH_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_SEARCH_TIMEOUT_MS = 30_000;
const MAX_HITS_PER_QUERY = 8;
const USER_AGENT = "Mozilla/5.0 (compatible; MuseResearch/1.0)";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function readProviderErrorDetail(
  response: Response,
  secret: string,
): Promise<string> {
  try {
    const body = await readBoundedText(response, 4_096);
    return body
      .replaceAll(secret, "[REDACTED]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
  } catch {
    return "";
  }
}

/**
 * Challenge markers seen across DuckDuckGo's endpoints. Matched against the
 * decoded body so an entity-encoded phrase still trips the check.
 */
const CHALLENGE_MARKERS = [
  "anomaly-modal",
  "challenge to confirm this search",
  "bots use duckduckgo too",
  "if this persists, please let us know",
  "verification required",
  "i'm not a robot",
  "altcha",
  "hcaptcha",
  "recaptcha",
  "are you a robot",
  "unusual traffic",
  "access denied",
];

export interface SearchBackend {
  readonly id: string;
  readonly label: string;
  search(query: string): Promise<SearchHit[]>;
}

function isChallenge(status: number, html: string): boolean {
  if (status === 202 || status === 403 || status === 429) return true;
  const lowered = decodeHtml(html).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lowered.includes(marker));
}

function looksLikeSearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host.includes("duckduckgo.com") ||
    host.includes("bing.com") ||
    host.includes("google.") ||
    host.includes("mojeek.com") ||
    host.includes("search.brave.com") ||
    host.includes("startpage.com")
  );
}

async function fetchSearchPage(url: string): Promise<{ html: string; status: number }> {
  const { response } = await fetchPublicUrl(
    url,
    {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    DEFAULT_MAX_REDIRECTS,
  );

  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403) {
      throw new SearchBlockedError(
        "duckduckgo",
        "Web search endpoint denied access with HTTP 403.",
      );
    }
    if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
      throw new RetryableSearchError(
        `Web search returned transient HTTP ${response.status}.`,
      );
    }
    throw new Error(`Web search returned HTTP ${response.status}`);
  }

  return {
    html: await readBoundedText(response, SEARCH_RESPONSE_LIMIT),
    status: response.status,
  };
}

/**
 * Unwraps DuckDuckGo's `uddg` redirect parameter and validates the target.
 * Both endpoints wrap result links this way.
 */
function unwrapDuckDuckGoHref(rawHref: string): string | null {
  const candidate = decodeHtml(rawHref);
  let resolved = candidate;
  try {
    const redirect = new URL(candidate, "https://duckduckgo.com");
    const target = redirect.searchParams.get("uddg");
    if (target) resolved = target;
  } catch {
    return null;
  }
  return safeHttpUrl(resolved);
}

function pushHit(hits: SearchHit[], title: string, url: string): void {
  const cleanTitle = title.replace(/\s+/g, " ").trim().slice(0, 250);
  if (!cleanTitle || !url) return;
  if (hits.some((hit) => hit.url === url)) return;
  hits.push({ title: cleanTitle, url });
  if (hits.length >= MAX_HITS_PER_QUERY) return;
}

/**
 * Parses the `html.duckduckgo.com/html/` results page.
 *
 * Result anchors carry `class="result__a"`. Anything else on the page is
 * chrome, so a markup change that drops that class yields zero hits rather than
 * a page full of navigation links.
 */
export function parseDuckDuckGoSearchResults(
  html: string,
  status = 200,
): SearchHit[] {
  if (isChallenge(status, html)) {
    throw new SearchBlockedError(
      "duckduckgo-html",
      `Web search endpoint returned a bot challenge (HTTP ${status}).`,
    );
  }

  const hits: SearchHit[] = [];

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1] ?? "";
    if (!/\bclass=["'][^"']*\bresult__a\b[^"']*["']/i.test(attributes)) continue;

    const rawHref = readHtmlAttribute(`<a ${attributes}>`, "href") ??
      attributes.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!rawHref) continue;

    const url = unwrapDuckDuckGoHref(rawHref);
    if (!url) continue;

    const title = htmlToText(match[2] ?? "");
    if (!title) continue;

    pushHit(hits, title, url);
    if (hits.length >= MAX_HITS_PER_QUERY) break;
  }

  return hits;
}

/**
 * Parses the `lite.duckduckgo.com/lite/` results page.
 *
 * Lite is a table-based layout. Its result anchors are matched in three
 * passes, most specific first, and the first pass that finds anything wins:
 *
 * 1. an explicit result class (`result-link`, `result__a`, `result-title`),
 * 2. numbered-result anchors (`>1.`, `>12.`) inside the results table,
 * 3. any external http(s) anchor that is not a known search-engine host.
 *
 * Pass 3 exists because Lite's markup has historically varied by region and
 * client, and a bare-but-correct result set is far better than no results. It
 * excludes search-engine hosts so the region/time filter links and the
 * "next page" control are never mistaken for results.
 */
export function parseDuckDuckGoLiteResults(
  html: string,
  status = 200,
): SearchHit[] {
  if (isChallenge(status, html)) {
    throw new SearchBlockedError(
      "duckduckgo-lite",
      `Web search endpoint returned a bot challenge (HTTP ${status}).`,
    );
  }

  const anchors: Array<{ attributes: string; inner: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    anchors.push({ attributes: match[1] ?? "", inner: match[2] ?? "" });
  }

  const toHit = (
    anchor: { attributes: string; inner: string },
  ): { title: string; url: string } | undefined => {
    const rawHref =
      anchor.attributes.match(/\bhref=["']([^"']+)["']/i)?.[1] ?? undefined;
    if (!rawHref) return undefined;
    const url = unwrapDuckDuckGoHref(rawHref);
    if (!url) return undefined;
    const title = htmlToText(anchor.inner);
    if (!title) return undefined;
    return { title, url };
  };

  const passes: Array<(anchor: { attributes: string; inner: string }) => boolean> = [
    (anchor) =>
      /\bclass=["'][^"']*\b(?:result-link|result__a|result-title|result__url)\b[^"']*["']/i.test(
        anchor.attributes,
      ),
    (anchor) => /^\s*\d{1,3}\.\s*$/.test(htmlToText(anchor.inner)),
    (anchor) => {
      const href = anchor.attributes.match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (!href) return false;
      try {
        const parsed = new URL(decodeHtml(href), "https://lite.duckduckgo.com");
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
        return !looksLikeSearchHost(parsed.hostname);
      } catch {
        return false;
      }
    },
  ];

  for (const matches of passes) {
    const hits: SearchHit[] = [];
    for (const anchor of anchors) {
      if (!matches(anchor)) continue;
      const hit = toHit(anchor);
      if (!hit) continue;
      pushHit(hits, hit.title, hit.url);
      if (hits.length >= MAX_HITS_PER_QUERY) break;
    }
    if (hits.length > 0) return hits;
  }

  return [];
}

export class DuckDuckGoHtmlBackend implements SearchBackend {
  readonly id = "duckduckgo-html";
  readonly label = "DuckDuckGo HTML";

  async search(query: string): Promise<SearchHit[]> {
    const url =
      "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    const { html, status } = await fetchSearchPage(url);
    return parseDuckDuckGoSearchResults(html, status);
  }
}

export class DuckDuckGoLiteBackend implements SearchBackend {
  readonly id = "duckduckgo-lite";
  readonly label = "DuckDuckGo Lite";

  async search(query: string): Promise<SearchHit[]> {
    const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
    const { html, status } = await fetchSearchPage(url);
    return parseDuckDuckGoLiteResults(html, status);
  }
}

export interface GeminiGoogleSearchBackendOptions {
  apiKey?: string;
  model?: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Uses Gemini's Google Search grounding tool to return real web URLs. This is a
 * fallback after the unauthenticated DuckDuckGo endpoints; the research pipeline
 * still fetches and validates every returned page itself before citing it.
 */
export class GeminiGoogleSearchBackend implements SearchBackend {
  readonly id = "gemini-google-search";
  readonly label = "Gemini Google Search";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GeminiGoogleSearchBackendOptions = {}) {
    const apiKey = options.apiKey?.trim() ?? process.env.GEMINI_API_KEY?.trim() ?? "";
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY for Google Search grounding.");
    this.apiKey = apiKey;
    this.model =
      options.model?.trim() ||
      process.env.GEMINI_MODEL?.trim() ||
      DEFAULT_GEMINI_SEARCH_MODEL;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_SEARCH_TIMEOUT_MS;
  }

  async search(query: string): Promise<SearchHit[]> {
    const endpoint =
      `${GEMINI_API_BASE}/models/${encodeURIComponent(this.model)}:generateContent`;
    let response: Response;
    try {
      response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{
              text:
                "Use Google Search to find public web pages relevant to this research query. " +
                "Return search-grounded results; do not invent URLs. Query: " +
                query.trim(),
            }],
          }],
          tools: [{ google_search: {} }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new RetryableSearchError(
          `Gemini Google Search timed out after ${this.timeoutMs} ms.`,
        );
      }
      const detail = error instanceof Error
        ? error.message.replaceAll(this.apiKey, "[REDACTED]")
        : "unknown network error";
      throw new Error(`Gemini Google Search request failed: ${detail}`);
    }

    if (!response.ok) {
      const detail = await readProviderErrorDetail(response, this.apiKey);
      const suffix = detail ? ` Provider detail: ${detail}` : "";
      if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
        throw new RetryableSearchError(
          `Gemini Google Search returned transient HTTP ${response.status}.${suffix}`,
        );
      }
      throw new Error(
        `Gemini Google Search returned HTTP ${response.status}.${suffix}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        await readBoundedText(response, GEMINI_SEARCH_RESPONSE_LIMIT),
      ) as unknown;
    } catch {
      throw new Error("Gemini Google Search returned malformed or oversized JSON.");
    }

    if (!isRecord(payload) || !Array.isArray(payload.candidates)) return [];
    const hits: SearchHit[] = [];
    for (const candidate of payload.candidates) {
      if (!isRecord(candidate) || !isRecord(candidate.groundingMetadata)) continue;
      const chunks = candidate.groundingMetadata.groundingChunks;
      if (!Array.isArray(chunks)) continue;
      for (const chunk of chunks) {
        if (!isRecord(chunk) || !isRecord(chunk.web)) continue;
        const rawUrl = typeof chunk.web.uri === "string" ? chunk.web.uri : "";
        const url = safeHttpUrl(rawUrl);
        if (!url) continue;
        let hostname = "";
        try {
          hostname = new URL(url).hostname;
        } catch {
          continue;
        }
        const title = typeof chunk.web.title === "string" && chunk.web.title.trim()
          ? chunk.web.title.trim()
          : hostname;
        pushHit(hits, title, url);
        if (hits.length >= MAX_HITS_PER_QUERY) return hits;
      }
    }
    return hits;
  }
}

export const DEFAULT_SEARCH_BACKENDS: readonly SearchBackend[] = [
  new DuckDuckGoHtmlBackend(),
  new DuckDuckGoLiteBackend(),
];

/** Add the existing Gemini key as a final search fallback without requiring a
 *  second search credential. It can be disabled with MUSE_GEMINI_SEARCH=0. */
export function createDefaultSearchBackends(
  env: Record<string, string | undefined> = process.env,
): readonly SearchBackend[] {
  const groundedSearchEnabled = (env.MUSE_GEMINI_SEARCH ?? "1").trim() !== "0";
  const geminiKey = env.GEMINI_API_KEY?.trim();
  return groundedSearchEnabled && geminiKey
    ? [...DEFAULT_SEARCH_BACKENDS, new GeminiGoogleSearchBackend({ apiKey: geminiKey })]
    : DEFAULT_SEARCH_BACKENDS;
}

export interface SearchBackendOutcome {
  hits: SearchHit[];
  /** Backend that produced the hits, or null when every backend failed. */
  backendId: string | null;
  /** One message per backend that did not return hits. */
  failures: string[];
  /** True when at least one backend denied access or served a bot challenge. */
  blocked: boolean;
}

function isTransientSearchFailure(error: unknown): boolean {
  if (error instanceof SearchBlockedError) return false;
  if (error instanceof RetryableSearchError) return true;
  return error instanceof Error && (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EPIPE/i
      .test(error.message)
  );
}

/**
 * Runs one query across the backends in order. Each transient failure is retried
 * once on that backend; a persistent failure falls through to the next backend
 * instead of aborting the entire search chain.
 */
export async function searchWithBackends(
  query: string,
  backends: readonly SearchBackend[] = DEFAULT_SEARCH_BACKENDS,
): Promise<SearchBackendOutcome> {
  const failures: string[] = [];
  let blocked = false;

  for (const backend of backends) {
    let attempt = 0;
    while (true) {
      try {
        const hits = await backend.search(query);
        if (hits.length > 0) {
          return { hits, backendId: backend.id, failures, blocked };
        }
        failures.push(`${backend.label} returned no results for this query.`);
        break;
      } catch (error) {
        if (error instanceof SearchBlockedError) {
          blocked = true;
          failures.push(`${backend.label} blocked access: ${error.message}`);
          break;
        }
        if (isTransientSearchFailure(error) && attempt === 0) {
          attempt += 1;
          continue;
        }
        failures.push(
          `${backend.label} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        break;
      }
    }
  }

  return { hits: [], backendId: null, failures, blocked };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
