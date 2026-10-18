/**
 * SSRF-safe HTTP retrieval shared by every Muse module that fetches a URL.
 *
 * All research and link-reading traffic must go through `fetchPublicUrl`. It
 * re-validates the destination at every redirect hop, so a public URL cannot
 * be used to pivot into a private network range.
 *
 * Known limitation (unchanged from the original research pipeline): the DNS
 * preflight is not pinned to the socket that `fetch` later opens, so a hostname
 * whose answer changes between the lookup and the connection is not caught.
 * This makes Muse's fetcher safe for its own bounded research use, not a
 * general-purpose URL-fetching service.
 */
import { lookup } from "node:dns/promises";

export const DEFAULT_MAX_REDIRECTS = 4;

/**
 * True when a failure is worth one retry: a timeout, an aborted socket, or a
 * DNS/connection error.
 *
 * Shared by every Muse fetch path so the research pipeline and the direct link
 * reader apply the same retry policy instead of two drifting copies.
 */
export function isTransientNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return true;
    if (/timed out|timeout/i.test(error.message)) return true;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    return ["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED"].includes(
      String(error.code),
    );
  }
  return false;
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.includes(":")) {
    if (normalized === "::" || normalized === "::1") return false;
    if (/^(?:fc|fd|fe[89ab]|ff)/.test(normalized)) return false;
    const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mappedIpv4 ? isPublicAddress(mappedIpv4) : true;
  }

  const octets = normalized.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

/**
 * Returns the normalized URL when it is safe to fetch, otherwise null.
 *
 * Rejects non-HTTP(S) schemes, embedded credentials, localhost-style hostnames,
 * cloud metadata endpoints, and literal private IP addresses. Hostnames are not
 * resolved here; use `assertPublicHost` for that.
 */
export function safeHttpUrl(raw: string): string | null {
  try {
    if (raw.length > 2_048) return null;
    const parsed = new URL(raw);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (
      parsed.username ||
      parsed.password ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "metadata.google.internal" ||
      host === "169.254.169.254" ||
      (host.includes(":") && !isPublicAddress(host)) ||
      (/^\d+(?:\.\d+){3}$/.test(host) && !isPublicAddress(host))
    ) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function isSafeResearchUrl(raw: string): boolean {
  return safeHttpUrl(raw) !== null;
}

export type ResolveHost = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string }[]>;

/**
 * Throws unless every address the hostname resolves to is public.
 *
 * IP literals are checked directly without a DNS round trip. `resolveHost` is
 * injectable so tests can exercise the private-range branches without a DNS
 * server.
 */
export async function assertPublicHost(
  url: URL,
  resolveHost: ResolveHost = lookup as ResolveHost,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) {
    if (!isPublicAddress(host)) {
      throw new Error("Research URL resolves to a non-public address.");
    }
    return;
  }
  const addresses = await resolveHost(host, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("Research URL resolves to a non-public address.");
  }
}

export interface FetchedUrl {
  response: Response;
  /**
   * URL of the hop that produced `response`, after redirects.
   *
   * Returned explicitly because `response.url` is empty for constructed
   * responses (tests) and can lag the requested URL; callers that record the
   * final location need a value that is correct in both cases.
   */
  finalUrl: string;
}

export interface FetchPublicUrlOptions {
  fetchImplementation?: typeof fetch;
  resolveHost?: ResolveHost;
}

/**
 * Fetches a URL, following redirects manually so each hop is re-validated.
 *
 * `init` is reused across hops; the caller's `AbortSignal` therefore bounds the
 * whole redirect chain rather than a single request.
 */
export async function fetchPublicUrl(
  initialUrl: string,
  init: RequestInit,
  maxRedirects: number = DEFAULT_MAX_REDIRECTS,
  options: FetchPublicUrlOptions = {},
): Promise<FetchedUrl> {
  const doFetch = options.fetchImplementation ?? fetch;
  const resolveHost = options.resolveHost;
  let currentUrl = safeHttpUrl(initialUrl);
  if (!currentUrl) throw new Error("Research URL is not a safe HTTP URL.");

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const parsed = new URL(currentUrl);
    if (resolveHost) await assertPublicHost(parsed, resolveHost);
    else await assertPublicHost(parsed);
    const response = await doFetch(currentUrl, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location || redirectCount === maxRedirects) {
      await response.body?.cancel();
      throw new Error("Research page exceeded the redirect limit.");
    }
    const redirectedUrl = safeHttpUrl(new URL(location, currentUrl).toString());
    await response.body?.cancel();
    if (!redirectedUrl) throw new Error("Research page redirected to an unsafe URL.");
    currentUrl = redirectedUrl;
  }

  throw new Error("Research page exceeded the redirect limit.");
}

/**
 * Reads a response body as text, cancelling the stream once `maxBytes` is
 * passed. A hostile or merely large origin cannot exhaust memory this way.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Research response exceeded the configured size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Normalizes a URL for identity comparison: fragment and query removed,
 * trailing slash stripped.
 */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}
