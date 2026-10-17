import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  SourceAdapter,
  SourceConfiguration,
  SourceFetchContext,
  SourceUpdate,
} from "./source-types.js";
import { SourceRateLimitError } from "./source-ingestion-service.js";

const MAX_FEED_BYTES = 1_000_000;
const USER_AGENT = "MuseOpportunityResearch/1.0";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

type RecordValue = Record<string, unknown>;

export class AtomRssSourceAdapter implements SourceAdapter {
  readonly type = "atom-rss";

  async fetchUpdates(
    source: SourceConfiguration,
    context: SourceFetchContext,
  ): Promise<SourceUpdate[]> {
    const url = new URL(source.sourceUrl);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("Feed URL must use HTTP(S) without embedded credentials.");
    }

    const response = await fetch(url, {
      signal: context.signal,
      headers: {
        Accept:
          "application/atom+xml, application/rss+xml, application/xml, text/xml",
        "User-Agent": USER_AGENT,
      },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new SourceRateLimitError(
        "Feed server returned HTTP 429.",
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? retryAfter * 1000
          : undefined,
      );
    }

    if (!response.ok) {
      throw new Error(`Feed request failed with HTTP ${response.status}.`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
      throw new Error("Feed exceeds the 1 MB size limit.");
    }

    const xml = await response.text();

    if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES) {
      throw new Error("Feed exceeds the 1 MB size limit.");
    }

    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new Error("Feed XML declarations with DTDs or entities are not allowed.");
    }

    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      throw new Error("Feed contains malformed XML.");
    }

    const document = parser.parse(xml) as RecordValue;
    const feed = asRecord(document.feed);
    const rss = asRecord(document.rss);
    const channel = rss ? asRecord(rss.channel) : null;

    let entries: unknown[];
    if (feed && "entry" in feed) {
      entries = asArray(feed.entry);
    } else if (channel && "item" in channel) {
      entries = asArray(channel.item);
    } else {
      throw new Error("Unsupported XML feed: expected Atom feed or RSS channel.");
    }

    return entries.map((entry) =>
      mapEntry(entry, source, context.retrievedAt, url.toString()),
    );
  }
}

function mapEntry(
  value: unknown,
  source: SourceConfiguration,
  retrievedAt: string,
  feedUrl: string,
): SourceUpdate {
  const entry = asRecord(value);
  if (!entry) throw new Error("Feed contains an invalid entry.");

  const title = textOf(entry.title) || "(untitled feed entry)";
  const summary =
    textOf(entry.summary) ||
    textOf(entry.description) ||
    textOf(entry["content:encoded"]) ||
    textOf(entry.content) ||
    textOf(entry.contentSnippet);

  const link = resolveEntryLink(entry.link, feedUrl);
  const rawId =
    textOf(entry.id) ||
    textOf(entry.guid) ||
    link ||
    createHash("sha256")
      .update(`${title}\n${summary}\n${textOf(entry.pubDate)}`)
      .digest("hex");

  const publishedAt = validDate(
    textOf(entry.published) ||
      textOf(entry.updated) ||
      textOf(entry.pubDate) ||
      textOf(entry["dc:date"]),
  );

  return {
    id: rawId.slice(0, 512),
    sourceId: source.id,
    sourceType: source.sourceType,
    sourceUrl: link,
    title: title.slice(0, 1_000),
    text: summary.slice(0, 20_000),
    publishedAt,
    retrievedAt,
  };
}

function resolveEntryLink(value: unknown, feedUrl: string): string | null {
  const values = asArray(value);

  for (const item of values) {
    let candidate: string | null = null;

    if (typeof item === "string") {
      candidate = item.trim();
    } else {
      const record = asRecord(item);
      if (!record) continue;

      const rel = textOf(record["@_rel"]);
      if (rel && rel !== "alternate") continue;
      candidate = textOf(record["@_href"]);
    }

    if (!candidate) continue;

    try {
      const url = new URL(candidate, feedUrl);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      ) {
        return url.toString();
      }
    } catch {
      // Ignore invalid entry links and retain the feed URL as fallback.
    }
  }

  return null;
}

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  const record = asRecord(value);
  if (!record) return "";

  if ("#text" in record) return textOf(record["#text"]);
  return "";
}

function validDate(value: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
