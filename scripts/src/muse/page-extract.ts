/**
 * Page extraction: turns a retrieved document into an `EvidenceSource`.
 *
 * These are the pure, network-free parts of the research pipeline, split out so
 * that direct link reading and search-backed research share one extraction
 * policy instead of drifting apart. `research-cli.ts` re-exports every symbol
 * here, so existing imports from `./research-cli.js` keep working.
 */
import { safeHttpUrl } from "./safe-fetch.js";
import {
  decodeHtml,
  deduplicateExtractedText,
  htmlToText,
  readHtmlAttribute,
  readMetaValue,
  removeBoilerplate,
} from "./html-text.js";

export type SearchHit = {
  title: string;
  url: string;
  relevance?: number;
};

export type EvidenceSource = SearchHit & {
  sourceId?: string;
  retrievedAt: string;
  content: string;
  canonicalUrl?: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  updatedAt?: string;
  sourceType?: string;
  retrievalStatus?: "retrieved";
  extractionStatus?: "main-content" | "body-fallback" | "converted";
  evidenceSnippets?: string[];
  /**
   * True when this source came from a URL the user supplied, rather than from a
   * search result. User-provided sources are pinned into the evidence budget so
   * that "read this link" always reads the link.
   */
  isUserProvided?: boolean;
};

export type ResearchCompleteness = "supported" | "partial" | "insufficient";

export const PAGE_CHAR_LIMIT = 3_000;

/**
 * Minimum extracted characters before a page counts as readable.
 *
 * Search results keep the higher floor: a page with almost no text is usually
 * an interstitial, a login wall, or a JS shell, and admitting it wastes the
 * evidence budget. Directly requested links use `DIRECT_READ_CHAR_LIMIT`
 * instead, because the user asked for that specific page and a thin page is
 * still a true answer about it.
 */
export const MIN_CONTENT_CHARS = 250;
export const DIRECT_READ_CHAR_LIMIT = 60;

export function extractResearchPageContent(
  html: string,
  maxChars = PAGE_CHAR_LIMIT,
): { content: string; extractionStatus: "main-content" | "body-fallback" } {
  const cleaned = removeBoilerplate(html);
  const semanticBlocks = [
    ...cleaned.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi),
  ]
    .map((match) => match[2] ?? "")
    .filter(Boolean);
  const candidates = semanticBlocks.length ? semanticBlocks : [cleaned];
  const ranked = candidates
    .map((candidate) => deduplicateExtractedText(htmlToText(candidate)))
    .sort((left, right) => right.length - left.length);
  const fullText = ranked[0] ?? "";
  const paragraphs = fullText.split(/\n+/).filter(Boolean);
  let content = fullText;
  if (content.length > maxChars) {
    const chosen: string[] = [];
    let remaining = maxChars;
    for (const paragraph of paragraphs) {
      if (remaining <= 0) break;
      const separator = chosen.length ? "\n" : "";
      const available = remaining - separator.length;
      if (available <= 0) break;
      chosen.push(paragraph.slice(0, available));
      remaining -= separator.length + Math.min(paragraph.length, available);
    }
    content = chosen.join("\n");
  }
  return {
    content,
    extractionStatus: semanticBlocks.length ? "main-content" : "body-fallback",
  };
}

export function extractEvidenceSnippets(content: string, limit = 4): string[] {
  return content
    .split(/\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 45)
    .slice(0, limit)
    .map((item) => item.slice(0, 360));
}

export function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

export function classifySourceType(url: string, contentType: string): string {
  const host = new URL(url).hostname.toLowerCase();
  if (/\.(gov|gov\.[a-z]{2})$/.test(host) || host.includes(".gov.")) return "government";
  if (host.includes("pubmed.") || host.includes("doi.org") || host.includes("arxiv.org")) return "research";
  if (host.includes("github.com") || host.includes("gitlab.com")) return "source repository";
  if (/\bdocs?\b|developer|api\./.test(host)) return "technical documentation";
  if (contentType.includes("text/plain")) return "plain text";
  if (contentType.includes("json")) return "JSON response";
  if (contentType.includes("xml")) return "XML document";
  if (contentType.includes("markdown")) return "Markdown document";
  return "web page";
}

/** Derives a page title from markup, then URL shape, then hostname. */
export function derivePageTitle(
  html: string,
  fallbackTitle: string,
  url: string,
): string {
  const parsed = new URL(url);
  const fromMarkup =
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    readMetaValue(html, "og:title") ??
    readMetaValue(html, "title") ??
    readMetaValue(html, "twitter:title");

  const decoded = fromMarkup
    ? decodeHtml(fromMarkup).replace(/\s+/g, " ").trim().slice(0, 250)
    : "";
  if (decoded) return decoded;

  const trimmedFallback = fallbackTitle.trim();
  if (trimmedFallback && !/^user-provided website:/i.test(trimmedFallback)) {
    return trimmedFallback;
  }

  // Fallback is the hostname. A synthetic "user-provided website: host" label
  // is never allowed to become the title: it names the request, not the page.
  return parsed.hostname;
}

export interface ExtractResearchPageOptions {
  /** Override the minimum readable length. See MIN_CONTENT_CHARS. */
  minContentChars?: number;
  /** Raise the extraction budget above PAGE_CHAR_LIMIT. */
  maxChars?: number;
}

/**
 * Builds an `EvidenceSource` from an HTML document.
 *
 * Returns null when the page has less readable text than `minContentChars`,
 * which is how Muse avoids citing interstitials and JS shells as evidence.
 */
export function extractResearchPage(
  html: string,
  hit: SearchHit,
  finalUrl: string,
  contentType = "text/html",
  retrievedAt = new Date().toISOString(),
  options: ExtractResearchPageOptions = {},
): EvidenceSource | null {
  const safeFinalUrl = safeHttpUrl(finalUrl);
  if (!safeFinalUrl) return null;

  const minContentChars = options.minContentChars ?? MIN_CONTENT_CHARS;
  const { content, extractionStatus } = extractResearchPageContent(
    html,
    options.maxChars ?? PAGE_CHAR_LIMIT,
  );
  if (content.length < minContentChars) return null;

  const parsedUrl = new URL(safeFinalUrl);
  const canonicalTag = html
    .match(/<link\b[^>]*>/gi)
    ?.map((tag) => ({
      tag,
      rel: readHtmlAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [],
    }))
    .find(({ rel }) => rel.includes("canonical"));
  const canonicalHref = canonicalTag
    ? readHtmlAttribute(canonicalTag.tag, "href")
    : undefined;
  const canonicalUrl = canonicalHref
    ? safeHttpUrl(new URL(canonicalHref, safeFinalUrl).toString()) ?? undefined
    : undefined;

  const title = derivePageTitle(html, hit.title, safeFinalUrl);

  return {
    ...hit,
    title,
    url: safeFinalUrl,
    canonicalUrl: canonicalUrl ?? safeFinalUrl,
    publisher:
      readMetaValue(html, "og:site_name") ??
      readMetaValue(html, "publisher") ??
      parsedUrl.hostname,
    author: readMetaValue(html, "author"),
    publishedAt: normalizeDate(
      readMetaValue(html, "article:published_time") ??
        readMetaValue(html, "datePublished") ??
        readMetaValue(html, "date"),
    ),
    updatedAt: normalizeDate(
      readMetaValue(html, "article:modified_time") ??
        readMetaValue(html, "dateModified") ??
        readMetaValue(html, "last-modified"),
    ),
    sourceType: classifySourceType(safeFinalUrl, contentType),
    retrievalStatus: "retrieved",
    extractionStatus,
    evidenceSnippets: extractEvidenceSnippets(content),
    retrievedAt,
    content,
  };
}

/** Metadata Muse records for a page, extracted independently of its body. */
export interface PageMetadata {
  title?: string;
  description?: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  updatedAt?: string;
  canonicalUrl?: string;
}

/**
 * Pulls title/description/attribution out of markup.
 *
 * Used for non-HTML payloads too: a JSON API response served from a documented
 * site still benefits from the site's own naming, and a thin HTML page can be
 * rescued by its `og:description` when the body extracts to almost nothing.
 */
export function extractPageMetadata(
  markup: string,
  url: string,
  fallbackTitle = "",
): PageMetadata {
  const parsed = new URL(url);
  const canonicalTag = markup
    .match(/<link\b[^>]*>/gi)
    ?.map((tag) => ({
      tag,
      rel: readHtmlAttribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [],
    }))
    .find(({ rel }) => rel.includes("canonical"));
  const canonicalHref = canonicalTag
    ? readHtmlAttribute(canonicalTag.tag, "href")
    : undefined;

  return {
    title: derivePageTitle(markup, fallbackTitle, url),
    description:
      readMetaValue(markup, "og:description") ??
      readMetaValue(markup, "description") ??
      readMetaValue(markup, "twitter:description"),
    publisher:
      readMetaValue(markup, "og:site_name") ??
      readMetaValue(markup, "publisher") ??
      parsed.hostname,
    author: readMetaValue(markup, "author"),
    publishedAt: normalizeDate(
      readMetaValue(markup, "article:published_time") ??
        readMetaValue(markup, "datePublished") ??
        readMetaValue(markup, "date"),
    ),
    updatedAt: normalizeDate(
      readMetaValue(markup, "article:modified_time") ??
        readMetaValue(markup, "dateModified") ??
        readMetaValue(markup, "last-modified"),
    ),
    canonicalUrl: canonicalHref
      ? safeHttpUrl(new URL(canonicalHref, url).toString()) ?? undefined
      : undefined,
  };
}

/**
 * Appends the page's own description when the extracted body is thin.
 *
 * Generated marketing sites (Framer, Webflow, SPA shells) often render their
 * real summary into `og:description` while the body markup is image-heavy and
 * text-poor. Without this, such a page extracts under the readable floor and
 * Muse reports "no readable sources" for a page the user can plainly read.
 */
export function applyDescriptionFallback(
  content: string,
  description: string | undefined,
  minContentChars: number,
): string {
  if (content.length >= minContentChars) return content;
  const trimmed = description?.trim();
  if (!trimmed) return content;
  const combined = content ? `${content}\n${trimmed}` : trimmed;
  return combined.length > PAGE_CHAR_LIMIT
    ? combined.slice(0, PAGE_CHAR_LIMIT)
    : combined;
}

/**
 * Builds an `EvidenceSource` for a non-HTML payload whose text has already been
 * converted by `text-converter.ts`.
 */
export function buildEvidenceSource(
  input: {
    url: string;
    title: string;
    content: string;
    contentType: string;
    retrievedAt: string;
    metadata?: PageMetadata;
    isUserProvided?: boolean;
  },
): EvidenceSource {
  const parsed = new URL(input.url);
  return {
    title: input.title,
    url: input.url,
    canonicalUrl: input.metadata?.canonicalUrl ?? input.url,
    publisher: input.metadata?.publisher ?? parsed.hostname,
    ...(input.metadata?.author ? { author: input.metadata.author } : {}),
    ...(input.metadata?.publishedAt
      ? { publishedAt: input.metadata.publishedAt }
      : {}),
    ...(input.metadata?.updatedAt ? { updatedAt: input.metadata.updatedAt } : {}),
    sourceType: classifySourceType(input.url, input.contentType),
    retrievalStatus: "retrieved",
    extractionStatus: "converted",
    evidenceSnippets: extractEvidenceSnippets(input.content),
    retrievedAt: input.retrievedAt,
    content: input.content,
    ...(input.isUserProvided ? { isUserProvided: true } : {}),
  };
}
