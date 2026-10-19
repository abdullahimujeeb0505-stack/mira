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

test("task-aware selection defaults both tasks to Groq with Gemini runtime fallback", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      const groq = fakeProvider("groq", "openai/gpt-oss-120b");
      const gemini = fakeProvider("gemini", "gemini-3.5-flash");
      const providers = createTaskAwareProviders({
        factories: {
          groq: () => groq,
          gemini: () => gemini,
        },
      });

      assert.equal(providers.chat.primaryProvider, groq);
      assert.equal(providers.chat.provider.providerName, "groq");
      assert.equal(providers.chat.requested, "groq");
      assert.equal(providers.chat.fallbackProvider, gemini);
      assert.equal(providers.research.primaryProvider, groq);
      assert.equal(providers.research.provider.providerName, "groq");
      assert.equal(providers.research.requested, "groq");
      assert.equal(providers.research.fallbackProvider, gemini);
      assert.ok(
        formatTaskProviderDiagnostics(providers).some((line) =>
          line.includes(
            "Muse research LLM fallback: gemini (model: gemini-3.5-flash)",
          ),
        ),
      );
    },
  ));

test("keeps Groq primary when Gemini fallback credentials are missing", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
      MUSE_LLM_PROVIDER: undefined,
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

      assert.equal(providers.chat.provider, groq);
      assert.match(
        providers.chat.fallbackUnavailableReason ?? "",
        /auth error/,
      );
      assert.ok(
        formatTaskProviderDiagnostics(providers).some((line) =>
          line.includes("Muse chat LLM fallback unavailable: auth error"),
        ),
      );
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

      assert.equal(providers.chat.primaryProvider, chat);
      assert.equal(providers.chat.provider.providerName, "gemini");
      assert.equal(providers.chat.fallbackProvider, research);
      assert.equal(providers.research.primaryProvider, research);
      assert.equal(providers.research.provider.providerName, "groq");
      assert.equal(providers.research.fallbackProvider, chat);
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
      const groq = fakeProvider("groq");
      const providers = createTaskAwareProviders({
        factories: {
          gemini: () => gemini,
          groq: () => groq,
        },
      });

      assert.equal(providers.chat.primaryProvider, gemini);
      assert.equal(providers.chat.provider.providerName, "gemini");
      assert.equal(providers.chat.fallbackProvider, groq);
      assert.equal(providers.research.primaryProvider, gemini);
      assert.equal(providers.research.provider.providerName, "gemini");
      assert.equal(providers.research.fallbackProvider, groq);
    },
  ));

test("uses Groq at startup when an explicit Gemini primary has no credentials", async () =>
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
      assert.equal(providers.research.primaryProvider, groq);
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

test("retries a failed Groq request once through the Gemini fallback", async () => {
  const calls: string[] = [];
  const groq = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    calls.push("groq");
    throw new Error("Groq request failed with HTTP 503.");
  });
  const gemini = fakeProvider("gemini", "gemini-3.5-flash", async () => {
    calls.push("gemini");
    return "recovered through Gemini";
  });
  const providers = createTaskAwareProviders({
    chatProvider: "groq",
    researchProvider: "groq",
    factories: {
      groq: () => groq,
      gemini: () => gemini,
    },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const reply = await providers.chat.provider.generateText({
      systemPrompt: "Be concise.",
      conversation: [{ role: "user", content: "Hello." }],
    });
    assert.equal(reply, "recovered through Gemini");
    assert.deepEqual(calls, ["groq", "gemini"]);
  } finally {
    console.warn = originalWarn;
  }
});

test("does not send provider safety refusals to the fallback", async () => {
  let fallbackCalls = 0;
  const groq = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    throw new Error("Provider safety block: request blocked.");
  });
  const gemini = fakeProvider("gemini", "gemini-3.5-flash", async () => {
    fallbackCalls += 1;
    return "should not run";
  });
  const providers = createTaskAwareProviders({
    chatProvider: "groq",
    researchProvider: "groq",
    factories: {
      groq: () => groq,
      gemini: () => gemini,
    },
  });

  await assert.rejects(
    providers.chat.provider.generateText({
      systemPrompt: "Be concise.",
      conversation: [{ role: "user", content: "Hello." }],
    }),
    /safety block/i,
  );
  assert.equal(fallbackCalls, 0);
});

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

test("does not silently replace an unsupported task provider with Groq", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "unsupported-provider",
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      assert.throws(
        () =>
          createTaskAwareProviders({
            factories: { groq: () => fakeProvider("groq") },
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
