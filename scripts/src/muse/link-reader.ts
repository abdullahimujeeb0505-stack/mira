/**
 * Real-time reading of user-supplied links.
 *
 * Before this module, a URL in a message was only ever a *hint*: `runResearch`
 * turned `photon.codes` into a `site:photon.codes` DuckDuckGo query and hoped.
 * When the search endpoint blocked the request — which DuckDuckGo does routinely
 * from datacenter IPs — Muse had no sources at all and answered "I could not
 * retrieve any readable web sources", even though the user had handed it the
 * exact page to read.
 *
 * `readLink` fetches the URL directly, through the same SSRF guard the research
 * pipeline uses, and returns a readable `EvidenceSource` regardless of whether
 * any search succeeded. `collectSameSiteLinks` then offers the links found on
 * that page as further candidates, so `photon.codes` can lead to
 * `docs.photon.codes` and `photon.codes/pricing` within the existing budget.
 *
 * Fetched text is untrusted evidence. It is labelled as such downstream and is
 * never treated as instructions.
 */
import {
  DEFAULT_MAX_REDIRECTS,
  fetchPublicUrl,
  isTransientNetworkFailure,
  readBoundedText,
  safeHttpUrl,
  type ResolveHost,
} from "./safe-fetch.js";
import { extractHttpLinks, htmlToText } from "./html-text.js";
import {
  classifyContent,
  isReadableContentType,
  toReadableText,
} from "./text-converter.js";
import {
  applyDescriptionFallback,
  buildEvidenceSource,
  DIRECT_READ_CHAR_LIMIT,
  extractPageMetadata,
  extractResearchPage,
  PAGE_CHAR_LIMIT,
  type EvidenceSource,
} from "./page-extract.js";

const DIRECT_READ_TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; MuseResearch/1.0)";

/** Path prefixes that are assets or machine endpoints, not readable pages. */
const EXCLUDED_PATH_PREFIXES = [
  "/wp-content/uploads/",
  "/static/media/",
  "/assets/img/",
  "/images/",
  "/img/",
  "/fonts/",
  "/cdn/",
  "/favicon",
  "/apple-touch-icon",
  "/manifest.webmanifest",
  "/robots.txt",
  "/ads.txt",
  "/.well-known/",
];

/** File extensions that are never readable text pages. */
const EXCLUDED_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tiff",
  "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "m4a", "flac",
  "pdf", "zip", "gz", "tgz", "bz2", "7z", "rar", "tar", "xz",
  "exe", "dmg", "pkg", "deb", "rpm", "apk", "msi", "bin",
  "woff", "woff2", "ttf", "otf", "eot",
  "css", "map", "wasm", "parquet", "sqlite", "db",
];

export interface ReadLinkOptions {
  fetchImplementation?: typeof fetch;
  /** DNS override; tests use it to exercise the private-range branch. */
  resolveHost?: ResolveHost;
  timeoutMs?: number;
  maxBytes?: number;
  /** Minimum readable characters. Lower than the search floor by design. */
  minContentChars?: number;
  now?: () => Date;
  /**
   * Title to fall back on when the page declares none. Search retrieval passes
   * the result title; a direct user-supplied read passes nothing.
   */
  fallbackTitle?: string;
  /**
   * Stamp the resulting source as user-provided so it is pinned into evidence.
   * Defaults to true: reading a link the user sent is this module's purpose.
   * Search-result retrieval passes false.
   */
  markUserProvided?: boolean;
  /**
   * Rethrow timeouts and connection errors instead of converting them into a
   * `failure`. The research pipeline uses this so its retry policy still
   * applies; the direct-read path leaves it off because it reports reasons.
   */
  rethrowTransient?: boolean;
}

export interface LinkFailure {
  url: string;
  reason: string;
  /**
   * True when the failure looks temporary — a 5xx, a 429, a timeout. Callers
   * with a retry policy can act on this; the direct-read path just reports it.
   */
  retryable?: boolean;
}

export interface LinkReadResult {
  /** The readable source, or null when the page could not be read. */
  source: EvidenceSource | null;
  /** Absolute http(s) links found on the page, in document order. */
  links: string[];
  /** Same-registrable-domain subset of `links`, already safety-filtered. */
  sameSiteLinks: string[];
  contentType: string;
  httpStatus: number | null;
  finalUrl: string | null;
  failure?: LinkFailure;
}

/**
 * Fetches one URL and returns it as readable evidence.
 *
 * Never throws for an expected condition: an unreachable, blocked, oversized,
 * or unreadable page comes back as `source: null` with a `failure` explaining
 * why, so the caller can report the real reason instead of guessing.
 */
export async function readLink(
  rawUrl: string,
  options: ReadLinkOptions = {},
): Promise<LinkReadResult> {
  const url = safeHttpUrl(rawUrl);
  if (!url) {
    return emptyResult(null, {
      url: rawUrl,
      reason: "The link is not a safe public HTTP(S) URL.",
    });
  }

  const timeoutMs = options.timeoutMs ?? DIRECT_READ_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? SOURCE_BYTE_LIMIT;
  const minContentChars = options.minContentChars ?? DIRECT_READ_CHAR_LIMIT;
  const now = options.now ?? (() => new Date());
  const markUserProvided = options.markUserProvided ?? true;
  const fallbackTitle = options.fallbackTitle?.trim() ?? "";
  /** Omits the flag entirely rather than writing `false`, keeping sources clean. */
  const userProvidedFlag = markUserProvided ? { isUserProvided: true } : {};

  let response: Response;
  let resolvedUrl = url;
  try {
    const fetched = await fetchPublicUrl(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/json,text/plain,text/markdown,application/xml;q=0.9,*/*;q=0.5",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      DEFAULT_MAX_REDIRECTS,
      {
        ...(options.fetchImplementation
          ? { fetchImplementation: options.fetchImplementation }
          : {}),
        ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
      },
    );
    response = fetched.response;
    resolvedUrl = fetched.finalUrl;
  } catch (error) {
    if (options.rethrowTransient && isTransientNetworkFailure(error)) throw error;
    return emptyResult(null, { url, reason: describeFetchFailure(error) });
  }

  const finalUrl = safeHttpUrl(resolvedUrl) ?? url;
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    await response.body?.cancel();
    return emptyResult(
      null,
      {
        url: finalUrl,
        reason: `The page returned HTTP ${response.status}.`,
        ...(isRetryableStatus(response.status) ? { retryable: true } : {}),
      },
      contentType,
      response.status,
      finalUrl,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    return emptyResult(
      null,
      {
        url: finalUrl,
        reason: `The page is larger than the ${maxBytes}-byte read limit.`,
      },
      contentType,
      response.status,
      finalUrl,
    );
  }

  // A declared type we cannot read is rejected up front, but an absent or
  // generic type is sniffed rather than discarded: static hosts commonly serve
  // JSON and XML as application/octet-stream or with no label at all.
  const hasDeclaredType = Boolean(contentType.trim());
  if (hasDeclaredType && !isReadableContentType(contentType) && !isSniffable(contentType)) {
    await response.body?.cancel();
    return emptyResult(
      null,
      {
        url: finalUrl,
        reason: `The page served "${contentType.split(";")[0]?.trim() || "an unknown content type"}", which is not readable text.`,
      },
      contentType,
      response.status,
      finalUrl,
    );
  }

  let body: string;
  try {
    body = await readBoundedText(response, maxBytes);
  } catch (error) {
    return emptyResult(
      null,
      { url: finalUrl, reason: describeFetchFailure(error) },
      contentType,
      response.status,
      finalUrl,
    );
  }

  const retrievedAt = now().toISOString();
  const kind = classifyContent(contentType, body);
  const links = extractHttpLinks(body, finalUrl);
  const sameSiteLinks = collectSameSiteLinks(links, finalUrl);

  if (kind === "html") {
    const metadata = extractPageMetadata(body, finalUrl, fallbackTitle);
    const extracted = extractResearchPage(
      body,
      { title: fallbackTitle, url: finalUrl },
      finalUrl,
      contentType,
      retrievedAt,
      { minContentChars, maxChars: PAGE_CHAR_LIMIT },
    );

    if (extracted) {
      return {
        source: { ...extracted, ...userProvidedFlag },
        links,
        sameSiteLinks,
        contentType,
        httpStatus: response.status,
        finalUrl,
      };
    }

    // Thin HTML: try the page's own description before giving up.
    const thin = applyDescriptionFallback(
      htmlToText(body).slice(0, PAGE_CHAR_LIMIT),
      metadata.description,
      minContentChars,
    );
    if (thin.trim().length >= minContentChars) {
      return {
        source: {
          ...buildEvidenceSource({
            url: finalUrl,
            title:
              metadata.title || fallbackTitle || new URL(finalUrl).hostname,
            content: thin.trim(),
            contentType,
            retrievedAt,
            metadata,
            ...userProvidedFlag,
          }),
          extractionStatus: "body-fallback",
        },
        links,
        sameSiteLinks,
        contentType,
        httpStatus: response.status,
        finalUrl,
      };
    }

    return emptyResult(
      null,
      {
        url: finalUrl,
        reason:
          "The page returned almost no readable text, which usually means it renders through JavaScript in a browser.",
      },
      contentType,
      response.status,
      finalUrl,
      links,
      sameSiteLinks,
    );
  }

  if (kind === "unknown") {
    return emptyResult(
      null,
      {
        url: finalUrl,
        reason: `The page served "${contentType.split(";")[0]?.trim() || "an unknown content type"}", which is not readable text.`,
      },
      contentType,
      response.status,
      finalUrl,
    );
  }

  const text = toReadableText(kind, body, PAGE_CHAR_LIMIT);
  if (text.trim().length < minContentChars) {
    return emptyResult(
      null,
      {
        url: finalUrl,
        reason: `The ${kind.toUpperCase()} response contained less than ${minContentChars} characters of readable text.`,
      },
      contentType,
      response.status,
      finalUrl,
    );
  }

  const metadata =
    kind === "xml" ? extractPageMetadata(body, finalUrl, fallbackTitle) : undefined;
  const title =
    (kind === "xml" ? metadata?.title : undefined) ||
    fallbackTitle ||
    titleFromUrl(finalUrl, kind);

  return {
    source: buildEvidenceSource({
      url: finalUrl,
      title,
      content: text.trim(),
      contentType,
      retrievedAt,
      ...(metadata ? { metadata } : {}),
      ...userProvidedFlag,
    }),
    links,
    sameSiteLinks,
    contentType,
    httpStatus: response.status,
    finalUrl,
  };
}

const SOURCE_BYTE_LIMIT = 500_000;

/** Types that are binary-labelled but frequently carry text worth sniffing. */
function isSniffable(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    !normalized.trim() ||
    normalized.includes("octet-stream") ||
    normalized.includes("application/") &&
      !normalized.includes("pdf") &&
      !normalized.includes("zip") &&
      !normalized.includes("gzip") &&
      !normalized.includes("wasm") &&
      !normalized.includes("image") &&
      !normalized.includes("audio") &&
      !normalized.includes("video") &&
      !normalized.includes("font")
  );
}

function emptyResult(
  _source: null,
  failure: LinkFailure,
  contentType = "",
  httpStatus: number | null = null,
  finalUrl: string | null = null,
  links: string[] = [],
  sameSiteLinks: string[] = [],
): LinkReadResult {
  return {
    source: null,
    links,
    sameSiteLinks,
    contentType,
    httpStatus,
    finalUrl,
    failure,
  };
}

/** HTTP statuses worth one retry: rate limits, timeouts, and server errors. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return "The page could not be reached.";
  const message = error.message;
  if (error.name === "TimeoutError" || error.name === "AbortError" || /timed out|timeout/i.test(message)) {
    return "The page did not respond in time.";
  }
  if (/non-public address/i.test(message)) {
    return "The link resolves to a private or reserved address and was not fetched.";
  }
  if (/redirect limit/i.test(message)) {
    return "The page exceeded the redirect limit.";
  }
  if (/unsafe URL/i.test(message)) {
    return "The page redirected to an unsafe destination and was not followed.";
  }
  if (/size limit/i.test(message)) {
    return "The page exceeded the configured size limit.";
  }
  if (error instanceof TypeError) {
    return "The page could not be reached (network error).";
  }
  return `The page could not be read: ${message}`.slice(0, 300);
}

function titleFromUrl(url: string, kind: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last) {
    const humanized = decodeURIComponent(last)
      .replace(/\.(?:json|xml|md|markdown|txt|csv|rss|atom|ya?ml)$/i, "")
      .replace(/[-_+]+/g, " ")
      .trim();
    if (humanized.length > 1) return `${humanized} (${parsed.hostname})`;
  }
  return `${kind.toUpperCase()} document at ${parsed.hostname}`;
}

// ---------------------------------------------------------------------------
// Same-site crawl
// ---------------------------------------------------------------------------

/**
 * Common multi-label public suffixes.
 *
 * A full public-suffix list is deliberately not embedded: it is large, changes
 * often, and Muse only needs "is this the same site as the page the user gave
 * me". Unknown suffixes fall back to the last two labels, which over-splits
 * (`example.co.uk` and `shop.example.co.uk` look like different sites) rather
 * than over-merging — the safe direction for a crawl boundary.
 */
const MULTI_PART_SUFFIXES = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
  "co.za", "org.za", "web.za", "net.za", "gov.za", "ac.za",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "firm.in", "gen.in",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.mx", "org.mx", "gob.mx", "edu.mx", "net.mx",
  "com.ar", "net.ar", "org.ar", "gob.ar",
  "com.ng", "org.ng", "gov.ng", "edu.ng", "net.ng",
  "com.gh", "org.gh", "gov.gh", "edu.gh",
  "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
  "com.hk", "org.hk", "gov.hk", "edu.hk",
  "com.tw", "org.tw", "gov.tw", "edu.tw",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr", "ac.kr",
  "com.tr", "org.tr", "gov.tr", "net.tr",
  "com.ua", "org.ua", "net.ua", "gov.ua", "edu.ua",
  "com.pl", "org.pl", "net.pl", "gov.pl", "edu.pl",
  "com.ru", "org.ru", "net.ru",
  "com.de", "org.de",
  "com.fr", "asso.fr",
  "com.es", "org.es", "gob.es", "edu.es",
  "com.it", "org.it", "gov.it", "edu.it",
  "com.pt", "org.pt", "gov.pt", "edu.pt",
  "com.gr", "org.gr", "gov.gr", "edu.gr",
  "com.eg", "org.eg", "gov.eg", "edu.eg",
  "com.ke", "org.ke", "go.ke", "ac.ke",
  "com.sa", "org.sa", "gov.sa", "edu.sa",
  "com.ae", "org.ae", "gov.ae", "ac.ae",
];

/**
 * Returns the registrable domain, or null when the host is an IP literal or a
 * bare single label.
 */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return null;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return null;
  if (host.includes(":")) return null;

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;

  for (let parts = 3; parts >= 2; parts -= 1) {
    if (labels.length < parts + 1) continue;
    const candidate = labels.slice(-parts).join(".");
    if (MULTI_PART_SUFFIXES.includes(candidate)) {
      return labels.slice(-(parts + 1)).join(".");
    }
  }

  return labels.slice(-2).join(".");
}

/** True when both hosts belong to the same registrable domain. */
export function isSameSite(left: string, right: string): boolean {
  const leftDomain = registrableDomain(left);
  const rightDomain = registrableDomain(right);
  if (!leftDomain || !rightDomain) return false;
  return leftDomain === rightDomain;
}

function isExcludedTarget(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const extension = last.split(".").pop()?.toLowerCase();
  return Boolean(extension && EXCLUDED_EXTENSIONS.includes(extension));
}

/**
 * Filters discovered links down to the ones worth crawling.
 *
 * Keeps only safe public http(s) URLs on the same registrable domain as
 * `originUrl`, excluding asset paths and binary file extensions. Order is
 * preserved so document order — which usually means importance order on a
 * marketing or docs page — decides what gets read first.
 */
export function collectSameSiteLinks(
  links: readonly string[],
  originUrl: string,
  limit = 12,
): string[] {
  let origin: URL;
  try {
    origin = new URL(originUrl);
  } catch {
    return [];
  }

  const kept: string[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    if (kept.length >= limit) break;
    const safe = safeHttpUrl(link);
    if (!safe) continue;

    let parsed: URL;
    try {
      parsed = new URL(safe);
    } catch {
      continue;
    }

    if (!isSameSite(parsed.hostname, origin.hostname)) continue;
    if (isExcludedTarget(parsed)) continue;

    parsed.hash = "";
    const key = parsed.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(parsed.toString());
  }

  return kept;
}

/**
 * Reads several links, preserving input order and stopping at `limit` successes.
 *
 * Failures are collected rather than thrown: a crawl where two of five pages
 * 404 is still a useful result, and the reasons are reported so the user learns
 * what Muse could not reach.
 */
export async function readLinks(
  urls: readonly string[],
  limit: number,
  options: ReadLinkOptions = {},
): Promise<{ sources: EvidenceSource[]; failures: LinkFailure[]; links: string[] }> {
  const sources: EvidenceSource[] = [];
  const failures: LinkFailure[] = [];
  const links: string[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (sources.length >= limit) break;
    const safe = safeHttpUrl(url);
    if (!safe) {
      failures.push({ url, reason: "The link is not a safe public HTTP(S) URL." });
      continue;
    }
    const key = safe.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);

    const result = await readLink(safe, options);
    links.push(...result.sameSiteLinks);
    if (result.source) {
      sources.push(result.source);
    } else if (result.failure) {
      failures.push(result.failure);
    }
  }

  return { sources, failures, links };
}
