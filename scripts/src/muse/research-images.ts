import { safeHttpUrl } from "./safe-fetch.js";

export type ResearchImage = {
  title: string;
  imageUrl: string;
  pageUrl: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
  source?: string;
};

function safeHttpsUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const safe = safeHttpUrl(raw);
  if (!safe) return undefined;
  const url = new URL(safe);
  return url.protocol === "https:" ? url.href : undefined;
}

function markdownSafeUrl(raw: string): string {
  return raw.replace(/[()]/g, (character) =>
    character === "(" ? "%28" : "%29",
  );
}

type CommonsPage = {
  title?: string;
  imageinfo?: Array<{
    thumburl?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }>;
};

function metadataText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return text || undefined;
}

function safeCommonsImage(page: CommonsPage): ResearchImage | undefined {
  const info = page.imageinfo?.[0];
  if (!page.title || !info?.thumburl || !info.descriptionurl) return undefined;

  const safeImageUrl = safeHttpsUrl(info.thumburl);
  const safePageUrl = safeHttpsUrl(info.descriptionurl);
  if (!safeImageUrl || !safePageUrl) return undefined;
  const imageUrl = new URL(safeImageUrl);
  const pageUrl = new URL(safePageUrl);
  if (
    imageUrl.hostname !== "upload.wikimedia.org" ||
    imageUrl.port ||
    pageUrl.hostname !== "commons.wikimedia.org" ||
    pageUrl.port
  ) {
    return undefined;
  }

  const metadata = info.extmetadata ?? {};
  const creator = metadataText(metadata.Artist?.value);
  const license = metadataText(metadata.LicenseShortName?.value);
  const rawLicenseUrl = safeHttpsUrl(metadata.LicenseUrl?.value);
  const licensePage = rawLicenseUrl ? new URL(rawLicenseUrl) : undefined;
  const licenseUrl =
    licensePage &&
    !licensePage.port &&
    /^(?:www\.)?creativecommons\.org$/i.test(licensePage.hostname)
      ? rawLicenseUrl
      : undefined;
  return {
    title: page.title.replace(/^File:/i, ""),
    imageUrl: markdownSafeUrl(imageUrl.href),
    pageUrl: markdownSafeUrl(pageUrl.href),
    ...(creator ? { creator } : {}),
    ...(license ? { license } : {}),
    ...(licenseUrl ? { licenseUrl: markdownSafeUrl(licenseUrl) } : {}),
  };
}

type OpenverseImageRecord = {
  title?: unknown;
  thumbnail?: unknown;
  foreign_landing_url?: unknown;
  creator?: unknown;
  license?: unknown;
  license_version?: unknown;
  license_url?: unknown;
  source?: unknown;
  provider?: unknown;
  mature?: unknown;
};

const OPENVERSE_LICENSE_LABELS: Record<string, string> = {
  by: "CC BY",
  "by-sa": "CC BY-SA",
  "by-nd": "CC BY-ND",
  cc0: "CC0",
  pdm: "Public Domain Mark",
};
const NONCOMMERCIAL_LICENSES = new Set(["by-nc", "by-nc-sa", "by-nc-nd"]);

function licenseLabel(record: OpenverseImageRecord): string | undefined {
  const code =
    typeof record.license === "string"
      ? record.license.trim().toLowerCase().replace(/^cc-/, "")
      : undefined;
  if (!code || NONCOMMERCIAL_LICENSES.has(code)) return undefined;
  const baseLabel = OPENVERSE_LICENSE_LABELS[code];
  if (!baseLabel) return undefined;
  const version =
    typeof record.license_version === "string" ||
    typeof record.license_version === "number"
      ? String(record.license_version).trim()
      : "";
  const versionSuffix = /^\d+(?:\.\d+)?$/.test(version)
    ? ` ${version}`
    : code === "cc0" || code === "pdm"
      ? " 1.0"
      : "";
  return `${baseLabel}${versionSuffix}`;
}

function safeOpenverseImage(
  record: OpenverseImageRecord,
): ResearchImage | undefined {
  const title = metadataText(record.title);
  if (record.mature === true || !title) return undefined;

  const imageUrl = safeHttpsUrl(record.thumbnail);
  const pageUrl = safeHttpsUrl(record.foreign_landing_url);
  const license = licenseLabel(record);
  const rawLicenseUrl = safeHttpsUrl(record.license_url);
  if (!imageUrl || !pageUrl || !license || !rawLicenseUrl) return undefined;

  const thumbnail = new URL(imageUrl);
  const licensePage = new URL(rawLicenseUrl);
  if (
    thumbnail.hostname !== "api.openverse.org" ||
    thumbnail.port ||
    !/^\/v1\/images\/[a-f0-9-]+\/thumb\/?$/i.test(thumbnail.pathname) ||
    !/^(?:www\.)?creativecommons\.org$/i.test(licensePage.hostname) ||
    licensePage.port
  ) {
    return undefined;
  }

  const creator = metadataText(record.creator);
  const sourceText = metadataText(record.source ?? record.provider);
  const source = sourceText
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
    .slice(0, 60);
  return {
    title,
    imageUrl: thumbnail.href,
    pageUrl: markdownSafeUrl(pageUrl),
    license,
    licenseUrl: markdownSafeUrl(licensePage.href),
    ...(creator ? { creator } : {}),
    ...(source ? { source } : {}),
  };
}

function isOpenverseImageRecord(value: unknown): value is OpenverseImageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpenverseImageSearchResults(
  json: string,
): ResearchImage[] {
  const data: unknown = JSON.parse(json);
  if (
    typeof data !== "object" ||
    data === null ||
    !("results" in data) ||
    !Array.isArray(data.results)
  ) {
    return [];
  }
  return data.results
    .filter(isOpenverseImageRecord)
    .map(safeOpenverseImage)
    .filter((image): image is ResearchImage => Boolean(image))
    .slice(0, 5);
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Image search response exceeded the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

const IMAGE_QUERY_STOP_WORDS = new Set(
  `a about above add after an and answer are as at attach attached available
  back be been before being can caption check create created could define description
  describe did display do does draw earlier existing explain fetch find for from
  generate generated give helpful hey hi how i illustrate image images img imgs
  include in into is it its just labelled labeled like look make me my need
  necessary never not of on online one ones or our out page pages particular
  photo photos picture pictures please previous produce provide read relevant related
  research response results retrieve retrieved search see send show site sourced source
  specific summarise summarize summary support supporting tell that the their them there
  these they this those to topic up url use visual visuals want web website were what
  when where which who why will with would you your concise details main notable
  offerings overview purpose supplied work works chat chats context contexts
  conversation conversations discussion discussions finding findings found former
  latter mention mentioned prior result sources thread threads thing things said
  link linked official`.split(/\s+/),
);

function cleanImageSearchQuery(message: string): string {
  const cleaned = message
    .replace(/\b(?:https?:\/\/|www\.)[^\s]+/gi, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi, " ")
    .replace(/^\s*(?:hey|hi|hello)(?:\s+mira)?[,!:\s]+/i, " ")
    .replace(
      /^\s*(?:(?:(?:can|could|would) you|(?:can|could|would) I)\s+)?(?:please\s+)?(?:(?:I'd|I would) like|I want)\s+(?:you to\s+)?/i,
      "",
    )
    .replace(
      /^\s*(?:(?:can|could|would) (?:you|I)\s+)?(?:please\s+)?(?:find|show|give|send|include|add|attach|provide|fetch|search for|look for|see|view)\s+(?:me\s+)?/i,
      "",
    )
    .replace(/^(?:to\s+)?(?:see|view)\s+/i, "")
    .replace(
      /^\s*(?:please\s+)?(?:define|explain|describe|summari[sz]e|tell me about|teach me about|what is|what are)\s+/i,
      "",
    )
    .replace(
      /\b(?:don't|do not|never|no need to|not necessary to)\b[^.!?\n]{0,60}\b(?:generate|create|draw|make|produce)\b[^.!?\n]{0,40}\b(?:pictures?|images?|imgs?|photos?|illustrations?|diagrams?|visuals?)\b/gi,
      " ",
    )
    .replace(
      /\b(?:attach|attached|use|find|show|include|add|source|retrieve|provide|fetch|search for|look for)\b[^.!?\n]{0,80}\b(?:online|existing|sourced|available)\b[^.!?\n]{0,40}\b(?:pictures?|images?|imgs?|photos?|illustrations?|diagrams?|visuals?)\b/gi,
      " ",
    )
    .replace(
      /\b(?:pictures?|images?|imgs?|photos?|illustrations?|diagrams?|visuals?)\b[^.!?\n]{0,80}\b(?:attached|sourced|available|retrieved|found)\b[^.!?\n]{0,40}\b(?:online|on the web|from the web)\b/gi,
      " ",
    )
    .replace(
      /\b(?:(?:it is|it's)\s+)?(?:not necessary|not needed|not required)(?:\s+to)?\b/gi,
      " ",
    )
    .replace(
      /\b(?:with|including|plus)\s+(?:(?:a|an|some|one|two|additional|extra|relevant|related|accompanying|illustrative|helpful|appropriate|supporting|labeled|labelled)\s+)*(?:pictures?|images?|imgs?|photos?|illustrations?|diagrams?|visuals?)\b(?:\s+(?:description|caption|depiction)\b)?/gi,
      " ",
    )
    .replace(
      /\b(?:pictures?|images?|imgs?|photos?|illustrations?|diagrams?|visuals?)\b/gi,
      " ",
    )
    .replace(
      /\b(?:to support|to back up|backing up|for)\s+(?:my\s+)?research\b/gi,
      " ",
    )
    .replace(/\b(?:related to|of|about)\b/gi, " ")
    .replace(
      /\b(?:available\s+online|online|existing|sourced)\b[.!?]*\s*$/i,
      " ",
    )
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;?!-]+$/g, "")
    .trim();

  const terms = cleaned.match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? [];
  const selected: string[] = [];
  for (const term of terms) {
    if (IMAGE_QUERY_STOP_WORDS.has(term.toLowerCase())) continue;
    if (selected.length >= 12) break;
    if ([...selected, term].join(" ").length > 160) break;
    selected.push(term);
  }
  return selected.join(" ");
}

export function imageSearchQuery(
  message: string,
  fallbackContext = "",
): string {
  return (
    cleanImageSearchQuery(message) || cleanImageSearchQuery(fallbackContext)
  );
}

async function searchOpenverseImages(
  query: string,
  fetcher: typeof fetch,
): Promise<ResearchImage[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.search = new URLSearchParams({
    q: query,
    page_size: "6",
    license_type: "commercial",
    mature: "false",
  }).toString();
  const response = await fetcher(url, {
    headers: {
      "User-Agent": "MuseResearch/1.0 (open-licensed image lookup)",
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Openverse image search returned HTTP ${response.status}.`);
  }
  return parseOpenverseImageSearchResults(
    await readBoundedResponse(response, 512_000),
  );
}

async function searchCommonsImages(
  query: string,
  fetcher: typeof fetch,
): Promise<ResearchImage[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrwhat: "text",
    gsrlimit: "5",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "1000",
    format: "json",
    formatversion: "2",
  }).toString();
  const response = await fetcher(url, {
    headers: {
      "User-Agent": "MuseResearch/1.0 (research image lookup)",
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Wikimedia Commons image search returned HTTP ${response.status}.`,
    );
  }
  return parseCommonsImageSearchResults(
    await readBoundedResponse(response, 256_000),
  );
}

function uniqueImageResults(images: ResearchImage[]): ResearchImage[] {
  const seen = new Set<string>();
  const results: ResearchImage[] = [];
  for (const image of images) {
    const key = image.pageUrl.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(image);
    if (results.length >= 3) break;
  }
  return results;
}

/**
 * Searches Openverse's public catalog with its commercial-use license filter
 * and Wikimedia Commons in parallel. Openverse supplies images from many public
 * collections; Commons remains a free fallback when the catalog is unavailable.
 */
export async function searchResearchImages(
  message: string,
  fetcher: typeof fetch = fetch,
  fallbackContext = "",
): Promise<ResearchImage[]> {
  const query = imageSearchQuery(message, fallbackContext);
  if (!query) return [];

  const outcomes = await Promise.allSettled([
    searchOpenverseImages(query, fetcher),
    searchCommonsImages(query, fetcher),
  ]);
  const images = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" ? outcome.value : [],
  );
  const uniqueImages = uniqueImageResults(images);
  if (uniqueImages.length > 0) return uniqueImages;

  const failures = outcomes
    .filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    )
    .map(({ reason }) =>
      reason instanceof Error ? reason.message : "unknown image search failure",
    );
  if (failures.length > 0) {
    throw new Error(`Image search providers failed: ${failures.join(" ")}`);
  }
  return [];
}

export function parseCommonsImageSearchResults(json: string): ResearchImage[] {
  const data = JSON.parse(json) as { query?: { pages?: CommonsPage[] } };
  return (data.query?.pages ?? [])
    .map(safeCommonsImage)
    .filter((image): image is ResearchImage => Boolean(image))
    .slice(0, 3);
}
