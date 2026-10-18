/**
 * Converts non-HTML payloads into readable plain text.
 *
 * Muse used to discard every response whose content type was not HTML or plain
 * text. That silently dropped a large share of real documentation: JSON API
 * responses, XML sitemaps and feeds, and Markdown served raw by CDNs and
 * static hosts. A user asking Muse to read a link that serves JSON got "no
 * readable sources" rather than the answer.
 *
 * Everything here is a pure string transformation with no network access and no
 * parser dependency, so it is fully deterministic under test.
 */
import { decodeHtml } from "./html-text.js";

/** Content types Muse is willing to read, matched case-insensitively. */
const READABLE_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/md",
  "application/json",
  "application/ld+json",
  "application/manifest+json",
  "application/xml",
  "text/xml",
  "text/csv",
  "application/rss+xml",
  "application/atom+xml",
];

/**
 * Types that are text in practice but are often served with a generic or
 * missing label. Checked only when the declared type is absent or `octet-stream`.
 */
const SNIFFABLE_JSON = /^\s*[[{]/;
const SNIFFABLE_XML = /^\s*<\?xml[\s?]/i;

export function isReadableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return READABLE_TYPES.some((type) => normalized.includes(type));
}

export type ContentKind = "html" | "text" | "json" | "xml" | "markdown" | "unknown";

export function classifyContent(contentType: string, body: string): ContentKind {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("html")) return "html";
  if (normalized.includes("markdown") || normalized.includes("text/md")) {
    return "markdown";
  }
  if (normalized.includes("json")) return "json";
  if (normalized.includes("xml")) return "xml";
  if (normalized.includes("text/")) return "text";

  // Unlabeled or generic binary: sniff, because static hosts frequently serve
  // JSON and XML as application/octet-stream.
  if (!normalized || normalized.includes("octet-stream")) {
    if (SNIFFABLE_JSON.test(body)) return "json";
    if (SNIFFABLE_XML.test(body)) return "xml";
    return "text";
  }
  return "unknown";
}

export function toReadableText(
  kind: ContentKind,
  body: string,
  maxChars: number,
): string {
  switch (kind) {
    case "html":
      // Callers normally run full page extraction; this is a safety net.
      return decodeHtml(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, maxChars);
    case "json":
      return jsonToText(body, maxChars);
    case "xml":
      return xmlToText(body, maxChars);
    case "markdown":
      return markdownToText(body, maxChars);
    case "text":
      return body.replace(/\r\n/g, "\n").trim().slice(0, maxChars);
    case "unknown":
      return "";
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const MAX_JSON_NODES = 4_000;
const MAX_JSON_STRING = 400;
const MAX_JSON_DEPTH = 12;

/** Looks like base64 blob or a data URI: high entropy, no spaces, no value as evidence. */
function isOpaqueString(value: string): boolean {
  if (value.length < 64) return false;
  if (value.startsWith("data:")) return true;
  return /^[A-Za-z0-9+/=_-]+$/.test(value) && !value.includes(" ");
}

/**
 * Flattens JSON into `path: value` lines.
 *
 * Arrays are indexed, objects are dotted, and empty containers are skipped so a
 * schema-shaped response still yields the fields that carry text. Opaque base64
 * strings are replaced with a length marker rather than dumped into the
 * evidence budget.
 */
export function jsonToText(body: string, maxChars: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }

  const lines: string[] = [];
  let nodes = 0;

  const walk = (value: unknown, path: string, depth: number): void => {
    if (lines.length >= MAX_JSON_NODES || nodes >= MAX_JSON_NODES) return;
    if (depth > MAX_JSON_DEPTH) return;

    if (value === null || value === undefined) return;

    if (typeof value === "string") {
      nodes += 1;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (isOpaqueString(trimmed)) {
        lines.push(`${path}: [${trimmed.length}-character encoded value]`);
        return;
      }
      lines.push(`${path}: ${trimmed.slice(0, MAX_JSON_STRING)}`);
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      nodes += 1;
      lines.push(`${path}: ${String(value)}`);
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return;
      value.forEach((item, index) => {
        walk(item, path ? `${path}[${index}]` : `[${index}]`, depth + 1);
      });
      return;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return;
      for (const [key, item] of entries) {
        const nextPath = path ? `${path}.${key}` : key;
        if (isScalar(item)) {
          walk(item, nextPath, depth + 1);
          continue;
        }
        // Nested containers get a heading so structure survives flattening.
        lines.push(`${nextPath}:`);
        walk(item, nextPath, depth + 1);
      }
      return;
    }
  };

  walk(parsed, "", 0);

  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  );
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * Strips XML markup into readable text.
 *
 * Deliberately not a real parser: Muse only needs the character data, and a
 * regex pass cannot be made to expand entities or allocate per node. Documents
 * carrying a DTD or entity declarations are rejected outright, matching the
 * feed adapter's XXE defence.
 */
export function xmlToText(body: string, maxChars: number): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) return "";

  const withBreaks = body
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\/?[a-z0-9_:.-]+[^>]*\/?>/gi, "\n");

  const text = decodeHtml(withBreaks)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * Reduces Markdown to readable text.
 *
 * Images are removed entirely (they are the noisiest element on generated
 * documentation pages); links keep their label and drop the URL, because the
 * URL is already recorded as the source. Fenced code is preserved as-is: code
 * blocks are usually the point of a technical page.
 */
export function markdownToText(body: string, maxChars: number): string {
  const fenced: string[] = [];
  let text = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => {
    fenced.push(block.replace(/^(```|~~~)[^\n]*\n?/, "").replace(/(```|~~~)\s*$/, "").trimEnd());
    return `\uE010${fenced.length - 1}\uE011`;
  });

  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^ {0,3}(?:[-*+]|\d+\.)\s+/gm, "- ")
    .replace(/(?:^|\s)(?:\*\*|__)(?=\S)([\s\S]*?\S)(?:\*\*|__)(?=\s|$)/g, " $1 ")
    .replace(/(?:^|\s)(?:\*|_)(?=\S)([^\n]*?\S)(?:\*|_)(?=\s|$)/g, " $1 ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/<[^>]+>/g, " ");

  text = text
    .replace(/\uE010(\d+)\uE011/g, (_marker, index: string) => {
      const block = fenced[Number(index)];
      return block === undefined ? "" : `\n${block}\n`;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
