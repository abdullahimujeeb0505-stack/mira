import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createResearchContextRetriever } from "./research-context.js";

function report(question: string, answer: string) {
  return {
    question,
    answer,
    plan: { objective: question },
    sources: [
      {
        title: "Research source",
        url: "https://example.org/research",
        retrievedAt: "2026-10-20T12:00:00.000Z",
        content: `${question} ${answer}`,
      },
    ],
  };
}

test("archive context returns relevant historical evidence and skips corrupt files", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "muse-research-context-"),
  );
  const retrieve = createResearchContextRetriever(directory);

  try {
    await writeFile(
      path.join(directory, "2026-10-20-pollination.json"),
      JSON.stringify(
        report("What is pollination?", "Pollen moves between flowers."),
      ),
    );
    await writeFile(
      path.join(directory, "2026-10-19-unrelated.json"),
      JSON.stringify(report("What is a bicycle?", "A bicycle has two wheels.")),
    );
    await writeFile(path.join(directory, "broken.json"), "{");
    await writeFile(
      path.join(directory, "search-index.json"),
      JSON.stringify(
        report("Pollination index should be ignored", "Not a run."),
      ),
    );

    const context = await retrieve("pollination");
    assert.match(context, /RELEVANT ARCHIVED RESEARCH/);
    assert.match(context, /Original question: What is pollination\?/);
    assert.match(context, /Pollen moves between flowers\./);
    assert.match(context, /Research source/);
    assert.match(context, /URL: https:\/\/example\.org\/research/);
    assert.doesNotMatch(
      context,
      /What is a bicycle\?|Pollination index should be ignored/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive cache refreshes when a report changes or a new report is added", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "muse-research-context-cache-"),
  );
  const firstPath = path.join(directory, "2026-10-20-pollination.json");
  const retrieve = createResearchContextRetriever(directory);

  try {
    await writeFile(
      firstPath,
      JSON.stringify(
        report("What is pollination?", "The initial archived answer."),
      ),
    );
    const first = await retrieve("pollination");
    assert.match(first, /The initial archived answer\./);

    await writeFile(
      firstPath,
      JSON.stringify(
        report(
          "How does pollination work in flowering plants?",
          "The updated archived answer includes additional details.",
        ),
      ),
    );
    await writeFile(
      path.join(directory, "2026-10-20-pollinator.json"),
      JSON.stringify(
        report(
          "How do pollination and pollinators help?",
          "Pollinators transfer pollen.",
        ),
      ),
    );

    const updated = await retrieve("pollination");
    assert.match(updated, /How does pollination work in flowering plants\?/);
    assert.match(
      updated,
      /The updated archived answer includes additional details\./,
    );
    assert.match(updated, /How do pollination and pollinators help\?/);
    assert.doesNotMatch(updated, /The initial archived answer\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty queries and missing archives remain non-fatal", async () => {
  const directory = path.join(
    tmpdir(),
    `muse-research-context-missing-${process.pid}`,
  );
  const retrieve = createResearchContextRetriever(directory);

  assert.equal(await retrieve("the and a"), "");
  assert.equal(await retrieve("pollination"), "");
});
