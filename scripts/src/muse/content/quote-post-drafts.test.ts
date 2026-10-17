
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextGenerationProvider } from "../llm-provider.js";
import { QuotePostDraftService } from "./quote-post-drafts.js";

async function withService(
  response: string,
  run: (service: QuotePostDraftService, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "muse-drafts-"));

  const provider: TextGenerationProvider = {
    async generateText() {
      return response;
    },
  };

  try {
    await run(
      new QuotePostDraftService(provider, join(directory, "drafts.json")),
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creates and persists a pending quote-post draft", async () => {
  await withService("Interesting project update. Worth watching.", async (service, directory) => {
    const draft = await service.create(
      "https://x.com/example/status/123",
      "We are opening our waitlist today.",
    );

    assert.equal(draft.status, "PENDING");
    assert.equal(draft.draftText, "Interesting project update. Worth watching.");
    assert.equal((await service.list()).length, 1);

    const saved = JSON.parse(
      await readFile(join(directory, "drafts.json"), "utf8"),
    );

    assert.equal(saved[0].id, draft.id);
  });
});

test("approves or rejects a pending draft exactly once", async () => {
  await withService("A useful update.", async (service) => {
    const draft = await service.create(
      "https://x.com/example/status/456",
      "A project update.",
    );

    const approved = await service.updateStatus(draft.id, "APPROVED");
    assert.equal(approved.status, "APPROVED");

    await assert.rejects(
      service.updateStatus(draft.id, "REJECTED"),
      /already APPROVED/,
    );

    const second = await service.create(
      "https://x.com/example/status/789",
      "Another update.",
    );

    const rejected = await service.updateStatus(second.id, "REJECTED");
    assert.equal(rejected.status, "REJECTED");
  });
});

test("publishes only after a publishing attempt begins and records the X post", async () => {
  await withService("A useful update.", async (service) => {
    const draft = await service.create(
      "https://x.com/example/status/999",
      "An update to share.",
    );

    await assert.rejects(
      service.markPublished(draft.id, "post-123"),
      /Only a PUBLISHING draft/,
    );

    await service.updateStatus(draft.id, "APPROVED");
    const publishing = await service.beginPublishing(draft.id);
    assert.equal(publishing.status, "PUBLISHING");

    const published = await service.markPublished(draft.id, "post-123");
    assert.equal(published.status, "PUBLISHED");
    assert.equal(published.publishedPostId, "post-123");
    assert.equal(
      published.publishedPostUrl,
      "https://x.com/i/web/status/post-123",
    );
    assert.equal((await service.list())[0]?.status, "PUBLISHED");

    await assert.rejects(
      service.beginPublishing(draft.id),
      /Only an APPROVED draft/,
    );
    await assert.rejects(
      service.updateStatus(draft.id, "REJECTED"),
      /already PUBLISHED/,
    );
  });
});

test("marks an ambiguous publishing outcome uncertain and blocks retries", async () => {
  await withService("A useful update.", async (service) => {
    const draft = await service.create(
      "https://x.com/example/status/1000",
      "Another update to share.",
    );

    await service.updateStatus(draft.id, "APPROVED");
    await service.beginPublishing(draft.id);

    const uncertain = await service.markPublishUncertain(
      draft.id,
      "Connection lost while waiting for X.",
    );

    assert.equal(uncertain.status, "PUBLISH_UNCERTAIN");
    assert.equal(
      uncertain.publishError,
      "Connection lost while waiting for X.",
    );

    await assert.rejects(
      service.beginPublishing(draft.id),
      /Only an APPROVED draft/,
    );
    await assert.rejects(
      service.markPublished(draft.id, "post-456"),
      /Only a PUBLISHING draft/,
    );
  });
});

test("rejects invalid URLs and empty source text", async () => {
  await withService("A draft.", async (service) => {
    await assert.rejects(
      service.create("http://x.com/example/status/123", "Post text"),
      /HTTPS/,
    );

    await assert.rejects(
      service.create("https://x.com/example/status/123", "   "),
      /required/,
    );

    assert.equal((await service.list()).length, 0);
  });
});

test("rejects model output longer than 280 characters", async () => {
  await withService("x".repeat(281), async (service) => {
    await assert.rejects(
      service.create("https://x.com/example/status/123", "Post text"),
      /281 characters/,
    );

    assert.equal((await service.list()).length, 0);
  });
});
