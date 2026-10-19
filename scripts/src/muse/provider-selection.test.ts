import assert from "node:assert/strict";
import test from "node:test";
import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import {
  classifyProviderFailure,
  createTaskAwareProviders,
  createTextGenerationProvider,
  formatTaskProviderDiagnostics,
  probeProviderConnection,
} from "./provider-selection.js";

function fakeProvider(
  name: string,
  model = `${name}-model`,
  onGenerate?: (request: TextGenerationRequest) => Promise<string>,
): TextGenerationProvider {
  return {
    providerName: name,
    model,
    generateText: (request) =>
      onGenerate ? onGenerate(request) : Promise.resolve("ok"),
  };
}

async function withEnvironment(
  env: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
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

test("task-aware selection defaults to Groq for chat and Gemini for research", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
    },
    () => {
      const chat = fakeProvider("groq");
      const research = fakeProvider("gemini");
      const providers = createTaskAwareProviders({
        factories: {
          groq: () => chat,
          gemini: () => research,
        },
      });

      assert.equal(providers.chat.provider, chat);
      assert.equal(providers.chat.requested, "groq");
      assert.equal(providers.research.provider, research);
      assert.equal(providers.research.requested, "gemini");
    },
  ));

test("MUSE_CHAT_LLM_PROVIDER and MUSE_RESEARCH_LLM_PROVIDER override the defaults", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "gemini",
      MUSE_RESEARCH_LLM_PROVIDER: "groq",
    },
    () => {
      const chat = fakeProvider("gemini");
      const research = fakeProvider("groq");
      const providers = createTaskAwareProviders({
        factories: {
          groq: () => research,
          gemini: () => chat,
        },
      });

      assert.equal(providers.chat.provider, chat);
      assert.equal(providers.research.provider, research);
    },
  ));

test("MUSE_LLM_PROVIDER pins both tasks to one provider", async () =>
  await withEnvironment(
    {
      MUSE_LLM_PROVIDER: "gemini",
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
    },
    () => {
      const gemini = fakeProvider("gemini");
      const providers = createTaskAwareProviders({
        factories: { gemini: () => gemini },
      });

      assert.equal(providers.chat.provider, gemini);
      assert.equal(providers.research.provider, gemini);
    },
  ));

test("research falls back to the chat provider with a recorded reason", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "groq",
      MUSE_RESEARCH_LLM_PROVIDER: "gemini",
    },
    () => {
      const groq = fakeProvider("groq");
      const providers = createTaskAwareProviders({
        factories: {
          groq: () => groq,
          gemini: () => {
            throw new Error("Missing GEMINI_API_KEY.");
          },
        },
      });

      assert.equal(providers.research.provider, groq);
      assert.equal(providers.research.requested, "gemini");
      assert.equal(providers.research.used, "groq");
      assert.match(providers.research.fallbackReason ?? "", /GEMINI_API_KEY/);

      const lines = formatTaskProviderDiagnostics(providers);
      assert.ok(
        lines.some((line) =>
          line.includes('Muse research LLM fell back from "gemini" to "groq"'),
        ),
      );
    },
  ));

test("selection fails loudly when neither provider is usable", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "groq",
      MUSE_RESEARCH_LLM_PROVIDER: "gemini",
    },
    () => {
      assert.throws(
        () =>
          createTaskAwareProviders({
            factories: {
              groq: () => {
                throw new Error("Missing GROQ_API_KEY.");
              },
              gemini: () => {
                throw new Error("Missing GEMINI_API_KEY.");
              },
            },
          }),
        /No usable LLM provider for chat tasks/,
      );
    },
  ));

test("single-provider selection keeps its Groq default and rejects unknown names", async () =>
  await withEnvironment({ MUSE_LLM_PROVIDER: undefined }, () => {
    const groq = fakeProvider("groq");
    assert.equal(
      createTextGenerationProvider({ factories: { groq: () => groq } }),
      groq,
    );
    assert.throws(
      () => createTextGenerationProvider({ provider: "unknown" }),
      /Unsupported MUSE_LLM_PROVIDER/,
    );
  }));

test("classifyProviderFailure names honest causes", () => {
  assert.match(
    classifyProviderFailure(new Error("Groq request failed (HTTP 401)")),
    /auth error/,
  );
  assert.match(
    classifyProviderFailure(new Error("429 too many requests")),
    /rate limited/,
  );
  assert.match(
    classifyProviderFailure(new Error("request timed out")),
    /timeout/,
  );
  assert.match(
    classifyProviderFailure(new Error("fetch failed: ENOTFOUND")),
    /network error/,
  );
  assert.match(
    classifyProviderFailure(new Error("SAFETY block reason")),
    /blocked by provider/,
  );
  assert.match(classifyProviderFailure(new Error("boom")), /provider error/);
});

test("probeProviderConnection reports success and classified failures without throwing", async () => {
  const ok = await probeProviderConnection(
    "chat",
    fakeProvider("groq", "openai/gpt-oss-120b"),
  );
  assert.match(ok, /LLM probe \(chat\): ok/);

  const failed = await probeProviderConnection(
    "research",
    fakeProvider("gemini", "gemini-3.5-flash", async () => {
      throw new Error("Missing GEMINI_API_KEY.");
    }),
  );
  assert.match(failed, /LLM probe \(research\) FAILED: auth error/);
  assert.match(failed, /gemini/);

  let notFound = "";
  await withEnvironment(
    { GEMINI_API_KEY: "diagnostic-test-secret" },
    async () => {
      notFound = await probeProviderConnection(
        "research",
        fakeProvider("gemini", "gemini-2.5-flash", async () => {
          throw new Error(
            "Gemini request failed with HTTP 404: models/gemini-2.5-flash is not found for API version v1beta; key=diagnostic-test-secret [NOT_FOUND]",
          );
        }),
      );
    },
  );
  assert.match(notFound, /HTTP 404/);
  assert.match(
    notFound,
    /provider detail: models\/gemini-2.5-flash is not found/,
  );
  assert.match(notFound, /\[REDACTED\]/);
  assert.match(notFound, /model: gemini-2.5-flash/);
  assert.doesNotMatch(
    notFound,
    /diagnostic-test-secret|check the API key and quota/,
  );
});
