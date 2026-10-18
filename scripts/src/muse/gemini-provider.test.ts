import assert from "node:assert/strict";
import test from "node:test";
import { GeminiProvider } from "./gemini-provider.js";

const GEMINI_KEY = "gemini-unit-test-key";

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

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: string[]): Response {
  return new Response(
    events.map((event) => `data: ${event}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const FULL_ANSWER =
  "Photon is an open-source framework connecting agents to messaging apps.";

test("Gemini builds its generateContent request with system instruction and roles", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY, GEMINI_MODEL: "gemini-test-model" }, async () => {
    let url: string | URL | Request | undefined;
    let init: RequestInit | undefined;
    const provider = new GeminiProvider({
      fetchImplementation: async (requestedUrl, requestedInit) => {
        url = requestedUrl;
        init = requestedInit;
        return jsonResponse(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: FULL_ANSWER }] } }] }),
        );
      },
    });

    const text = await provider.generateText({
      systemPrompt: "You are Muse.",
      conversation: [
        { role: "user", content: "What is Photon?" },
        { role: "assistant", content: "It is a framework." },
        { role: "user", content: "Say more." },
      ],
    });

    assert.equal(text, FULL_ANSWER);
    assert.equal(provider.providerName, "gemini");
    assert.equal(provider.model, "gemini-test-model");

    const endpoint = String(url);
    assert.match(endpoint, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-test-model:streamGenerateContent/);
    assert.match(endpoint, /alt=sse/);

    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], GEMINI_KEY);
    assert.equal(headers["Content-Type"], "application/json");

    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "What is Photon?" }] },
      { role: "model", parts: [{ text: "It is a framework." }] },
      { role: "user", parts: [{ text: "Say more." }] },
    ]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "You are Muse." }] });
  }));

test("Gemini merges consecutive same-role turns", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new GeminiProvider({
      fetchImplementation: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
        );
      },
      stream: false,
    });

    await provider.generateText({
      systemPrompt: "",
      conversation: [
        { role: "user", content: "First." },
        { role: "user", content: "Second." },
        { role: "assistant", content: "Reply." },
      ],
    });

    assert.deepEqual(body?.contents, [
      { role: "user", parts: [{ text: "First." }, { text: "Second." }] },
      { role: "model", parts: [{ text: "Reply." }] },
    ]);
  }));

test("Gemini accumulates streamed SSE delta events into the full answer", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const provider = new GeminiProvider({
      fetchImplementation: async () =>
        sseResponse([
          JSON.stringify({
            candidates: [{ index: 0, content: { parts: [{ text: "Photon is " }] } }],
          }),
          JSON.stringify({
            candidates: [
              { index: 0, content: { parts: [{ text: "an open-source framework " }] } },
            ],
          }),
          JSON.stringify({
            candidates: [
              {
                index: 0,
                content: {
                  parts: [{ text: "connecting agents to messaging apps." }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 10 },
          }),
        ]),
    });

    const text = await provider.generateText({
      systemPrompt: "You are Muse.",
      conversation: [{ role: "user", content: "What is Photon?" }],
    });

    assert.equal(text, FULL_ANSWER);
  }));

test("Gemini falls back to JSON parsing when a gateway ignores alt=sse", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const provider = new GeminiProvider({
      fetchImplementation: async () =>
        jsonResponse(JSON.stringify({ candidates: [{ content: { parts: [{ text: FULL_ANSWER }] } }] })),
    });

    const text = await provider.generateText({
      systemPrompt: "You are Muse.",
      conversation: [{ role: "user", content: "What is Photon?" }],
    });
    assert.equal(text, FULL_ANSWER);
  }));

test("Gemini surfaces safety blocks as distinct errors, not empty output", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const provider = new GeminiProvider({
      fetchImplementation: async () =>
        jsonResponse(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })),
      stream: false,
    });

    await assert.rejects(
      () =>
        provider.generateText({
          systemPrompt: "You are Muse.",
          conversation: [{ role: "user", content: "Something disallowed" }],
        }),
      /blocked the request before generation \(the prompt was flagged by safety filters\)/,
    );
  }));

test("Gemini reports blocking finish reasons distinctly", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const provider = new GeminiProvider({
      fetchImplementation: async () =>
        jsonResponse(
          JSON.stringify({
            candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
          }),
        ),
      stream: false,
    });

    await assert.rejects(
      () =>
        provider.generateText({
          systemPrompt: "You are Muse.",
          conversation: [{ role: "user", content: "prompt" }],
        }),
      /flagged by safety filters/,
    );
  }));

test("Gemini distinguishes empty and malformed success payloads", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const empty = new GeminiProvider({
      fetchImplementation: async () =>
        jsonResponse(JSON.stringify({ candidates: [{ content: { parts: [] } }] })),
      stream: false,
    });
    await assert.rejects(
      () =>
        empty.generateText({
          systemPrompt: "s",
          conversation: [{ role: "user", content: "q" }],
        }),
      /without text output/,
    );

    const malformed = new GeminiProvider({
      fetchImplementation: async () => jsonResponse(JSON.stringify({ unexpected: true })),
      stream: false,
    });
    await assert.rejects(
      () =>
        malformed.generateText({
          systemPrompt: "s",
          conversation: [{ role: "user", content: "q" }],
        }),
      /unsupported response structure/,
    );
  }));

test("Gemini redacts its API key from error details", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const provider = new GeminiProvider({
      fetchImplementation: async () =>
        jsonResponse(
          JSON.stringify({
            error: {
              message: `API key not valid: ${GEMINI_KEY}`,
              status: "INVALID_ARGUMENT",
            },
          }),
          400,
        ),
      stream: false,
    });

    await assert.rejects(
      () =>
        provider.generateText({
          systemPrompt: "s",
          conversation: [{ role: "user", content: "q" }],
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /\[REDACTED\]/);
        assert.doesNotMatch(message, new RegExp(GEMINI_KEY));
        assert.match(message, /HTTP 400/);
        return true;
      },
    );
  }));

test("Gemini classifies credential and rate-limit failures", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
    const denied = new GeminiProvider({
      fetchImplementation: async () => jsonResponse("{}", 403),
      stream: false,
    });
    await assert.rejects(
      () =>
        denied.generateText({
          systemPrompt: "s",
          conversation: [{ role: "user", content: "q" }],
        }),
      /HTTP 403/,
    );

    const limited = new GeminiProvider({
      fetchImplementation: async () => jsonResponse("{}", 429),
      stream: false,
    });
    await assert.rejects(
      () =>
        limited.generateText({
          systemPrompt: "s",
          conversation: [{ role: "user", content: "q" }],
        }),
      /HTTP 429/,
    );
  }));

test("Gemini requires its own key and refuses an empty conversation", async () =>
  withEnvironment({ GEMINI_API_KEY: undefined }, async () => {
    assert.throws(() => new GeminiProvider(), /Missing GEMINI_API_KEY/);
  }));

  test("Gemini refuses an empty conversation", async () =>
    withEnvironment({ GEMINI_API_KEY: GEMINI_KEY }, async () => {
      const provider = new GeminiProvider({
        fetchImplementation: async () => jsonResponse("{}"),
      });
      await assert.rejects(
        () => provider.generateText({ systemPrompt: "s", conversation: [] }),
        /at least one conversation message/,
      );
    }));

test("Gemini defaults to gemini-2.5-flash and honors GEMINI_MODEL", async () =>
  withEnvironment({ GEMINI_API_KEY: GEMINI_KEY, GEMINI_MODEL: undefined }, () => {
    assert.equal(new GeminiProvider().model, "gemini-2.5-flash");
    assert.equal(new GeminiProvider({ model: "gemini-2.5-pro" }).model, "gemini-2.5-pro");
  }));
