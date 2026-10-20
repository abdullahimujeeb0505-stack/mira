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

test("task-aware selection defaults both tasks to Gemini Flash Lite with optional Groq failover", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      const gemini = fakeProvider("gemini", "gemini-3.5-flash-lite");
      const providers = createTaskAwareProviders({
        factories: { gemini: () => gemini },
      });

      assert.equal(providers.chat.primaryProvider, gemini);
      assert.equal(providers.chat.provider, gemini);
      assert.equal(providers.chat.requested, "gemini");
      assert.equal(providers.chat.fallbackProvider, undefined);
      assert.match(providers.chat.fallbackUnavailableReason ?? "", /auth error/);
      assert.equal(providers.research.primaryProvider, gemini);
      assert.equal(providers.research.provider, gemini);
      assert.equal(providers.research.requested, "gemini");
      assert.equal(providers.research.fallbackProvider, undefined);
      assert.match(providers.research.fallbackUnavailableReason ?? "", /auth error/);
      assert.ok(
        formatTaskProviderDiagnostics(providers).some((line) =>
          line.startsWith("Muse chat LLM: gemini (model: gemini-3.5-flash-lite)."),
        ),
      );
    },
  ));

test("task-specific providers can fall back to each other when they differ", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "groq",
      MUSE_RESEARCH_LLM_PROVIDER: "openrouter",
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      const groq = fakeProvider("groq");
      const openrouter = fakeProvider("openrouter");
      const providers = createTaskAwareProviders({
        factories: {
          groq: () => groq,
          openrouter: () => openrouter,
        },
      });

      assert.equal(providers.chat.primaryProvider, groq);
      assert.equal(providers.chat.fallbackProvider, openrouter);
      assert.equal(providers.research.primaryProvider, openrouter);
      assert.equal(providers.research.fallbackProvider, groq);
    },
  ));

test("Gemini primaries use Groq as their alternate when no task-specific alternate exists", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "gemini",
      MUSE_RESEARCH_LLM_PROVIDER: "gemini",
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      const gemini = fakeProvider("gemini", "gemini-3.5-flash-lite");
      const groq = fakeProvider("groq", "openai/gpt-oss-120b");
      const providers = createTaskAwareProviders({
        factories: {
          gemini: () => gemini,
          groq: () => groq,
        },
      });

      assert.equal(providers.chat.primaryProvider, gemini);
      assert.equal(providers.chat.fallbackProvider, groq);
      assert.equal(providers.research.primaryProvider, gemini);
      assert.equal(providers.research.fallbackProvider, groq);
    },
  ));

test("MUSE_LLM_PROVIDER pins both tasks to one provider", async () =>
  await withEnvironment(
    {
      MUSE_LLM_PROVIDER: "openrouter",
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
    },
    () => {
      const openrouter = fakeProvider("openrouter");
      const groq = fakeProvider("groq");
      const providers = createTaskAwareProviders({
        factories: {
          openrouter: () => openrouter,
          groq: () => groq,
        },
      });

      assert.equal(providers.chat.primaryProvider, openrouter);
      assert.equal(providers.chat.fallbackProvider, groq);
      assert.equal(providers.research.primaryProvider, openrouter);
      assert.equal(providers.research.fallbackProvider, groq);
    },
  ));

test("falls back to Groq at startup when the default Gemini key is missing", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: undefined,
      MUSE_RESEARCH_LLM_PROVIDER: undefined,
      MUSE_LLM_PROVIDER: undefined,
      GEMINI_API_KEY: undefined,
    },
    () => {
      const groq = fakeProvider("groq", "openai/gpt-oss-120b");
      const providers = createTaskAwareProviders({
        factories: {
          gemini: () => {
            throw new Error("Missing GEMINI_API_KEY.");
          },
          groq: () => groq,
        },
      });

      assert.equal(providers.chat.provider, groq);
      assert.equal(providers.chat.primaryProvider, groq);
      assert.equal(providers.chat.requested, "gemini");
      assert.equal(providers.chat.used, "groq");
      assert.match(providers.chat.fallbackReason ?? "", /GEMINI_API_KEY/);
    },
  ));

test("falls back to Groq at startup when an OpenRouter primary cannot be constructed", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "openrouter",
      MUSE_RESEARCH_LLM_PROVIDER: "openrouter",
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      const groq = fakeProvider("groq");
      const providers = createTaskAwareProviders({
        factories: {
          groq: () => groq,
          openrouter: () => {
            throw new Error("Missing OPENROUTER_MODEL.");
          },
        },
      });

      assert.equal(providers.chat.provider, groq);
      assert.equal(providers.chat.primaryProvider, groq);
      assert.equal(providers.chat.requested, "openrouter");
      assert.equal(providers.chat.used, "groq");
      assert.match(providers.chat.fallbackReason ?? "", /OPENROUTER_MODEL/);
    },
  ));

test("a failed Groq request is not retried through an unconfigured provider", async () => {
  const calls: string[] = [];
  const groq = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    calls.push("groq");
    throw new Error("Groq request failed with HTTP 503.");
  });
  const providers = createTaskAwareProviders({
    chatProvider: "groq",
    researchProvider: "groq",
    factories: { groq: () => groq },
  });

  await assert.rejects(
    providers.chat.provider.generateText({
      systemPrompt: "Be concise.",
      conversation: [{ role: "user", content: "Hello." }],
    }),
    /Groq request failed with HTTP 503/,
  );
  assert.deepEqual(calls, ["groq"]);
});

test("retries a Groq failure through a separately configured task provider", async () => {
  const calls: string[] = [];
  const groq = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    calls.push("groq");
    throw new Error("Groq request failed with HTTP 503.");
  });
  const openrouter = fakeProvider("openrouter", "test-model", async () => {
    calls.push("openrouter");
    return "recovered through OpenRouter";
  });
  const providers = createTaskAwareProviders({
    chatProvider: "groq",
    researchProvider: "openrouter",
    factories: {
      groq: () => groq,
      openrouter: () => openrouter,
    },
  });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const reply = await providers.chat.provider.generateText({
      systemPrompt: "Be concise.",
      conversation: [{ role: "user", content: "Hello." }],
    });
    assert.equal(reply, "recovered through OpenRouter");
    assert.deepEqual(calls, ["groq", "openrouter"]);
  } finally {
    console.warn = originalWarn;
  }
});

test("does not send Gemini policy-filtered responses to a configured alternate", async () => {
  let fallbackCalls = 0;
  const gemini = fakeProvider("gemini", "gemini-3.5-flash-lite", async () => {
    throw new Error("Gemini blocked the request because of SAFETY.");
  });
  const groq = fakeProvider("groq", "openai/gpt-oss-120b", async () => {
    fallbackCalls += 1;
    return "should not run";
  });
  const providers = createTaskAwareProviders({
    chatProvider: "gemini",
    researchProvider: "groq",
    factories: {
      gemini: () => gemini,
      groq: () => groq,
    },
  });

  await assert.rejects(
    providers.chat.provider.generateText({
      systemPrompt: "Be concise.",
      conversation: [{ role: "user", content: "Hello." }],
    }),
    /blocked the request.*SAFETY/i,
  );
  assert.equal(fallbackCalls, 0);
});

test("selection fails loudly when no configured provider can be constructed", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "groq",
      MUSE_RESEARCH_LLM_PROVIDER: "groq",
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      assert.throws(
        () =>
          createTaskAwareProviders({
            factories: {
              groq: () => {
                throw new Error("Missing GROQ_API_KEY.");
              },
            },
          }),
        /No usable LLM provider for chat tasks/,
      );
    },
  ));

test("Gemini is supported as the selected and default task provider", async () =>
  await withEnvironment(
    {
      MUSE_CHAT_LLM_PROVIDER: "gemini",
      MUSE_RESEARCH_LLM_PROVIDER: "gemini",
      MUSE_LLM_PROVIDER: undefined,
    },
    () => {
      const gemini = fakeProvider("gemini", "gemini-3.5-flash-lite");
      const providers = createTaskAwareProviders({
        factories: { gemini: () => gemini },
      });
      assert.equal(providers.chat.primaryProvider, gemini);
      assert.equal(providers.research.primaryProvider, gemini);
      assert.equal(
        createTextGenerationProvider({
          provider: "gemini",
          factories: { gemini: () => gemini },
        }),
        gemini,
      );
      assert.throws(
        () => createTextGenerationProvider({ provider: "unknown" }),
        /Choose "gemini", "groq", "openrouter", or "agentrouter"/,
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

test("single-provider selection defaults to Gemini and rejects unknown names", async () =>
  await withEnvironment({ MUSE_LLM_PROVIDER: undefined }, () => {
    const gemini = fakeProvider("gemini", "gemini-3.5-flash-lite");
    assert.equal(
      createTextGenerationProvider({ factories: { gemini: () => gemini } }),
      gemini,
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

test("probeProviderConnection reports classified failures without exposing credentials", async () => {
  const ok = await probeProviderConnection(
    "chat",
    fakeProvider("groq", "openai/gpt-oss-120b"),
  );
  assert.match(ok, /LLM probe \(chat\): ok/);

  let failed = "";
  await withEnvironment({ GROQ_API_KEY: "diagnostic-test-secret" }, async () => {
    failed = await probeProviderConnection(
      "research",
      fakeProvider("groq", "openai/gpt-oss-120b", async () => {
        throw new Error(
          "Groq request failed with HTTP 404: model not found; key=diagnostic-test-secret",
        );
      }),
    );
  });
  assert.match(failed, /LLM probe \(research\) FAILED: the provider rejected the request \(HTTP 404\)/);
  assert.match(failed, /provider detail: model not found/);
  assert.match(failed, /\[REDACTED\]/);
  assert.doesNotMatch(failed, /diagnostic-test-secret/);

  const geminiSecret = "gemini-diagnostic-secret";
  let geminiFailed = "";
  await withEnvironment({ GEMINI_API_KEY: geminiSecret }, async () => {
    geminiFailed = await probeProviderConnection(
      "chat",
      fakeProvider("gemini", "gemini-3.5-flash-lite", async () => {
        throw new Error(
          `Gemini request failed with HTTP 404: invalid model; key=${geminiSecret}`,
        );
      }),
    );
  });
  assert.match(geminiFailed, /provider detail: invalid model/);
  assert.match(geminiFailed, /\[REDACTED\]/);
  assert.doesNotMatch(geminiFailed, /gemini-diagnostic-secret/);
});
