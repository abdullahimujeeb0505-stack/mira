import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonMemoryRepository } from "./json-memory-repository.js";

test("search retrieves study and learning preferences for a personal profile question", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-memory-search-test-"));
  const repository = new JsonMemoryRepository(join(root, "memories.json"));

  try {
    await repository.create({
      category: "USER",
      content: "I am a 100L Pharmacy student at Obafemi Awolowo University (OAU), Ile-Ife, Nigeria.",
    });
    await repository.create({
      category: "USER",
      content: "I prefer beginner-friendly, exam-focused explanations with full workings, no skipped steps, one concept at a time, then an example and a similar exercise.",
    });
    await repository.create({
      category: "ACTIVE",
      content: "Muse tracks Web3 opportunities, deadlines, campaigns, and outcomes.",
    });

    const results = await repository.search(
      "What do you know about my studies and my preferred learning style? Use my saved memories.",
    );
    const contents = results.map((record) => record.content);

    assert.ok(
      contents.some((content) => content.includes("Pharmacy student")),
      "should retrieve the user's studies",
    );
    assert.ok(
      contents.some((content) => content.includes("exam-focused")),
      "should retrieve the user's learning preferences",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
