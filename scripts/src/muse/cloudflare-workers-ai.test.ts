import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudflareAIConfigurationError,
  CloudflareWorkersAIProvider,
} from "./cloudflare-workers-ai.js";

const accountId = "a".repeat(32);
const token = "cloudflare-test-token";

function jpegData(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
}

test("Cloudflare Workers AI requires a valid account ID and token", () => {
  assert.throws(
    () => new CloudflareWorkersAIProvider({ accountId: "", apiToken: token }),
    CloudflareAIConfigurationError,
  );
  assert.throws(
    () =>
      new CloudflareWorkersAIProvider({
        accountId: "not-an-account",
        apiToken: token,
      }),
    /32-character Cloudflare account ID/,
  );
  assert.throws(
    () => new CloudflareWorkersAIProvider({ accountId, apiToken: " " }),
    /Missing MUSE_CLOUDFLARE_AI_TOKEN/,
  );
});

test("image generation calls Flux through the server-side Cloudflare API", async () => {
  let requestUrl = "";
  let requestOptions: RequestInit | undefined;
  const image = jpegData();
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestOptions = init;
      return new Response(
        JSON.stringify({
          success: true,
          result: { image: image.toString("base64") },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await provider.generateImage("A blue bicycle beside a lake");
  assert.match(
    requestUrl,
    /accounts\/[a-f0-9]{32}\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/,
  );
  assert.equal(
    new Headers(requestOptions?.headers).get("Authorization"),
    `Bearer ${token}`,
  );
  assert.equal(
    new Headers(requestOptions?.headers).get("Content-Type"),
    "application/json",
  );
  assert.equal(
    new Headers(requestOptions?.headers).get("Accept"),
    "application/json",
  );
  assert.equal(new URL(requestUrl).searchParams.has("token"), false);
  const body = JSON.parse(String(requestOptions?.body)) as {
    prompt: string;
    steps: number;
  };
  assert.deepEqual(body, {
    prompt: "A blue bicycle beside a lake",
    steps: 4,
  });
  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(result.bytes, image);
});

test("image understanding sends an image data URI and returns its answer", async () => {
  let requestUrl = "";
  let requestOptions: RequestInit | undefined;
  const image = jpegData();
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestOptions = init;
      return new Response(
        JSON.stringify({
          success: true,
          result: { answer: "A blue bicycle is beside a lake." },
        }),
        { status: 200 },
      );
    },
  });

  const answer = await provider.describeImage(
    image,
    "image/jpeg",
    "What is in this picture?",
  );
  assert.match(requestUrl, /ai\/run\/@cf\/moondream\/moondream3\.1-9B-A2B$/);
  assert.equal(
    new Headers(requestOptions?.headers).get("Accept"),
    "text/event-stream",
  );
  const body = JSON.parse(String(requestOptions?.body)) as {
    image: string;
    question: string;
    task: string;
    max_tokens: number;
    stream: boolean;
  };
  assert.equal(
    body.image,
    `data:image/jpeg;base64,${image.toString("base64")}`,
  );
  assert.match(body.question, /What is in this picture\?/);
  assert.match(body.question, /untrusted content/);
  assert.equal(body.task, "query");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.stream, true);
  assert.equal(answer, "A blue bicycle is beside a lake.");
});

test("image understanding collects Cloudflare SSE response chunks", async () => {
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async () =>
      new Response(
        [
          'data: {"response":"A red "}',
          'data: {"response":"bicycle."}',
          'data: {"finish_reason":"stop"}',
        ].join("\n") + "\n\n",
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        },
      ),
  });

  const answer = await provider.describeImage(
    jpegData(),
    "image/jpeg",
    "What is shown?",
  );
  assert.equal(answer, "A red bicycle.");
});

test("Cloudflare errors are bounded and never expose the API token", async () => {
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: `Denied for ${token}` }],
        }),
        { status: 403 },
      ),
  });

  await assert.rejects(
    provider.generateImage("A small flower"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});
