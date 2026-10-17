import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ArchivedSource = {
  title: string;
  url: string;
  content: string;
  retrievedAt?: string;
};

type ArchivedRun = {
  id?: string;
  question: string;
  answer: string;
  plan?: {
    objective?: string;
    questions?: string[];
    queries?: string[];
  };
  sources?: ArchivedSource[];
};

type IndexedDocument = {
  hash: string;
  runFile: string;
  question: string;
  answer: string;
  sourceCount: number;
  sources: Array<{
    title: string;
    url: string;
    hash: string;
    content: string;
  }>;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = path.resolve(here, "../../../data/research-archive");
const indexPath = path.join(archiveDir, "search-index.json");

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hash(value: string): string {
  return createHash("sha256").update(normalize(value)).digest("hex");
}

function tokenize(value: string): string[] {
  return normalize(value)
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function score(query: string, fields: string[]): number {
  const queryWords = [...new Set(tokenize(query))];
  if (queryWords.length === 0) return 0;

  const combined = normalize(fields.join(" "));
  const documentWords = new Set(tokenize(combined));

  let matched = 0;
  for (const word of queryWords) {
    if (documentWords.has(word)) matched++;
  }

  const coverage = matched / queryWords.length;
  const phraseBonus = combined.includes(normalize(query)) ? 2 : 0;

  return coverage + phraseBonus;
}

async function readRuns(): Promise<Array<{ file: string; run: ArchivedRun }>> {
  const entries = await readdir(archiveDir, { withFileTypes: true });
  const files = entries
    .filter((entry) =>
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      entry.name !== "search-index.json",
    )
    .map((entry) => entry.name)
    .sort();

  const runs: Array<{ file: string; run: ArchivedRun }> = [];

  for (const file of files) {
    try {
      const raw = await readFile(path.join(archiveDir, file), "utf8");
      const run = JSON.parse(raw) as ArchivedRun;

      if (typeof run.question !== "string" || typeof run.answer !== "string") {
        continue;
      }

      runs.push({ file, run });
    } catch {
      console.error(`Skipping unreadable archive: ${file}`);
    }
  }

  return runs;
}

async function rebuildIndex(): Promise<void> {
  const runs = await readRuns();
  const indexed: IndexedDocument[] = [];
  const seenRuns = new Set<string>();
  const seenSources = new Set<string>();

  for (const { file, run } of runs) {
    const runHash = hash(`${run.question}\n${run.answer}`);

    // Keep the first copy of an identical research result in the index.
    if (seenRuns.has(runHash)) continue;
    seenRuns.add(runHash);

    const sources: IndexedDocument["sources"] = [];

    for (const source of run.sources ?? []) {
      if (
        typeof source.title !== "string" ||
        typeof source.url !== "string" ||
        typeof source.content !== "string"
      ) {
        continue;
      }

      const sourceHash = hash(source.content);
      const urlKey = normalize(source.url);

      // Index each unique URL/content pair once. Original archive files
      // remain untouched; deduplication only affects this derived index.
      const identity = `${urlKey}:${sourceHash}`;
      if (seenSources.has(identity)) continue;
      seenSources.add(identity);

      sources.push({
        title: source.title,
        url: source.url,
        hash: sourceHash,
        content: source.content,
      });
    }

    indexed.push({
      hash: runHash,
      runFile: file,
      question: run.question,
      answer: run.answer,
      sourceCount: sources.length,
      sources,
    });
  }

  await writeFile(
    indexPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runCount: indexed.length,
        uniqueSourceCount: indexed.reduce(
          (total, item) => total + item.sourceCount,
          0,
        ),
        documents: indexed,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Indexed research runs: ${indexed.length}`);
  console.log(
    `Unique sources indexed: ${indexed.reduce(
      (total, item) => total + item.sourceCount,
      0,
    )}`,
  );
  console.log(`Index: ${indexPath}`);
}

async function searchArchive(query: string, limit: number): Promise<void> {
  let raw: string;

  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    console.log("No search index found. Building it now...");
    await rebuildIndex();
    raw = await readFile(indexPath, "utf8");
  }

  const index = JSON.parse(raw) as {
    documents: IndexedDocument[];
  };

  const results = index.documents
    .map((document) => {
      const runScore = score(query, [
        document.question,
        document.answer,
      ]);

      const sourceMatches = document.sources
        .map((source) => ({
          ...source,
          score: score(query, [source.title, source.content]),
        }))
        .filter((source) => source.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      return {
        document,
        score: runScore,
        sourceMatches,
      };
    })
    .filter((item) => item.score > 0 || item.sourceMatches.length > 0)
    .sort(
      (a, b) =>
        Math.max(b.score, ...b.sourceMatches.map((s) => s.score)) -
        Math.max(a.score, ...a.sourceMatches.map((s) => s.score)),
    )
    .slice(0, limit);

  console.log(`\nResearch archive search: "${query}"`);
  console.log(`Matches: ${results.length}\n`);

  for (const [index, result] of results.entries()) {
    console.log(`${index + 1}. ${result.document.question}`);
    console.log(`   Archive: ${result.document.runFile}`);

    if (result.score > 0) {
      console.log(
        `   Answer excerpt: ${result.document.answer
          .replace(/\s+/g, " ")
          .slice(0, 350)}...`,
      );
    }

    for (const source of result.sourceMatches) {
      console.log(`   Source: ${source.title}`);
      console.log(`   URL: ${source.url}`);
      console.log(
        `   Evidence excerpt: ${source.content
          .replace(/\s+/g, " ")
          .slice(0, 220)}...`,
      );
    }

    console.log("");
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "index") {
    await rebuildIndex();
    return;
  }

  if (command === "search") {
    const query = args.filter((arg) => !arg.startsWith("--")).join(" ");
    const limitArg = args.find((arg) => arg.startsWith("--limit="));
    const limit = Math.max(
      1,
      Math.min(20, Number(limitArg?.split("=")[1]) || 5),
    );

    if (!query.trim()) {
      console.log(
        'Usage: pnpm --filter @workspace/scripts exec tsx ./src/muse/research/archive-search.ts search "your query" [--limit=5]',
      );
      process.exitCode = 1;
      return;
    }

    await searchArchive(query, limit);
    return;
  }

  console.log(
    "Commands:\n" +
    "  index                  Rebuild the local research index\n" +
    '  search "query"          Search prior research and evidence',
  );
}

void main().catch((error: unknown) => {
  console.error(
    "Archive operation failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
