import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ArchivedSource = {
  title?: string;
  url?: string;
  content?: string;
  retrievedAt?: string;
};

type ArchivedResearch = {
  id?: string;
  question?: string;
  answer?: string;
  plan?: {
    objective?: string;
    questions?: string[];
    queries?: string[];
  };
  sources?: ArchivedSource[];
};

type SearchResult = {
  file: string;
  question: string;
  answer: string;
  score: number;
  matches: string[];
  sources: ArchivedSource[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = path.resolve(here, "../../data/research-archive");
const indexPath = path.join(archiveDir, "search-index.json");

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9+#._-]*/g)
    ?.filter((word) => word.length > 1) ?? [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function scoreDocument(
  queryTerms: string[],
  document: ArchivedResearch,
): { score: number; matches: string[] } {
  const title = document.question ?? "";
  const answer = document.answer ?? "";
  const plan = document.plan?.objective ?? "";
  const sources = document.sources ?? [];

  const searchable = [
    title,
    plan,
    ...(document.plan?.questions ?? []),
    ...(document.plan?.queries ?? []),
    answer,
    ...sources.map((source) => `${source.title ?? ""} ${source.content ?? ""}`),
  ].join("\n");

  const allTokens = tokenize(searchable);
  const answerTokens = tokenize(answer);
  const titleTokens = tokenize(`${title} ${plan}`);
  const sourceTokens = tokenize(
    sources.map((source) => source.title ?? "").join(" "),
  );

  const score = queryTerms.reduce((total, term) => {
    const frequency = allTokens.filter((token) => token === term).length;
    const titleFrequency = titleTokens.filter((token) => token === term).length;
    const answerFrequency = answerTokens.filter((token) => token === term).length;
    const sourceFrequency = sourceTokens.filter((token) => token === term).length;

    // Deterministic local ranking; title matches receive extra weight.
    return total +
      Math.min(frequency, 8) +
      titleFrequency * 5 +
      Math.min(answerFrequency, 5) * 0.5 +
      sourceFrequency * 2;
  }, 0);

  const matches = unique(
    queryTerms.filter((term) => allTokens.includes(term)),
  );

  return { score, matches };
}

async function loadArchive(): Promise<
  Array<{ file: string; document: ArchivedResearch }>
> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(archiveDir, { recursive: true }),
  );

  const files = (await readdir(archiveDir))
    .filter((file) => file.endsWith(".json"))
    .filter((file) => file !== "search-index.json")
    .sort();

  const documents: Array<{ file: string; document: ArchivedResearch }> = [];

  for (const file of files) {
    try {
      const raw = await readFile(path.join(archiveDir, file), "utf8");
      const document = JSON.parse(raw) as ArchivedResearch;

      if (
        typeof document.question === "string" &&
        typeof document.answer === "string"
      ) {
        documents.push({ file, document });
      }
    } catch {
      console.error(`Skipping unreadable archive: ${file}`);
    }
  }

  return documents;
}

async function rebuildIndex(
  entries: Array<{ file: string; document: ArchivedResearch }>,
): Promise<void> {
  const index = entries.map(({ file, document }) => ({
    file,
    id: document.id ?? file,
    question: document.question ?? "",
    answer: document.answer ?? "",
    sources: (document.sources ?? []).map((source) => ({
      title: source.title ?? "",
      url: source.url ?? "",
    })),
  }));

  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
  console.log(`Index rebuilt: ${index.length} research records.`);
}

function printResults(results: SearchResult[]): void {
  if (results.length === 0) {
    console.log("No matching archived research found.");
    return;
  }

  for (const [position, result] of results.entries()) {
    console.log(`\n${"=".repeat(64)}`);
    console.log(`${position + 1}. ${result.question}`);
    console.log(`Score: ${result.score.toFixed(1)}`);
    console.log(`Archive: ${result.file}`);
    console.log(`Matched terms: ${result.matches.join(", ") || "(none)"}`);
    console.log("\nRelevant answer excerpt:");

    const terms = new Set(result.matches);
    const paragraphs = result.answer.split(/\n\s*\n/);
    const ranked = paragraphs
      .map((paragraph, order) => ({
        paragraph,
        order,
        score: tokenize(paragraph).filter((token) => terms.has(token)).length,
      }))
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .filter((item) => item.paragraph.trim())
      .slice(0, 3)
      .sort((a, b) => a.order - b.order);

    for (const item of ranked) {
      console.log(`\n${item.paragraph.trim().slice(0, 1_200)}`);
    }

    console.log("\nSources:");
    for (const [index, source] of (result.sources ?? []).entries()) {
      console.log(
        `[${index + 1}] ${source.title ?? "Untitled source"}\n` +
        `    ${source.url ?? "No URL recorded"}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rebuild = args.includes("--rebuild");
  const query = args.filter((arg) => arg !== "--rebuild").join(" ").trim();

  const entries = await loadArchive();

  if (rebuild) {
    await rebuildIndex(entries);
    if (!query) return;
  }

  if (!query) {
    console.log(
      'Usage: pnpm --filter @workspace/scripts exec tsx ' +
      './src/muse/research-search.ts "search terms"\n' +
      "       Add --rebuild to regenerate the local search index.",
    );
    return;
  }

  const queryTerms = unique(tokenize(query));

  if (queryTerms.length === 0) {
    console.error("Enter at least one searchable word.");
    process.exitCode = 1;
    return;
  }

  const results: SearchResult[] = entries
    .map(({ file, document }) => {
      const ranked = scoreDocument(queryTerms, document);

      return {
        file,
        question: document.question ?? "",
        answer: document.answer ?? "",
        sources: document.sources ?? [],
        ...ranked,
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 5);

  console.log(`Archive records: ${entries.length}`);
  console.log(`Query: ${query}`);
  printResults(results);
}

void main().catch((error: unknown) => {
  console.error(
    "Archive search failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
