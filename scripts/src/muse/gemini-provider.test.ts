import assert from "node:assert/strict";
import test from "node:test";
import { GeminiProvider } from "./gemini-provider.js";

const TEST_API_KEY = "gemini-unit-test-secret";

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Gemini defaults to Flash Lite, maps chat turns, and omits thought parts", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    let requestedUrl: string | URL | Request | undefined;
    let requestedInit: RequestInit | undefined;
    const provider = new GeminiProvider({
      fetchImplementation: async (url, init) => {
        requestedUrl = url;
        requestedInit = init;
        return jsonResponse({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "private reasoning", thought: true },
                  { text: "Gemini " },
                  { text: "answer" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        });
      },
    });

    assert.equal(provider.providerName, "gemini");
    assert.equal(provider.model, "gemini-3.5-flash-lite");
    assert.equal(
      await provider.generateText({
        systemPrompt: "You are Mira.",
        conversation: [
          { role: "user", content: "Hello." },
          { role: "assistant", content: "Hi." },
          { role: "user", content: "Who are you?" },
        ],
      }),
      "Gemini answer",
    );

    assert.equal(
      requestedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    assert.equal(requestedInit?.method, "POST");
    const headers = new Headers(requestedInit?.headers);
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("x-goog-api-key"), TEST_API_KEY);
    assert.equal(String(requestedUrl).includes(TEST_API_KEY), false);
    assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
      systemInstruction: { parts: [{ text: "You are Mira." }] },
      contents: [
        { role: "user", parts: [{ text: "Hello." }] },
        { role: "model", parts: [{ text: "Hi." }] },
        { role: "user", parts: [{ text: "Who are you?" }] },
      ],
    });
  }));

test("Gemini omits an empty system instruction", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new GeminiProvider({
      fetchImplementation: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        });
      },
    });

    await provider.generateText({
      systemPrompt: "",
      conversation: [{ role: "user", content: "ok" }],
    });
    assert.deepEqual(body, {
      contents: [{ role: "user", parts: [{ text: "ok" }] }],
    });
  }));

test("Gemini reports prompt and response policy blocks without unsafe fallback wording", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    for (const body of [
      {
        promptFeedback: { blockReason: "SAFETY" },
        candidates: [],
      },
      {
        candidates: [
          {
            content: { parts: [] },
            finishReason: "RECITATION",
          },
        ],
      },
    ]) {
      const provider = new GeminiProvider({
        fetchImplementation: async () => jsonResponse(body),
      });
      await assert.rejects(
        provider.generateText({
          systemPrompt: "Be helpful.",
          conversation: [{ role: "user", content: "Question" }],
        }),
        /Gemini blocked the request.*(SAFETY|RECITATION)/,
      );
    }
  }));

test("Gemini distinguishes malformed, unsupported, and empty successful responses", async () =>
  await withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    const request = {
      systemPrompt: "Be helpful.",
      conversation: [{ role: "user" as const, content: "Question" }],
    };

    await assert.rejects(
      new GeminiProvider({
        fetchImplementation: async () => new Response("{"),
      }).generateText(request),
      /malformed JSON/,
    );

    for (const body of [
      { candidates: [{ content: { parts: "not-an-array" } }] },
      { result: { text: "unexpected" } },
    ]) {
      await assert.rejects(
        new GeminiProvider({
          fetchImplementation: async () => jsonResponse(body),
        }).generateText(request),
        /unsupported response structure/,
      );
    }

    for (const body of [
      { candidates: [] },
      { candidates: [{ content: { parts: [{ text: "  " }] } }] },
    ]) {
      await assert.rejects(
        new GeminiProvider({
          fetchImplementation: async () => jsonResponse(body),
        }).generateText(request),
        /without text output/,
      );
    }
  }));

test("Gemini HTTP errors identify authentication and rate limits without response data", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    const request = {
      systemPrompt: "Be helpful.",
      conversation: [{ role: "user" as const, content: "Question" }],
    };

    for (const [status, expected] of [
      [401, /Gemini rejected the configured credentials \(HTTP 401\)/],
      [429, /Gemini rate limit reached \(HTTP 429\)/],
      [503, /Gemini request failed with HTTP 503/],
    ] as const) {
      await assert.rejects(
        new GeminiProvider({
          fetchImplementation: async () =>
            new Response(JSON.stringify({ error: TEST_API_KEY }), { status }),
        }).generateText(request),
        expected,
      );
    }
  }));

test("Gemini HTTP error details are bounded and redact the API key", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    const detail = `Invalid API key ${TEST_API_KEY}\n${"x".repeat(500)}`;
    const provider = new GeminiProvider({
      fetchImplementation: async () =>
        jsonResponse({ error: { message: detail } }, 400),
    });

    await assert.rejects(
      provider.generateText({
        systemPrompt: "Be helpful.",
        conversation: [{ role: "user", content: "Question" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Gemini request failed with HTTP 400/);
        assert.match(error.message, /Invalid API key \[REDACTED\]/);
        assert.ok(error.message.length < 300);
        assert.equal(error.message.includes(TEST_API_KEY), false);
        return true;
      },
    );
  }));

test("Gemini network errors redact the configured API key", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    const provider = new GeminiProvider({
      fetchImplementation: async () => {
        throw new Error(`network failed for ${TEST_API_KEY}`);
      },
    });

    await assert.rejects(
      provider.generateText({
        systemPrompt: "Be helpful.",
        conversation: [{ role: "user", content: "Question" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\[REDACTED\]/);
        assert.equal(error.message.includes(TEST_API_KEY), false);
        return true;
      },
    );
  }));

test("Gemini reports request timeouts with the configured duration", async () =>
  withEnvironment({ GEMINI_API_KEY: TEST_API_KEY }, async () => {
    const provider = new GeminiProvider({
      timeoutMs: 25,
      fetchImplementation: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });

    await assert.rejects(
      provider.generateText({
        systemPrompt: "Be helpful.",
        conversation: [{ role: "user", content: "Question" }],
      }),
      /Gemini request timed out after 25 ms/,
    );
  }));

test("Gemini requires GEMINI_API_KEY", async () =>
  withEnvironment({ GEMINI_API_KEY: undefined }, () => {
    assert.throws(() => new GeminiProvider(), /Missing GEMINI_API_KEY/);
  }));

test("Gemini ignores a GEMINI_MODEL environment override", async () =>
  withEnvironment(
    { GEMINI_API_KEY: TEST_API_KEY, GEMINI_MODEL: "another-model" },
    () => {
      assert.equal(new GeminiProvider().model, "gemini-3.5-flash-lite");
    },
  ));
