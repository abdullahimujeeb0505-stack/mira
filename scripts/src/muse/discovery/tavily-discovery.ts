import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { qualifyOpportunity } from "../qualification/opportunity-qualification.js";
import { QualificationReviewRepository } from "../qualification/qualification-review-repository.js";

export interface DiscoveryItem {
  id: string;
  title: string;
  url: string;
  content: string;
  query: string;
  score: number | null;
  discoveredAt: string;
  decision: "QUALIFIED" | "REVIEW" | "REJECTED";
  reasons: string[];
  evidence: string[];
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
  error?: string;
}

const QUERIES = [
  "Web3 blockchain crypto hackathon applications open prize pool deadline",
  "Web3 blockchain ecosystem grants funding builder program applications open",
  "Web3 crypto developer bounties open submissions rewards",
  "Web3 startup accelerator applications open blockchain projects",
  "Web3 testnet campaigns contributor rewards whitelist waitlist official",
];

const DATA_PATH = process.env.MUSE_DISCOVERIES_PATH ??
  "data/muse-discoveries.json";

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|ref|referral|source)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

async function readItems(): Promise<DiscoveryItem[]> {
  try {
    const raw = await readFile(DATA_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Discovery file is not an array.");
    return parsed as DiscoveryItem[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveItems(items: DiscoveryItem[]): Promise<void> {
  await mkdir(dirname(DATA_PATH), { recursive: true });
  const temp = `${DATA_PATH}.tmp`;
  await writeFile(temp, JSON.stringify(items, null, 2), "utf8");
  await rename(temp, DATA_PATH);
}

async function search(query: string): Promise<TavilyResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is missing. Load ~/.muse-secrets.");

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 5,
      topic: "general",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    // Do not print request headers or the API key.
    throw new Error(`Tavily search failed with HTTP ${response.status}.`);
  }

  const data = await response.json() as TavilyResponse;
  if (data.error) throw new Error("Tavily returned an API error.");
  return Array.isArray(data.results) ? data.results : [];
}

export async function runDiscovery(): Promise<void> {
  const items = await readItems();
  const byUrl = new Map(items.map((item) => [item.url, item]));
  const reviewQueue = new QualificationReviewRepository(
    process.env.MUSE_REVIEW_PATH ??
      "data/muse-qualification-review.json",
  );
  let fetched = 0;
  let added = 0;
  let failed = 0;

  for (const query of QUERIES) {
    try {
      const results = await search(query);
      fetched += results.length;

      for (const result of results) {
        const url = typeof result.url === "string"
          ? canonicalUrl(result.url) : null;
        const title = (result.title ?? "").trim().slice(0, 1000);
        const content = (result.content ?? "").trim().slice(0, 12000);
        if (!url || !title || !content || byUrl.has(url)) continue;

        const qualification = qualifyOpportunity({
          title,
          description: content,
          sourceUrl: url,
        });

        const item: DiscoveryItem = {
          id: createHash("sha256").update(url).digest("hex").slice(0, 24),
          title,
          url,
          content,
          query,
          score: typeof result.score === "number" ? result.score : null,
          discoveredAt: new Date().toISOString(),
          decision: qualification.decision,
          reasons: qualification.reasons,
          evidence: qualification.evidence,
        };

        byUrl.set(url, item);
        added++;

        if (qualification.decision === "REVIEW") {
          await reviewQueue.add({
            id: `web:${item.id}`,
            sourceId: "tavily-web-search",
            updateId: item.id,
            title: item.title,
            description: item.content,
            sourceUrl: item.url,
            decision: "REVIEW",
            reasons: item.reasons,
            evidence: item.evidence,
            detectedAt: item.discoveredAt,
            status: "PENDING",
          });
        }
      }
      console.log(`Searched: ${query}`);
    } catch (error) {
      failed++;
      console.error(
        `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  await saveItems([...byUrl.values()]);
  const all = [...byUrl.values()];
  console.log(`\nSearch complete: fetched=${fetched}, new=${added}, failed_queries=${failed}`);
  console.log(`Saved results: ${DATA_PATH}`);
  console.log(`Classifications: qualified=${all.filter(x => x.decision === "QUALIFIED").length}, review=${all.filter(x => x.decision === "REVIEW").length}, rejected=${all.filter(x => x.decision === "REJECTED").length}`);
  console.log("Note: QUALIFIED means a promising candidate, not independently verified.");
}

export async function reclassifyDiscoveries(): Promise<void> {
  const items = await readItems();
  const reviewQueue = new QualificationReviewRepository(
    process.env.MUSE_REVIEW_PATH ??
      "data/muse-qualification-review.json",
  );
  const pendingReviews = [];
  const now = new Date().toISOString();

  for (const item of items) {
    const result = qualifyOpportunity({
      title: item.title,
      description: item.content,
      sourceUrl: item.url,
    });

    item.decision = result.decision;
    item.reasons = result.reasons;
    item.evidence = result.evidence;

    if (result.decision === "REVIEW") {
      pendingReviews.push({
        id: `web:${item.id}`,
        sourceId: "tavily-web-search",
        updateId: item.id,
        title: item.title,
        description: item.content,
        sourceUrl: item.url,
        decision: "REVIEW" as const,
        reasons: item.reasons,
        evidence: item.evidence,
        detectedAt: item.discoveredAt || now,
        status: "PENDING" as const,
      });
    }
  }

  await saveItems(items);
  await reviewQueue.syncPending("tavily-web-search", pendingReviews);

  console.log(`Reclassified ${items.length} saved discoveries.`);
  console.log(`Qualified: ${items.filter(x => x.decision === "QUALIFIED").length}`);
  console.log(`Review: ${items.filter(x => x.decision === "REVIEW").length}`);
  console.log(`Rejected: ${items.filter(x => x.decision === "REJECTED").length}`);
  console.log("Existing discovery IDs, URLs, content, and timestamps were preserved.");
  console.log("Previously resolved reviews were preserved.");
}

export async function listDiscoveries(): Promise<void> {
  const items = await readItems();
  const selected = items.filter((item) => item.decision !== "REJECTED");
  if (selected.length === 0) {
    console.log("No promising discoveries saved yet. Run the search command first.");
    return;
  }

  for (const item of selected.slice(-50).reverse()) {
    console.log(`\n[${item.decision}] ${item.title}`);
    console.log(item.url);
    console.log(`Reason: ${item.reasons.join("; ")}`);
    console.log(`Discovered: ${item.discoveredAt}`);
  }
  console.log(`\nShowing up to 50 non-rejected discoveries.`);
}
