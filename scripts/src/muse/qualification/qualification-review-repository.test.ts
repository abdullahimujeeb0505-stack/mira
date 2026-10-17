import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QualificationReviewRepository,
  type QualificationReviewItem,
} from "./qualification-review-repository.js";

function review(
  id: string,
  sourceId = "tavily-web-search",
  status: QualificationReviewItem["status"] = "PENDING",
): QualificationReviewItem {
  return {
    id,
    sourceId,
    updateId: id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    sourceUrl: `https://example.com/${id}`,
    decision: "REVIEW",
    reasons: ["Needs review"],
    evidence: ["Test evidence"],
    detectedAt: "2026-10-16T00:00:00.000Z",
    status,
  };
}

async function withRepository(
  run: (repo: QualificationReviewRepository, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "muse-review-test-"));
  const path = join(dir, "reviews.json");
  try {
    await run(new QualificationReviewRepository(path), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("sync refreshes pending reviews without duplicates", async () => {
  await withRepository(async (repo) => {
    await repo.add(review("one"));
    const refreshed = review("one");
    refreshed.title = "Updated title";
    await repo.syncPending("tavily-web-search", [refreshed]);
    await repo.syncPending("tavily-web-search", [refreshed]);

    const items = await repo.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Updated title");
    assert.equal(items[0].status, "PENDING");
  });
});

test("sync removes stale pending reviews but preserves resolved and other-source records", async () => {
  await withRepository(async (repo) => {
    await repo.add(review("stale"));
    await repo.add(review("resolved"));
    await repo.resolve("resolved", "APPROVED");
    await repo.add(review("other-source", "rss-feed"));

    await repo.syncPending("tavily-web-search", [review("new")]);

    const items = await repo.list();
    assert.deepEqual(
      items.map((item) => `${item.id}:${item.status}`).sort(),
      ["new:PENDING", "other-source:PENDING", "resolved:APPROVED"],
    );
  });
});

test("sync does not reset a previously rejected review to pending", async () => {
  await withRepository(async (repo, path) => {
    await repo.add(review("kept"));
    await repo.resolve("kept", "REJECTED");
    await repo.syncPending("tavily-web-search", [review("kept")]);

    const items = JSON.parse(await readFile(path, "utf8")) as QualificationReviewItem[];
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "REJECTED");
  });
});
