import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ArchivedSource = {
  title?: string;
  url?: string;
  retrievedAt?: string;
  content?: string;
};

type ArchivedRun = {
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

type IndexedSource = {
  hash: string;
  title: string;
  url: string;
  content: string;
  retrievedAt: string;
  report: string;
  question: string;
};

type IndexedReport = {
  file: string;
  question: string;
  answer: string;
  sourceCount: number;
};

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what",
  "when", "where", "which", "who", "why", "how", "are", "was",
  "were", "been", "being", "have", "has", "had", "does", "did",
  "can", "could", "should", "would", "into", "about", "their",
  "there", "them", "they", "then", "than", "your", "you", "our",
  "its", "not", "but", "also", "use", "using", "used", "more",
  "most", "such", "each", "other", "some", "any", "all", "both",
]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function hashText(value: string): string {
  return createHash("sha256")
    .update(value.trim().replace(/\s+/g, " "))
    .digest("hex");
}

function scoreText(query: string, text: string): number {
  const terms = [...new Set(tokens(query))];
  if (terms.length === 0) return 0;

  const haystack = text.toLowerCase();
  const bodyTerms = new Set(tokens(text));

  let score = 0;
  let matched = 0;

  for (const term of terms) {
    if (!bodyTerms.has(term)) continue;

    matched += 1;
    score += 1;

    // Exact phrase and title matches are more useful than scattered matches.
    const occurrences = haystack.split(term).length - 1;
    score += Math.min(occurrences, 5) * 0.15;
  }

  return score + (matched / terms.length) * 3;
}

async function loadArchive(): Promise<{
  reports: IndexedReport[];
  sources: IndexedSource[];
}> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const directory = path.resolve(here, "../../data/research-archive");

  let files: string[];

  try {
    files = (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return { reports: [], sources: [] };
  }

  const reports: IndexedReport[] = [];
  const sourceMap = new Map<string, IndexedSource>();

  for (const file of files) {
    try {
      const raw = await readFile(path.join(directory, file), "utf8");
      const run = JSON.parse(raw) as ArchivedRun;

      if (typeof run !== "object" || run === null) continue;

      const question =
        typeof run.question === "string" ? run.question : "(untitled research)";

      reports.push({
        file,
        question,
        answer: typeof run.answer === "string" ? run.answer : "",
        sourceCount: Array.isArray(run.sources) ? run.sources.length : 0,
      });

      for (const source of run.sources ?? []) {
        if (!source || typeof source.content !== "string") continue;

        const content = source.content.trim();
        if (!content) continue;

        const hash = hashText(content);

        // Keep one canonical source per identical normalized content hash.
        if (!sourceMap.has(hash)) {
          sourceMap.set(hash, {
            hash,
            title: source.title ?? "Untitled source",
            url: source.url ?? "",
            content,
            retrievedAt: source.retrievedAt ?? "",
            report: file,
            question,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Skipping unreadable archive ${file}: ${message}`);
    }
  }

  return { reports, sources: [...sourceMap.values()] };
}

function printHelp(): void {
  console.log(`Muse local research archive

Usage:
  pnpm --filter @workspace/scripts exec tsx ./src/muse/research-archive-cli.ts stats
  pnpm --filter @workspace/scripts exec tsx ./src/muse/research-archive-cli.ts reports
  pnpm --filter @workspace/scripts exec tsx ./src/muse/research-archive-cli.ts search "search terms"
  pnpm --filter @workspace/scripts exec tsx ./src/muse/research-archive-cli.ts source "search terms"

Commands:
  stats    Count saved reports and unique source documents.
  reports  List saved research questions.
  search   Search report questions, answers, and source metadata.
  source   Search retrieved source text and return matching excerpts.

The index is rebuilt from local JSON archives on each run.
No API key or external service is needed.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const query = rest.join(" ").trim();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const { reports, sources } = await loadArchive();

  if (command === "stats") {
    console.log(`Research reports: ${reports.length}`);
    console.log(`Unique source documents: ${sources.length}`);
    console.log(
      `Duplicate source documents skipped: ${
        reports.reduce((sum, report) => sum + report.sourceCount, 0) -
        sources.length
      }`,
    );
    console.log("Storage: local JSON archives; index built in memory.");
    return;
  }

  if (command === "reports") {
    if (reports.length === 0) {
      console.log("No research reports found.");
      return;
    }

    for (const report of reports) {
      console.log(`\n${report.question}`);
      console.log(`  File: ${report.file}`);
      console.log(`  Sources: ${report.sourceCount}`);
    }
    return;
  }

  if (command !== "search" && command !== "source") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (!query) {
    console.error(`Usage: research-archive-cli.ts ${command} "search terms"`);
    process.exitCode = 1;
    return;
  }

  const results: Array<{
    score: number;
    heading: string;
    detail: string;
    location: string;
  }> = [];

  if (command === "search") {
    for (const report of reports) {
      const score = scoreText(
        query,
        `${report.question}\n${report.answer}`,
      );

      if (score > 0) {
        results.push({
          score,
          heading: report.question,
          detail: report.answer.slice(0, 500).replace(/\s+/g, " "),
          location: report.file,
        });
      }
    }

    for (const source of sources) {
      const score =
        scoreText(query, source.title) * 2 +
        scoreText(query, source.question) +
        scoreText(query, source.content.slice(0, 5_000)) * 0.25;

      if (score > 0) {
        results.push({
          score,
          heading: source.title,
          detail: `${source.url}\nResearch: ${source.question}`,
          location: source.report,
        });
      }
    }
  } else {
    for (const source of sources) {
      const score =
        scoreText(query, source.title) * 2 +
        scoreText(query, source.content);

      if (score <= 0) continue;

      const terms = [...new Set(tokens(query))];
      const lower = source.content.toLowerCase();
      const firstMatch = Math.max(
        0,
        lower.indexOf(terms[0] ?? ""),
      );
      const start = Math.max(0, firstMatch - 220);
      const excerpt = source.content
        .slice(start, start + 650)
        .replace(/\s+/g, " ");

      results.push({
        score,
        heading: source.title,
        detail: `${excerpt}\nURL: ${source.url}`,
        location: source.report,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 10);

  console.log(`\nQuery: ${query}`);
  console.log(`Matches: ${results.length}; showing ${top.length}`);

  if (top.length === 0) {
    console.log("No matches. Try broader or different keywords.");
    return;
  }

  top.forEach((result, index) => {
    console.log(`\n${index + 1}. ${result.heading}`);
    console.log(`   Relevance: ${result.score.toFixed(2)}`);
    console.log(`   ${result.detail}`);
    console.log(`   Archive: ${result.location}`);
  });
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
