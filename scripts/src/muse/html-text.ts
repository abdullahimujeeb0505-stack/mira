/**
 * HTML-to-text helpers shared by page extraction and non-HTML content
 * conversion. Dependency-free: Muse reads pages with bounded regex passes
 * rather than a parser, so a hostile document can cost time but not memory.
 */

export function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'");
}

export function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:p|div|article|section|h[1-6]|li|tr|br|table|ul|ol)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes chrome and non-text media before extraction.
 *
 * `img`, `picture`, `source`, and `svg` are stripped here rather than left to
 * `htmlToText`. On generated marketing sites (Framer, Webflow, Next.js image
 * components) a page can carry hundreds of media elements whose alt text and
 * URLs otherwise dominate the extracted body and push the real copy out of the
 * character budget.
 */
export function removeBoilerplate(html: string): string {
  let cleaned = html;
  for (const tag of [
    "script",
    "style",
    "noscript",
    "svg",
    "picture",
    "img",
    "source",
    "nav",
    "footer",
    "header",
    "aside",
    "form",
  ]) {
    cleaned = cleaned.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      " ",
    );
    // Void and self-closing forms have no closing tag to match.
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  cleaned = cleaned.replace(
    /<(div|section|ul|ol|aside|nav)\b[^>]*(?:id|class|role)\s*=\s*["'][^"']*(?:cookie|consent|sidebar|navigation|navbar|menu|related|recommend|promo|advert|subscribe|social|breadcrumb|share|feedback|helpful|rating|footer|header|banner|product(?:s|[-_ ]?(?:listing|grid|card|catalog|recommendations?|carousel))?|catalog(?:[-_ ]?(?:listing|grid|products?))?|shop(?:[-_ ]?(?:listing|grid|products?))?)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  cleaned = cleaned.replace(
    /<[^>]+\brole\s*=\s*["'](?:navigation|complementary|contentinfo)["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
    " ",
  );
  return cleaned;
}

/** Drops repeated lines so navigation and template text are counted once. */
export function deduplicateExtractedText(value: string): string {
  const seen = new Set<string>();
  return value
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line) return false;
      const key = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

export function readHtmlAttribute(tag: string, name: string): string | undefined {
  return tag
    .match(
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
    )
    ?.slice(1)
    .find((value): value is string => typeof value === "string");
}

export function readMetaValue(html: string, key: string): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name =
      readHtmlAttribute(tag, "name") ??
      readHtmlAttribute(tag, "property") ??
      readHtmlAttribute(tag, "itemprop");
    if (name?.toLowerCase() !== key.toLowerCase()) continue;
    const content = readHtmlAttribute(tag, "content");
    if (content) return decodeHtml(content).trim().slice(0, 300);
  }
  return undefined;
}

/**
 * Collects absolute http(s) links from a document, in order of appearance.
 *
 * Relative hrefs are resolved against `baseUrl`. Fragment-only links,
 * `javascript:` URLs, mailto/tel, and non-HTTP schemes are dropped. Duplicates
 * are removed while preserving first-seen order.
 */
export function extractHttpLinks(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = readHtmlAttribute(match[0], "href");
    if (!href) continue;
    const trimmed = decodeHtml(href).trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let absolute: URL;
    try {
      absolute = new URL(trimmed, baseUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== "https:" && absolute.protocol !== "http:") continue;

    absolute.hash = "";
    const key = absolute.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(key);
  }

  return found;
}
