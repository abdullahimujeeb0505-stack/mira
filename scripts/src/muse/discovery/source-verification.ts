import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { assessVerificationEvidence } from "./evidence-assessment.js";
import { dirname } from "node:path";
import { isIP } from "node:net";
import type { DiscoveryItem } from "./tavily-discovery.js";

export type VerificationStatus =
  | "SOURCE_REACHABLE"
  | "INACCESSIBLE"
  | "REDIRECT_NOT_FOLLOWED"
  | "HTTP_ERROR"
  | "UNSAFE_URL";

export interface SourceVerification {
  discoveryId: string;
  url: string;
  checkedAt: string;
  status: VerificationStatus;
  httpStatus: number | null;
  pageTitle: string | null;
  pageTextExcerpt: string;
  applicationLinks: Array<{ text: string; url: string }>;
  deadlineClues: string[];
  eligibilityClues: string[];
  rewardClues: string[];
  warnings: string[];
}

const DISCOVERY_PATH =
  process.env.MUSE_DISCOVERIES_PATH ?? "data/muse-discoveries.json";
const VERIFICATION_PATH =
  process.env.MUSE_VERIFICATIONS_PATH ?? "data/muse-verifications.json";
const VERIFICATION_HISTORY_PATH =
  process.env.MUSE_VERIFICATION_HISTORY_PATH ??
  "data/muse-verification-history.json";
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 15_000;

function safePublicWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      isIP(host) !== 0 ||
      !host.includes(".")
    ) return null;

    return url;
  } catch {
    return null;
  }
}



async function fetchWithTransientRetry(
  url: URL,
): Promise<{ response: Response; finalUrl: URL; blocked: boolean }> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchSameHostRedirects(url);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const transient =
        error instanceof TypeError ||
        name === "AbortError" ||
        name === "TimeoutError";

      if (!transient || attempt === maxAttempts) throw error;

      const delayMs = 400 * attempt;
      console.warn(
        `Transient source fetch failure (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs} ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Fetch retry attempts exhausted.");
}

async function fetchSameHostRedirects(
  initialUrl: URL,
): Promise<{ response: Response; finalUrl: URL; blocked: boolean }> {
  let current = initialUrl;

  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "MuseOpportunityVerifier/1.0",
        "Accept": "text/html,text/plain;q=0.9,*/*;q=0.1",
      },
    });

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: current, blocked: false };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, finalUrl: current, blocked: true };
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { response, finalUrl: current, blocked: true };
    }

    const safe = safePublicWebUrl(next.toString());
    if (!safe || safe.hostname !== initialUrl.hostname) {
      return { response, finalUrl: current, blocked: true };
    }

    if (hop === 5) {
      return { response, finalUrl: current, blocked: true };
    }

    current = safe;
  }

  throw new Error("Redirect limit exceeded.");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(Math.min(Number(n), 0x10ffff)),
    );
}

function plainText(html: string): string {
  return decodeHtml(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? plainText(match[1]!).slice(0, 300) || null : null;
}

export function extractLinks(
  html: string,
  base: URL,
): Array<{ text: string; url: string }> {
  const results: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();

  const mainMatch = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i);
  let content = mainMatch ? mainMatch[2]! : html;

  content = content
    .replace(/<(script|style|noscript|svg|nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(div|section)\b(?=[^>]*(?:class|id)\s*=\s*["'][^"']*(?:related|recommend|popular|trending|sidebar|navigation|promo|advert|more-stories)[^"']*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  const anchors = content.matchAll(
    /<a\b([^>]*?)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi,
  );

  for (const match of anchors) {
    const rawHref = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "").trim();
    const text = plainText(match[6] ?? "").slice(0, 160);
    if (!rawHref || !text) continue;

    const contextStart = Math.max(0, match.index! - 350);
    const contextEnd = Math.min(content.length, match.index! + match[0].length + 180);
    const context = plainText(content.slice(contextStart, contextEnd));

    if (/\b(?:related stories|recommended for you|you may also like|more from|popular articles|trending stories)\b/i.test(context)) {
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(rawHref, base);
    } catch {
      continue;
    }

    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.username ||
      resolved.password
    ) continue;

    const path = resolved.pathname.toLowerCase();
    if (/\b(like|comment|reply|follow|connect|share|repost|reaction|see comments)\b/i.test(text)) continue;
    const segments = path.split("/").filter(Boolean);

    // These are navigation or editorial destinations, not application endpoints.
    if (
      segments.some((segment) =>
        /^(?:login|log-in|signin|sign-in|signup|sign-up|auth|oauth|search|tag|tags|category|categories|topic|topics|author|authors|profile|profiles|account|accounts|comments?|reactions?|feed|notifications?)$/.test(segment)
      ) ||
      /\/(?:news|article|articles|blog|blogs|press|stories)\//i.test(path)
    ) continue;

    // Require an actionable anchor label or an application-like destination.
    const actionableLabel =
      /\b(?:apply(?: now)?|application form|register(?: now)?|registration|submit application|join waitlist|join now|participate|claim reward|start quest|enter hackathon|apply for grant|sign up)\b/i.test(text);

    const applicationPath =
      /(?:^|\/)(?:apply|application|applications|register|registration|signup|sign-up|waitlist|allowlist|quests?|bount(?:y|ies)|grants?)(?:\/|$|[?#.-])/i.test(path);

    if (!actionableLabel && !applicationPath) continue;

    // Normalize fragments and common tracking parameters before deduplication.
    resolved.hash = "";
    for (const key of [...resolved.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|ref_src|source)$/i.test(key)) {
        resolved.searchParams.delete(key);
      }
    }

    const linkUrl = resolved.toString();
    if (seen.has(linkUrl)) continue;
    seen.add(linkUrl);

    results.push({ text, url: linkUrl });
    if (results.length >= 30) break;
  }

  return results;
}

function clues(text: string, pattern: RegExp, limit = 12): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, match.index! - 100);
    const end = Math.min(text.length, match.index! + match[0].length + 160);
    found.add(text.slice(start, end).trim());
    if (found.size >= limit) break;
  }
  return [...found];
}

async function readLimitedBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = MAX_BYTES - size;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        size += Math.max(0, remaining);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(combined), truncated };
}

async function loadDiscoveries(): Promise<DiscoveryItem[]> {
  const parsed: unknown = JSON.parse(await readFile(DISCOVERY_PATH, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Discovery store is not an array.");
  return parsed as DiscoveryItem[];
}

async function loadVerifications(): Promise<SourceVerification[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(VERIFICATION_PATH, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Verification store is not an array.");
    return parsed as SourceVerification[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}


async function appendVerificationHistory(
  result: SourceVerification,
): Promise<void> {
  await mkdir(dirname(VERIFICATION_HISTORY_PATH), { recursive: true });

  let history: SourceVerification[] = [];
  try {
    const parsed: unknown = JSON.parse(
      await readFile(VERIFICATION_HISTORY_PATH, "utf8"),
    );
    if (!Array.isArray(parsed)) {
      throw new Error("Verification history store is not an array.");
    }
    history = parsed as SourceVerification[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  history.push(result);
  const temp = `${VERIFICATION_HISTORY_PATH}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(history, null, 2) + "\n", "utf8");
  await rename(temp, VERIFICATION_HISTORY_PATH);
}

async function saveVerifications(items: SourceVerification[]): Promise<void> {
  await mkdir(dirname(VERIFICATION_PATH), { recursive: true });
  const temp = `${VERIFICATION_PATH}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(items, null, 2) + "\n", "utf8");
  await rename(temp, VERIFICATION_PATH);
}

async function verify(item: DiscoveryItem): Promise<SourceVerification> {
  const checkedAt = new Date().toISOString();
  const base: SourceVerification = {
    discoveryId: item.id,
    url: item.url,
    checkedAt,
    status: "INACCESSIBLE",
    httpStatus: null,
    pageTitle: null,
    pageTextExcerpt: "",
    applicationLinks: [],
    deadlineClues: [],
    eligibilityClues: [],
    rewardClues: [],
    warnings: [
      "A reachable source does not prove an opportunity is legitimate, active, or suitable.",
      "Links are extracted evidence, not endorsements. Review them before opening.",
    ],
  };

  const url = safePublicWebUrl(item.url);
  if (!url) {
    return { ...base, status: "UNSAFE_URL", warnings: [...base.warnings, "URL failed basic public-web URL validation."] };
  }

  try {
    const fetched = await fetchWithTransientRetry(url);
    const response = fetched.response;
    const finalUrl = fetched.finalUrl;

    base.httpStatus = response.status;

    if (fetched.blocked || (response.status >= 300 && response.status < 400)) {
      return {
        ...base,
        status: "REDIRECT_NOT_FOLLOWED",
        warnings: [...base.warnings, "Redirect was blocked because it changed host, lacked a valid destination, or exceeded the redirect limit."],
      };
    }

    if (!response.ok) {
      return { ...base, status: "HTTP_ERROR", warnings: [...base.warnings, `Source returned HTTP ${response.status}.`] };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      return { ...base, status: "HTTP_ERROR", warnings: [...base.warnings, `Unsupported content type: ${contentType || "unknown"}.`] };
    }

    const bodyResult = await readLimitedBody(response);
    const body = bodyResult.text;
    const text = plainText(body).slice(0, 40_000);
    if (!text) {
      return { ...base, status: "INACCESSIBLE", warnings: [...base.warnings, "No readable page text was extracted."] };
    }

    const deadlineClues = clues(
      text,
      /\b(?:deadline|apply by|applications close|closing date|ends on|ends in|until|before)\b[^.!?\n]{0,140}/gi,
    );
    const eligibilityClues = clues(
      text,
      /\b(?:eligib(?:le|ility)|who can apply|open to|must be|requirements|prerequisites|residents of|citizens of)\b[^.!?\n]{0,150}/gi,
    );
    const rewardClues = clues(
      text,
      /(?:[$€£]\s?[\d,.]+(?:\s?(?:million|billion|k|m))?|\b(?:prize pool|reward(?:s)?|grant funding|up to)\b)[^.!?\n]{0,120}/gi,
    );

    const applicationLinks = extractLinks(body, finalUrl);
    const warnings = [...base.warnings];
    if (bodyResult.truncated) {
      warnings.push("Page exceeded the 1 MB verification limit; only the first 1 MB was inspected.");
    }
    if (deadlineClues.length === 0) warnings.push("No clear deadline clue extracted; this does not prove there is no deadline.");
    if (eligibilityClues.length === 0) warnings.push("No clear eligibility clue extracted.");
    if (rewardClues.length === 0) warnings.push("No clear reward clue extracted.");
    if (applicationLinks.length === 0) warnings.push("No likely application or participation link extracted.");

    return {
      ...base,
      url: finalUrl.toString(),
      status: "SOURCE_REACHABLE",
      pageTitle: extractTitle(body),
      pageTextExcerpt: text.slice(0, 3000),
      applicationLinks,
      deadlineClues,
      eligibilityClues,
      rewardClues,
      warnings,
    };
  } catch (error) {
    return {
      ...base,
      status: "INACCESSIBLE",
      warnings: [
        ...base.warnings,
        error instanceof Error ? error.message.slice(0, 240) : "Request failed.",
      ],
    };
  }
}

export async function verifyDiscovery(id: string): Promise<void> {
  const discoveries = await loadDiscoveries();
  const item = discoveries.find((entry) => entry.id === id);
  if (!item) throw new Error(`Discovery not found: ${id}`);

  const result = await verify(item);
  await appendVerificationHistory(result);
  const records = await loadVerifications();
  const index = records.findIndex((entry) => entry.discoveryId === id);
  if (index >= 0) records[index] = result;
  else records.push(result);
  await saveVerifications(records);

  console.log(`Verification status: ${result.status}`);
  const assessment = assessVerificationEvidence(result);
  console.log(`Source accessibility: ${assessment.sourceAccessibility}`);
  console.log(`Offer assessment: ${assessment.offer}`);
  console.log(`Eligibility assessment: ${assessment.eligibility}`);
  console.log(`Deadline assessment: ${assessment.deadline}`);
  console.log(`Reward assessment: ${assessment.rewards}`);
  for (const limitation of assessment.limitations) {
    console.log(`LIMITATION: ${limitation}`);
  }
  console.log(`Title: ${result.pageTitle ?? item.title}`);
  console.log(`Source: ${result.url}`);
  console.log(`Checked: ${result.checkedAt}`);
  console.log(`HTTP: ${result.httpStatus ?? "not reached"}`);
  console.log(`Application links: ${result.applicationLinks.length}`);
  for (const link of result.applicationLinks.slice(0, 10)) {
    console.log(`  - ${link.text}: ${link.url}`);
  }
  console.log(`Deadline clues: ${result.deadlineClues.length}`);
  for (const clue of result.deadlineClues) console.log(`  - ${clue}`);
  console.log(`Eligibility clues: ${result.eligibilityClues.length}`);
  for (const clue of result.eligibilityClues) console.log(`  - ${clue}`);
  console.log(`Reward clues: ${result.rewardClues.length}`);
  for (const clue of result.rewardClues) console.log(`  - ${clue}`);
  for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
  console.log(`Saved: ${VERIFICATION_PATH}`);
}

export async function verifyAllDiscoveries(): Promise<void> {
  const items = await loadDiscoveries();
  const candidates = items.filter((item) => item.decision !== "REJECTED");
  let success = 0;

  for (const item of candidates) {
    console.log(`\n=== ${item.title} ===`);
    try {
      const result = await verify(item);
      await appendVerificationHistory(result);
      const records = await loadVerifications();
      const index = records.findIndex((entry) => entry.discoveryId === item.id);
      if (index >= 0) records[index] = result;
      else records.push(result);
      await saveVerifications(records);
      console.log(`${result.status} | HTTP ${result.httpStatus ?? "N/A"} | links=${result.applicationLinks.length}`);
      success++;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Verification failed.");
    }
  }

  console.log(`\nChecked ${success}/${candidates.length} candidate pages.`);
  console.log(`Results saved to ${VERIFICATION_PATH}`);
}
