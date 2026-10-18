export type ResearchImage = {
  title: string;
  imageUrl: string;
  pageUrl: string;
  creator?: string;
  license?: string;
};

type CommonsPage = {
  title?: string;
  imageinfo?: Array<{
    thumburl?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }>;
};

function metadataText(value: string | undefined): string | undefined {
  const text = value
    ?.replace(/<[^>]*>/g, " ")
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

  let imageUrl: URL;
  let pageUrl: URL;
  try {
    imageUrl = new URL(info.thumburl);
    pageUrl = new URL(info.descriptionurl);
  } catch {
    return undefined;
  }
  if (
    imageUrl.protocol !== "https:" ||
    imageUrl.hostname !== "upload.wikimedia.org" ||
    pageUrl.protocol !== "https:" ||
    pageUrl.hostname !== "commons.wikimedia.org"
  ) {
    return undefined;
  }

  const metadata = info.extmetadata ?? {};
  const creator = metadataText(metadata.Artist?.value);
  const license = metadataText(metadata.LicenseShortName?.value);
  return {
    title: page.title.replace(/^File:/i, ""),
    imageUrl: imageUrl.href.replace(/[()]/g, (character) =>
      character === "(" ? "%28" : "%29",
    ),
    pageUrl: pageUrl.href.replace(/[()]/g, (character) =>
      character === "(" ? "%28" : "%29",
    ),
    ...(creator ? { creator } : {}),
    ...(license ? { license } : {}),
  };
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

export function imageSearchQuery(message: string): string {
  return message
    .replace(
      /^\s*(?:(?:(?:can|could|would) you|(?:can|could|would) I)\s+)?(?:please\s+)?(?:(?:I'd|I would) like|I want)\s+(?:you to\s+)?/i,
      "",
    )
    .replace(
      /^\s*(?:(?:can|could|would) (?:you|I)\s+)?(?:please\s+)?(?:find|show|give|send|include|add|provide|fetch|search for|look for|see|view)\s+(?:me\s+)?/i,
      "",
    )
    .replace(/^(?:to\s+)?(?:see|view)\s+/i, "")
    .replace(
      /\b(?:pictures?|images?|photos?|illustrations?|diagrams?|visuals?)\b/gi,
      " ",
    )
    .replace(
      /\b(?:to support|to back up|backing up|for)\s+(?:my\s+)?research\b/gi,
      " ",
    )
    .replace(/\b(?:related to|of|about)\b/gi, " ")
    .replace(/\b(?:a|an|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;?!-]+$/g, "")
    .trim();
}

export async function searchResearchImages(
  message: string,
  fetcher: typeof fetch = fetch,
): Promise<ResearchImage[]> {
  const query = imageSearchQuery(message);
  if (!query) return [];

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

export function parseCommonsImageSearchResults(json: string): ResearchImage[] {
  const data = JSON.parse(json) as { query?: { pages?: CommonsPage[] } };
  return (data.query?.pages ?? [])
    .map(safeCommonsImage)
    .filter((image): image is ResearchImage => Boolean(image))
    .slice(0, 3);
}
