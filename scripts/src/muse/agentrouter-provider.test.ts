import assert from "node:assert/strict";
import test from "node:test";
import { AgentRouterProvider } from "./agentrouter-provider.js";
import type { TextGenerationProvider } from "./llm-provider.js";
import { createTextGenerationProvider } from "./provider-selection.js";

const testApiKey = "unit-test-agentrouter-key";

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("AgentRouter sends a Responses API request and returns its text", async () =>
  withEnvironment(
    {
      AGENTROUTER_API_KEY: testApiKey,
      AGENTROUTER_MODEL: "gpt-6-astra",
    },
    async () => {
      let requestedUrl: string | URL | Request | undefined;
      let requestedInit: RequestInit | undefined;
      const provider = new AgentRouterProvider({
        fetchImplementation: async (url, init) => {
          requestedUrl = url;
          requestedInit = init;
          return jsonResponse({ output_text: "Hello from AgentRouter" });
        },
      });

      const response = await provider.generateText({
        systemPrompt: "You are Muse.",
        conversation: [{ role: "user", content: "Hi" }],
      });

      assert.equal(response, "Hello from AgentRouter");
      assert.equal(
        requestedUrl,
        "https://agentrouter.org/v1/responses",
      );
      assert.equal(requestedInit?.method, "POST");
      const headers = new Headers(requestedInit?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${testApiKey}`);
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
        model: "gpt-6-astra",
        input: [
          { role: "system", content: "You are Muse." },
          { role: "user", content: "Hi" },
        ],
      });
    },
  ));

test("AgentRouter combines multiple nested text blocks", async () =>
  withEnvironment({ AGENTROUTER_API_KEY: testApiKey }, async () => {
    const provider = new AgentRouterProvider({
      fetchImplementation: async () =>
        jsonResponse({
          output_text: "",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Hello " },
                { type: "text", text: "from " },
                { type: "output_text", text: "AgentRouter" },
              ],
            },
          ],
        }),
    });

    const response = await provider.generateText({
      systemPrompt: "You are Muse.",
      conversation: [{ role: "user", content: "Hi" }],
    });

    assert.equal(response, "Hello from AgentRouter");
  }));

test("AgentRouter reports a valid empty response", async () =>
  withEnvironment({ AGENTROUTER_API_KEY: testApiKey }, async () => {
    const provider = new AgentRouterProvider({
      fetchImplementation: async () => jsonResponse({ output: [] }),
    });

    await assert.rejects(
      provider.generateText({
        systemPrompt: "You are Muse.",
        conversation: [{ role: "user", content: "Hi" }],
      }),
      /without text output/,
    );
  }));

test("AgentRouter reports an unsupported response structure", async () =>
  withEnvironment({ AGENTROUTER_API_KEY: testApiKey }, async () => {
    const provider = new AgentRouterProvider({
      fetchImplementation: async () =>
        jsonResponse({ result: { text: "Unexpected shape" } }),
    });

    await assert.rejects(
      provider.generateText({
        systemPrompt: "You are Muse.",
        conversation: [{ role: "user", content: "Hi" }],
      }),
      /unsupported response structure/,
    );
  }));

test("AgentRouter reports API errors without exposing the API key", async () =>
  withEnvironment({ AGENTROUTER_API_KEY: testApiKey }, async () => {
    const provider = new AgentRouterProvider({
      fetchImplementation: async () =>
        jsonResponse(
          { error: { message: `Rejected key ${testApiKey}` } },
          401,
        ),
    });

    await assert.rejects(
      provider.generateText({
        systemPrompt: "You are Muse.",
        conversation: [{ role: "user", content: "Hi" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 401/);
        assert.match(error.message, /\[REDACTED\]/);
        assert.equal(error.message.includes(testApiKey), false);
        return true;
      },
    );
  }));

test("AgentRouter requires AGENTROUTER_API_KEY", async () =>
  withEnvironment({ AGENTROUTER_API_KEY: undefined }, () => {
    assert.throws(
      () => new AgentRouterProvider(),
      /Missing AGENTROUTER_API_KEY/,
    );
  }));

test("provider selection defaults to Groq and accepts AgentRouter", async () =>
  withEnvironment({ MUSE_LLM_PROVIDER: undefined }, () => {
    const groqProvider: TextGenerationProvider = {
      generateText: async () => "groq",
    };
    const agentRouterProvider: TextGenerationProvider = {
      generateText: async () => "agentrouter",
    };

    assert.equal(
      createTextGenerationProvider({
        factories: { groq: () => groqProvider },
      }),
      groqProvider,
    );
    assert.equal(
      createTextGenerationProvider({
        provider: "agentrouter",
        factories: { agentrouter: () => agentRouterProvider },
      }),
      agentRouterProvider,
    );
  }));

test("provider selection reads MUSE_LLM_PROVIDER and rejects unknown values", async () =>
  withEnvironment({ MUSE_LLM_PROVIDER: "agentrouter" }, () => {
    const provider: TextGenerationProvider = {
      generateText: async () => "agentrouter",
    };
    assert.equal(
      createTextGenerationProvider({
        factories: { agentrouter: () => provider },
      }),
      provider,
    );
    assert.throws(
      () => createTextGenerationProvider({ provider: "unknown" }),
      /Choose "groq", "openrouter", "agentrouter", or "gemini"/,
    );
  }));
