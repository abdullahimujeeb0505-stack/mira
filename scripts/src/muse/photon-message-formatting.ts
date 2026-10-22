import { Buffer } from "node:buffer";
import type { GeneratedImage } from "./cloudflare-workers-ai.js";
import {
  assertPublicHost,
  safeHttpUrl,
  type ResolveHost,
} from "./safe-fetch.js";

const MAX_RESEARCH_IMAGE_BYTES = 4 * 1_024 * 1_024;
const MAX_RESEARCH_IMAGES_PER_REPLY = 3;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;

export interface IMessageImageReference {
  alt: string;
  url: string;
}

export type ResearchImageDownloader = (url: string) => Promise<GeneratedImage>;

export interface ResearchImageDownloadOptions {
  fetchImplementation?: typeof fetch;
  resolveHost?: ResolveHost;
}

function normalizeResearchImageUrl(rawUrl: string): string | undefined {
  const safeUrl = safeHttpUrl(rawUrl);
  if (!safeUrl) return undefined;

  let url: URL;
  try {
    url = new URL(safeUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return undefined;
  }

  const isWikimediaImage =
    url.hostname === "upload.wikimedia.org" &&
    /^\/wikipedia\/commons\/(?:thumb\/)?[^?#]+\.(?:jpe?g|png|webp)$/i.test(
      url.pathname,
    );
  const isOpenverseThumbnail =
    url.hostname === "api.openverse.org" &&
    /^\/v1\/images\/[a-f0-9-]+\/thumb\/?$/i.test(url.pathname);

  if (!isWikimediaImage && !isOpenverseThumbnail) return undefined;
  url.hash = "";
  return url.href;
}

function cleanImageAltText(value: string): string {
  const cleaned = formatIMessageText(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160) || "Research image";
}

/**
 * Removes research-image Markdown from a reply and returns only image URLs from
 * the public image catalogs Muse uses. Unsupported image links become a short
 * plain-text label rather than leaking Markdown into iMessage.
 */
export function extractIMessageImageReferences(response: string): {
  text: string;
  images: IMessageImageReference[];
} {
  const images: IMessageImageReference[] = [];
  const protectedCode: string[] = [];
  const protectCode = (code: string): string => {
    const marker = `\uE000${protectedCode.length}\uE001`;
    protectedCode.push(code);
    return marker;
  };

  let text = response
    .replace(/```[^\n]*\n[\s\S]*?```/g, protectCode)
    .replace(/~~~[^\n]*\n[\s\S]*?~~~/g, protectCode)
    .replace(/(`+)([^`\n]*?)\1/g, (match) => protectCode(match));
  text = text
    .replace(MARKDOWN_IMAGE, (_match, rawAlt: string, rawUrl: string) => {
      const alt = cleanImageAltText(rawAlt);
      const url = normalizeResearchImageUrl(rawUrl);
      if (url && images.length < MAX_RESEARCH_IMAGES_PER_REPLY) {
        images.push({ alt, url });
        return "";
      }
      return `Image: ${alt}`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\uE000(\d+)\uE001/g, (_marker, index: string) =>
      protectedCode[Number(index)] ?? _marker,
    )
    .trim();

  return { text, images };
}

/**
 * Converts the Markdown commonly returned by Muse into readable plain text for
 * iMessage. iMessage does not render Markdown syntax such as headings or bold.
 */
export function formatIMessageText(response: string): string {
  const protectedSpans: string[] = [];
  const protect = (value: string): string => {
    const marker = `\uE000${protectedSpans.length}\uE001`;
    protectedSpans.push(value);
    return marker;
  };

  let text = response
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) =>
      protect(code.replace(/\n+$/, "")),
    )
    .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, (_match, code: string) =>
      protect(code.replace(/\n+$/, "")),
    )
    .replace(/(`+)([^`\n]*?)\1/g, (_match, _ticks: string, code: string) =>
      protect(code),
    );

  text = text
    .replace(MARKDOWN_IMAGE, (_match, rawAlt: string) =>
      `Image: ${cleanImageAltText(rawAlt)}`,
    )
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)(?:\s+["'][^)]*["'])?\)/gi,
      (_match, label: string, url: string) => `${label} (${protect(url)})`,
    )
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g, "$1")
    .replace(/^[\t ]{0,3}#{1,6}[\t ]+/gm, "")
    .replace(/^[\t ]{0,3}>[\t ]?/gm, "")
    .replace(/^[\t ]*[-+*][\t ]+/gm, "• ")
    .replace(/^[\t ]{0,3}(?:-{3,}|_{3,}|\*{3,})[\t ]*$/gm, "")
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/___(.+?)___/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1")
    .replace(/[\t ]+([,.;!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.replace(/\uE000(\d+)\uE001/g, (_marker, index: string) =>
    protectedSpans[Number(index)] ?? _marker,
  );
}

function imageMimeTypeFromBytes(bytes: Uint8Array): GeneratedImage["mimeType"] | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

async function readBoundedImage(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Research image exceeded the size limit.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Research image had no response body.");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Research image exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

/** Fetches only bounded raster thumbnails from Muse's vetted public image sources. */
export async function downloadResearchImage(
  rawUrl: string,
  options: ResearchImageDownloadOptions = {},
): Promise<GeneratedImage> {
  const url = normalizeResearchImageUrl(rawUrl);
  if (!url) throw new Error("Research image URL is not supported.");

  await assertPublicHost(new URL(url), options.resolveHost);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const response = await fetchImplementation(url, {
    headers: { Accept: "image/jpeg, image/png, image/webp" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Research image download failed.");
  }

  const declaredMimeType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!declaredMimeType || !SUPPORTED_IMAGE_MIME_TYPES.has(declaredMimeType)) {
    await response.body?.cancel();
    throw new Error("Research image had an unsupported content type.");
  }

  const bytes = await readBoundedImage(response, MAX_RESEARCH_IMAGE_BYTES);
  const detectedMimeType = imageMimeTypeFromBytes(bytes);
  if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
    throw new Error("Research image data did not match its content type.");
  }

  return { bytes, mimeType: detectedMimeType };
}

export function researchImageFileName(mimeType: GeneratedImage["mimeType"]): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return `mira-research-image.${extension}`;
}
