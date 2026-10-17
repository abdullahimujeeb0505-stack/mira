import assert from "node:assert/strict";
import test from "node:test";
import { AtomRssSourceAdapter } from "./atom-rss-source-adapter.js";
import { SourceRateLimitError } from "./source-ingestion-service.js";
import type {
  SourceConfiguration,
  SourceFetchContext,
} from "./source-types.js";

const adapter = new AtomRssSourceAdapter();

const source: SourceConfiguration = {
  id: "test-feed",
  adapterType: "atom-rss",
  sourceType: "feed",
  sourceUrl: "https://example.com/feed.xml",
  pollIntervalMs: 60_000,
  timeoutMs: 10_000,
  enabled: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const context: SourceFetchContext = {
  signal: new AbortController().signal,
  retrievedAt: "2026-10-14T12:00:00.000Z",
};

async function withMockFetch(
  response: Response,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => response;
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("parses RSS entries and preserves their IDs and metadata", async () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Example feed</title>
      <item>
        <title>New Web3 opportunity</title>
        <description>Applications are open.</description>
        <link>https://example.com/opportunity/1</link>
        <guid>opportunity-1</guid>
        <pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

  await withMockFetch(new Response(xml, { status: 200 }), async () => {
    const updates = await adapter.fetchUpdates(source, context);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "opportunity-1");
    assert.equal(updates[0].sourceId, source.id);
    assert.equal(updates[0].title, "New Web3 opportunity");
    assert.equal(updates[0].text, "Applications are open.");
    assert.equal(
      updates[0].sourceUrl,
      "https://example.com/opportunity/1",
    );
    assert.equal(
      updates[0].publishedAt,
      "2026-10-13T10:00:00.000Z",
    );
    assert.equal(updates[0].retrievedAt, context.retrievedAt);
  });
});

test("parses Atom entries and resolves relative links", async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <title>Example Atom feed</title>
    <entry>
      <id>atom-entry-1</id>
      <title>Research opportunity</title>
      <summary>Research applications are open.</summary>
      <link href="/opportunities/2" rel="alternate"/>
      <published>2026-10-12T09:30:00Z</published>
    </entry>
  </feed>`;

  await withMockFetch(new Response(xml, { status: 200 }), async () => {
    const updates = await adapter.fetchUpdates(source, context);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "atom-entry-1");
    assert.equal(updates[0].title, "Research opportunity");
    assert.equal(
      updates[0].sourceUrl,
      "https://example.com/opportunities/2",
    );
    assert.equal(
      updates[0].publishedAt,
      "2026-10-12T09:30:00.000Z",
    );
  });
});

test("rejects malformed XML", async () => {
  await withMockFetch(
    new Response("<rss><channel><item></channel></rss>", {
      status: 200,
    }),
    async () => {
      await assert.rejects(
        adapter.fetchUpdates(source, context),
        /malformed XML/i,
      );
    },
  );
});

test("rejects XML containing a DTD", async () => {
  const xml = `<!DOCTYPE rss [<!ENTITY x "unsafe">]>
    <rss><channel><item><title>&x;</title></item></channel></rss>`;

  await withMockFetch(new Response(xml, { status: 200 }), async () => {
    await assert.rejects(
      adapter.fetchUpdates(source, context),
      /DTD|entities/i,
    );
  });
});

test("converts HTTP 429 into a rate-limit error", async () => {
  await withMockFetch(
    new Response("Rate limited", {
      status: 429,
      headers: { "retry-after": "30" },
    }),
    async () => {
      await assert.rejects(
        adapter.fetchUpdates(source, context),
        (error: unknown) => {
          assert.ok(error instanceof SourceRateLimitError);
          assert.equal(error.retryAfterMs, 30_000);
          return true;
        },
      );
    },
  );
});

test("rejects unsuccessful HTTP responses", async () => {
  await withMockFetch(
    new Response("Unavailable", { status: 503 }),
    async () => {
      await assert.rejects(
        adapter.fetchUpdates(source, context),
        /HTTP 503/,
      );
    },
  );
});

test("rejects feed URLs with embedded credentials", async () => {
  const unsafeSource = {
    ...source,
    sourceUrl: "https://user:password@example.com/feed.xml",
  };

  await assert.rejects(
    adapter.fetchUpdates(unsafeSource, context),
    /without embedded credentials/i,
  );
});
