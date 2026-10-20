import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudflareAIConfigurationError,
  CloudflareAIRequestError,
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

test("image understanding sends LLaVA image bytes and a prompt", async () => {
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
          result: { description: "A blue bicycle is beside a lake." },
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
  assert.match(requestUrl, /ai\/run\/@cf\/llava-hf\/llava-1\.5-7b-hf$/);
  assert.equal(
    new Headers(requestOptions?.headers).get("Accept"),
    "application/json",
  );
  const body = JSON.parse(String(requestOptions?.body)) as {
    image: number[];
    prompt: string;
    max_tokens: number;
    temperature: number;
  };
  assert.deepEqual(body.image, Array.from(image));
  assert.match(body.prompt, /What is in this picture\?/);
  assert.match(body.prompt, /untrusted content/);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, 0.2);
  assert.equal(answer, "A blue bicycle is beside a lake.");
});

test("empty LLaVA responses fall back to Moondream and collect SSE chunks", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const image = jpegData();
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({ success: true, result: { description: " " } }),
          { status: 200 },
        );
      }
      return new Response(
        [
          'data: {"response":"A red "}',
          'data: {"response":"bicycle."}',
          'data: {"finish_reason":"stop"}',
        ].join("\n") + "\n\n",
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        },
      );
    },
  });

  const answer = await provider.describeImage(
    image,
    "image/jpeg",
    "What is shown?",
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0]?.url ?? "", /@cf\/llava-hf\/llava-1\.5-7b-hf$/);
  assert.match(requests[1]?.url ?? "", /@cf\/moondream\/moondream3\.1-9B-A2B$/);
  assert.equal(
    new Headers(requests[1]?.init?.headers).get("Accept"),
    "text/event-stream",
  );
  const fallbackBody = JSON.parse(String(requests[1]?.init?.body)) as {
    image: string;
    question: string;
    task: string;
    max_tokens: number;
    stream: boolean;
  };
  assert.equal(
    fallbackBody.image,
    `data:image/jpeg;base64,${image.toString("base64")}`,
  );
  assert.match(fallbackBody.question, /What is shown\?/);
  assert.match(fallbackBody.question, /untrusted content/);
  assert.equal(fallbackBody.task, "query");
  assert.equal(fallbackBody.max_tokens, 512);
  assert.equal(fallbackBody.stream, true);
  assert.equal(answer, "A red bicycle.");
});

test("vision falls back to Moondream after a retryable Cloudflare error", async () => {
  const urls: string[] = [];
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "temporarily unavailable" }],
          }),
          { status: 503 },
        );
      }
      return new Response(
        JSON.stringify({ success: true, result: { answer: "A green leaf." } }),
        { status: 200 },
      );
    },
  });

  const answer = await provider.describeImage(
    jpegData(),
    "image/jpeg",
    "Describe this.",
  );
  assert.match(urls[0] ?? "", /@cf\/llava-hf\/llava-1\.5-7b-hf$/);
  assert.match(urls[1] ?? "", /@cf\/moondream\/moondream3\.1-9B-A2B$/);
  assert.equal(answer, "A green leaf.");
});

test("vision falls back on an unexpected primary response and rejects two empty responses", async () => {
  let requests = 0;
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async () => {
      requests += 1;
      return new Response(
        JSON.stringify({ success: true, result: { unexpected: true } }),
        { status: 200 },
      );
    },
  });

  await assert.rejects(
    provider.describeImage(jpegData(), "image/jpeg", "Describe this."),
    /vision models returned no description/,
  );
  assert.equal(requests, 2);
});

test("vision does not retry authorization errors on fallback", async () => {
  for (const status of [401, 403]) {
    let requests = 0;
    const provider = new CloudflareWorkersAIProvider({
      accountId,
      apiToken: token,
      fetchImplementation: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "permission denied" }],
          }),
          { status },
        );
      },
    });

    await assert.rejects(
      provider.describeImage(jpegData(), "image/jpeg", "Describe this."),
      (error: unknown) => {
        assert.ok(error instanceof CloudflareAIRequestError);
        assert.equal(error.status, status);
        return true;
      },
    );
    assert.equal(requests, 1);
  }
});

test("vision does not retry a quota error on fallback", async () => {
  let requests = 0;
  const provider = new CloudflareWorkersAIProvider({
    accountId,
    apiToken: token,
    fetchImplementation: async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: "quota exceeded" }],
        }),
        { status: 429, headers: { "Retry-After": "60" } },
      );
    },
  });

  await assert.rejects(
    provider.describeImage(jpegData(), "image/jpeg", "Describe this."),
    (error: unknown) => {
      assert.ok(error instanceof CloudflareAIRequestError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSeconds, 60);
      return true;
    },
  );
  assert.equal(requests, 1);
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
