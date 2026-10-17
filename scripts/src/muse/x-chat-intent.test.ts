import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TextGenerationProvider } from "./llm-provider.js";
import { createMuseHttpServer } from "./http-server.js";
import { XOAuthService } from "./x-oauth.js";
import { QuotePostDraftService } from "./content/quote-post-drafts.js";

const accessToken = "test-access-code-long-enough-for-muse-123456";
const sessionSecret = "test-session-secret-for-muse-http-server";

async function withServer(
  providerFactory: () => TextGenerationProvider,
  run: (baseUrl: string) => Promise<void>,
  xOAuthService?: XOAuthService,
  quotePostDraftService?: QuotePostDraftService,
) {
  const dir = await mkdtemp(join(tmpdir(), "muse-x-intent-"));
  const server = createMuseHttpServer({
    sessionSecret,
    accessToken,
    memoryDirectory: dir,
    providerFactory,
    ...(xOAuthService ? { xOAuthService } : {}),
    ...(quotePostDraftService ? { quotePostDraftService } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind.");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()),
    );
    await rm(dir, { recursive: true, force: true });
  }
}

async function sendChat(baseUrl: string, message: string) {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  });
}

test("asking Muse to connect X returns a real OAuth authorization URL", async () => {
  const service = new XOAuthService({
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "http://127.0.0.1:3000/api/x/callback",
    tokenFile: join(tmpdir(), `unused-muse-token-${process.pid}.json`),
  });

  await withServer(
    () => ({ generateText: async () => "This should not be called." }),
    async baseUrl => {
      const response = await sendChat(baseUrl, "I want to connect X");
      assert.equal(response.status, 200);

      const result: unknown = await response.json();
      assert.ok(typeof result === "object" && result !== null);
      assert.ok("reply" in result && typeof result.reply === "string");
      assert.ok(
        "authorizationUrl" in result &&
        typeof result.authorizationUrl === "string",
      );
      assert.match(result.reply, /connect your X account/i);

      const url = new URL(result.authorizationUrl);
      assert.equal(url.hostname, "twitter.com");
      assert.equal(url.pathname, "/i/oauth2/authorize");
      assert.equal(url.searchParams.get("client_id"), "test-client");
      assert.ok(url.searchParams.get("state"));
    },
    service,
  );
});

test("ordinary messages still go through MuseAgent", async () => {
  let calls = 0;

  await withServer(
    () => ({
      generateText: async () => {
        calls += 1;
        return "Hello from MuseAgent.";
      },
    }),
    async baseUrl => {
      const response = await sendChat(baseUrl, "Tell me about Solana");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        reply: "Hello from MuseAgent.",
      });
      assert.equal(calls, 1);
    },
  );
});

test("publishing an approved quote draft uses the X service and records its post", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-chat-publish-"));
  const provider: TextGenerationProvider = {
    async generateText() {
      return "A reviewed quote post.";
    },
  };
  const drafts = new QuotePostDraftService(provider, join(directory, "drafts.json"));
  let publishCalls = 0;

  const fakeXService = {
    async publishPost(text: string) {
      publishCalls += 1;
      assert.equal(text, "A reviewed quote post.");
      return { id: "mock-post-789", text };
    },
  } as unknown as XOAuthService;

  try {
    const draft = await drafts.create(
      "https://x.com/example/status/789",
      "An original post to quote.",
    );
    await drafts.updateStatus(draft.id, "APPROVED");

    await withServer(
      () => provider,
      async (baseUrl) => {
        const response = await sendChat(baseUrl, `publish quote draft ${draft.id}`);
        assert.equal(response.status, 200);

        const result: unknown = await response.json();
        assert.ok(typeof result === "object" && result !== null);
        assert.ok("draft" in result && typeof result.draft === "object");
        const published = result.draft as {
          status: string;
          publishedPostId: string;
          publishedPostUrl: string;
        };
        assert.equal(published.status, "PUBLISHED");
        assert.equal(published.publishedPostId, "mock-post-789");
        assert.equal(
          published.publishedPostUrl,
          "https://x.com/i/web/status/mock-post-789",
        );
        assert.equal(publishCalls, 1);

        const retry = await sendChat(baseUrl, `publish quote draft ${draft.id}`);
        assert.equal(retry.status, 409);
        assert.equal(publishCalls, 1);
      },
      fakeXService,
      drafts,
    );

    const saved = (await drafts.list()).find((item) => item.id === draft.id);
    assert.equal(saved?.status, "PUBLISHED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishing a pending draft never calls X", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-chat-unapproved-"));
  const provider: TextGenerationProvider = {
    async generateText() {
      return "Not yet approved.";
    },
  };
  const drafts = new QuotePostDraftService(provider, join(directory, "drafts.json"));
  let publishCalls = 0;
  const fakeXService = {
    async publishPost() {
      publishCalls += 1;
      return { id: "unexpected-post", text: "unexpected" };
    },
  } as unknown as XOAuthService;

  try {
    const draft = await drafts.create(
      "https://x.com/example/status/321",
      "A source post.",
    );

    await withServer(
      () => provider,
      async (baseUrl) => {
        const response = await sendChat(baseUrl, `publish quote draft ${draft.id}`);
        assert.equal(response.status, 409);
        assert.equal(publishCalls, 0);
        assert.equal((await drafts.list())[0]?.status, "PENDING");
      },
      fakeXService,
      drafts,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ambiguous X publishing failure becomes uncertain and cannot be retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-chat-uncertain-"));
  const provider: TextGenerationProvider = {
    async generateText() {
      return "An approved post.";
    },
  };
  const drafts = new QuotePostDraftService(provider, join(directory, "drafts.json"));
  let publishCalls = 0;
  const fakeXService = {
    async publishPost() {
      publishCalls += 1;
      throw new Error("Connection lost while waiting for X.");
    },
  } as unknown as XOAuthService;

  try {
    const draft = await drafts.create(
      "https://x.com/example/status/654",
      "A source post.",
    );
    await drafts.updateStatus(draft.id, "APPROVED");

    await withServer(
      () => provider,
      async (baseUrl) => {
        const response = await sendChat(baseUrl, `publish quote draft ${draft.id}`);
        assert.equal(response.status, 502);
        const result: unknown = await response.json();
        assert.ok(typeof result === "object" && result !== null);
        assert.ok("draft" in result && typeof result.draft === "object");
        assert.equal((result.draft as { status: string }).status, "PUBLISH_UNCERTAIN");

        const retry = await sendChat(baseUrl, `publish quote draft ${draft.id}`);
        assert.equal(retry.status, 409);
        assert.equal(publishCalls, 1);
      },
      fakeXService,
      drafts,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quote-draft commands work through the authenticated chat endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-chat-drafts-"));
  const provider: TextGenerationProvider = {
    async generateText() {
      return "A concise quote post for review.";
    },
  };
  const drafts = new QuotePostDraftService(provider, join(directory, "drafts.json"));

  try {
    await withServer(
      () => provider,
      async (baseUrl) => {
        const createdResponse = await sendChat(
          baseUrl,
          "create quote draft: https://x.com/example/status/123 | We opened our waitlist today.",
        );
        assert.equal(createdResponse.status, 200);
        const createdResult: unknown = await createdResponse.json();
        assert.ok(typeof createdResult === "object" && createdResult !== null);
        assert.ok("draft" in createdResult && typeof createdResult.draft === "object");
        const createdDraft = createdResult.draft as { id: string; status: string };
        assert.ok(createdDraft.id);
        assert.equal(createdDraft.status, "PENDING");

        const listResponse = await sendChat(baseUrl, "list quote drafts");
        assert.equal(listResponse.status, 200);
        const listResult: unknown = await listResponse.json();
        assert.ok(typeof listResult === "object" && listResult !== null);
        assert.ok("drafts" in listResult && Array.isArray(listResult.drafts));
        assert.equal(listResult.drafts.length, 1);

        const approveResponse = await sendChat(
          baseUrl,
          `approve quote draft ${createdDraft.id}`,
        );
        assert.equal(approveResponse.status, 200);
        const approvedResult: unknown = await approveResponse.json();
        assert.ok(typeof approvedResult === "object" && approvedResult !== null);
        assert.ok("draft" in approvedResult && typeof approvedResult.draft === "object");
        assert.equal((approvedResult.draft as { status: string }).status, "APPROVED");

        const secondResponse = await sendChat(
          baseUrl,
          "create quote draft: https://x.com/example/status/456 | A second project update.",
        );
        assert.equal(secondResponse.status, 200);
        const secondResult: unknown = await secondResponse.json();
        assert.ok(typeof secondResult === "object" && secondResult !== null);
        assert.ok("draft" in secondResult && typeof secondResult.draft === "object");
        const secondDraft = secondResult.draft as { id: string; status: string };

        const rejectResponse = await sendChat(
          baseUrl,
          `reject quote draft ${secondDraft.id}`,
        );
        assert.equal(rejectResponse.status, 200);
        const rejectedResult: unknown = await rejectResponse.json();
        assert.ok(typeof rejectedResult === "object" && rejectedResult !== null);
        assert.ok("draft" in rejectedResult && typeof rejectedResult.draft === "object");
        assert.equal((rejectedResult.draft as { status: string }).status, "REJECTED");

        const finalDrafts = await drafts.list();
        assert.equal(finalDrafts.length, 2);
        assert.equal(finalDrafts.find((draft) => draft.id === createdDraft.id)?.status, "APPROVED");
        assert.equal(finalDrafts.find((draft) => draft.id === secondDraft.id)?.status, "REJECTED");
      },
      undefined,
      drafts,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
