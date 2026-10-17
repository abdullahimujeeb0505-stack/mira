const TRACKING_PARAMETERS = new Set([
  "ref",
  "source",
  "fbclid",
  "gclid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "igshid",
]);

/**
 * Normalizes public HTTP(S) URLs for identity comparisons.
 * This does not establish that a URL is safe, reachable, or legitimate.
 */
export function canonicalSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }

    url.hostname = url.hostname.toLowerCase();
    url.hash = "";

    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();

      if (
        normalized.startsWith("utm_") ||
        TRACKING_PARAMETERS.has(normalized)
      ) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return null;
  }
}
