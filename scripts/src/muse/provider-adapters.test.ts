import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GroqProvider } from "./groq-provider.js";
import { MuseAgent } from "./muse-agent.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import {
  createTextGenerationProvider,
  formatProviderDiagnostic,
} from "./provider-selection.js";
import { runResearch } from "./research-cli.js";
import { JsonMemoryRepository } from "./memory/json-memory-repository.js";
import { MemoryService } from "./memory/memory-service.js";

const GROQ_KEY = "groq-unit-test-key";
const OPENROUTER_KEY = "openrouter-unit-test-key";

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

function chatResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function request(
  fetchImplementation: typeof fetch,
  model?: string,
  timeoutMs = 60_000,
): { groq: GroqProvider; openrouter: OpenRouterProvider } {
  return {
    groq: new GroqProvider({
      ...(model ? { model } : {}),
      fetchImplementation,
      timeoutMs,
    }),
    openrouter: new OpenRouterProvider({
      model: model ?? "test/research-model",
      fetchImplementation,
      timeoutMs,
    }),
  };
}

test("Groq builds its OpenAI-compatible request and parses chat completion text", async () =>
  withEnvironment(
    {
      GROQ_API_KEY: GROQ_KEY,
      GROK_API_CODING_KEY: "legacy-should-not-win",
      GROQ_MODEL: "groq/research-model",
    },
    async () => {
      let url: string | URL | Request | undefined;
      let init: RequestInit | undefined;
      const provider = new GroqProvider({
        fetchImplementation: async (requestedUrl, requestedInit) => {
          url = requestedUrl;
          init = requestedInit;
          return chatResponse("Groq answer");
        },
      });

      assert.equal(provider.providerName, "groq");
      assert.equal(provider.model, "groq/research-model");
      assert.equal(
        await provider.generateText({
          systemPrompt: "system",
          conversation: [
            { role: "user", content: "question" },
            { role: "assistant", content: "context" },
          ],
        }),
        "Groq answer",
      );
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${GROQ_KEY}`);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "groq/research-model",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "question" },
          { role: "assistant", content: "context" },
        ],
      });
    },
  ));

test("Groq defaults to a recommended model instead of the deprecated Llama model", async () =>
  withEnvironment(
    { GROQ_API_KEY: undefined, GROK_API_CODING_KEY: GROQ_KEY, GROQ_MODEL: undefined },
    async () => {
      let body: Record<string, unknown> | undefined;
      const provider = new GroqProvider({
        fetchImplementation: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (body.model === "llama-3.3-70b-versatile") {
            return new Response(JSON.stringify({ error: "model unavailable" }), {
              status: 404,
            });
          }
          return chatResponse("legacy key accepted");
        },
      });
      assert.equal(provider.model, "openai/gpt-oss-120b");
      assert.equal(
        await provider.generateText({ systemPrompt: "", conversation: [] }),
        "legacy key accepted",
      );
      assert.equal(body?.model, "openai/gpt-oss-120b");
    },
  ));

test("OpenRouter builds an independent request against its documented endpoint", async () =>
  withEnvironment(
    {
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      OPENROUTER_MODEL: "publisher/model",
      GROQ_API_KEY: GROQ_KEY,
    },
    async () => {
      let url: string | URL | Request | undefined;
      let init: RequestInit | undefined;
      const provider = new OpenRouterProvider({
        fetchImplementation: async (requestedUrl, requestedInit) => {
          url = requestedUrl;
          init = requestedInit;
          return chatResponse("OpenRouter answer");
        },
      });

      assert.equal(provider.providerName, "openrouter");
      assert.equal(provider.model, "publisher/model");
      assert.equal(
        await provider.generateText({
          systemPrompt: "system",
          conversation: [{ role: "user", content: "question" }],
        }),
        "OpenRouter answer",
      );
      assert.equal(
        url,
        "https://openrouter.ai/api/v1/chat/completions",
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${OPENROUTER_KEY}`,
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "publisher/model",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "question" },
        ],
      });
    },
  ));

test("provider diagnostics report only the selected provider and model", async () =>
  withEnvironment(
    {
      GROQ_API_KEY: GROQ_KEY,
      GROQ_MODEL: "llama-3.3-70b-versatile",
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      OPENROUTER_MODEL: "publisher/model",
      AGENTROUTER_API_KEY: "agentrouter-unit-test-key",
      AGENTROUTER_MODEL: "gpt-6-astra",
      MUSE_LLM_PROVIDER: "groq",
    },
    () => {
      const groqDiagnostic = formatProviderDiagnostic(
        createTextGenerationProvider(),
      );
      assert.equal(
        groqDiagnostic,
        "Muse LLM provider: groq (model: llama-3.3-70b-versatile).",
      );
      assert.doesNotMatch(
        groqDiagnostic,
        /groq-unit-test-key|openrouter-unit-test-key|agentrouter-unit-test-key/,
      );

      process.env.MUSE_LLM_PROVIDER = "openrouter";
      const openRouterDiagnostic = formatProviderDiagnostic(
        createTextGenerationProvider(),
      );
      assert.equal(
        openRouterDiagnostic,
        "Muse LLM provider: openrouter (model: publisher/model).",
      );
      assert.doesNotMatch(
        openRouterDiagnostic,
        /groq-unit-test-key|openrouter-unit-test-key|agentrouter-unit-test-key/,
      );

      process.env.MUSE_LLM_PROVIDER = "agentrouter";
      const agentRouterDiagnostic = formatProviderDiagnostic(
        createTextGenerationProvider(),
      );
      assert.equal(
        agentRouterDiagnostic,
        "Muse LLM provider: agentrouter (model: gpt-6-astra).",
      );
      assert.doesNotMatch(
        agentRouterDiagnostic,
        /groq-unit-test-key|openrouter-unit-test-key|agentrouter-unit-test-key/,
      );
    },
  ));

test("selected providers require only their own credentials and OpenRouter model", async () =>
  withEnvironment(
    {
      MUSE_LLM_PROVIDER: "groq",
      GROQ_API_KEY: undefined,
      GROK_API_CODING_KEY: undefined,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      OPENROUTER_MODEL: "publisher/model",
      AGENTROUTER_API_KEY: undefined,
    },
    () => {
      assert.throws(
        () => createTextGenerationProvider(),
        /Missing GROQ_API_KEY.*GROK_API_CODING_KEY/,
      );

      process.env.MUSE_LLM_PROVIDER = "openrouter";
      assert.doesNotThrow(() => createTextGenerationProvider());
      delete process.env.OPENROUTER_MODEL;
      assert.throws(
        () => createTextGenerationProvider(),
        /Missing OPENROUTER_MODEL/,
      );

      process.env.MUSE_LLM_PROVIDER = "agentrouter";
      assert.throws(
        () => createTextGenerationProvider(),
        /Missing AGENTROUTER_API_KEY/,
      );
    },
  ));

test("OpenRouter never borrows Groq credentials when its own key is missing", async () =>
  withEnvironment(
    {
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_MODEL: "publisher/model",
      GROQ_API_KEY: GROQ_KEY,
      GROK_API_CODING_KEY: undefined,
    },
    () => {
      assert.throws(
        () => new OpenRouterProvider(),
        /Missing OPENROUTER_API_KEY/,
      );
    },
  ));

test("Groq uses its canonical credential before the legacy credential", async () =>
  withEnvironment(
    {
      GROQ_API_KEY: GROQ_KEY,
      GROK_API_CODING_KEY: "old-key",
      GROQ_MODEL: undefined,
    },
    async () => {
      let authorization = "";
      const provider = new GroqProvider({
        fetchImplementation: async (_url, init) => {
          authorization = new Headers(init?.headers).get("Authorization") ?? "";
          return chatResponse("ok");
        },
      });
      await provider.generateText({ systemPrompt: "", conversation: [] });
      assert.equal(authorization, `Bearer ${GROQ_KEY}`);
    },
  ));

test("provider HTTP errors identify authentication, rate limiting, and status without response data", async () =>
  withEnvironment(
    {
      GROQ_API_KEY: GROQ_KEY,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      OPENROUTER_MODEL: "publisher/model",
    },
    async () => {
      const statuses = [
        { status: 401, expected: /credentials.*401/ },
        { status: 429, expected: /rate limit.*429/ },
        { status: 503, expected: /HTTP 503/ },
      ];
      for (const { status, expected } of statuses) {
        const providers = request(async () =>
          new Response(JSON.stringify({ error: `private-key ${GROQ_KEY}` }), {
            status,
          }),
        );
        for (const provider of [providers.groq, providers.openrouter]) {
          await assert.rejects(
            provider.generateText({ systemPrompt: "", conversation: [] }),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.match(error.message, expected);
              assert.doesNotMatch(error.message, /private-key|unit-test-key/);
              return true;
            },
          );
        }
      }
    },
  ));

test("providers report timeouts, malformed responses, unsupported structures, and empty output", async () =>
  withEnvironment(
    {
      GROQ_API_KEY: GROQ_KEY,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      OPENROUTER_MODEL: "publisher/model",
    },
    async () => {
      for (const providerName of ["groq", "openrouter"] as const) {
        const timeoutProvider = request(async () => {
          throw new DOMException("timed out", "TimeoutError");
        }, undefined, 25)[providerName];
        await assert.rejects(
          timeoutProvider.generateText({ systemPrompt: "", conversation: [] }),
          /timed out after 25 ms/,
        );

        const malformedProvider = request(async () => new Response("{"), undefined)[providerName];
        await assert.rejects(
          malformedProvider.generateText({ systemPrompt: "", conversation: [] }),
          /malformed JSON/,
        );

        for (const [body, expected] of [
          [{ result: "wrong" }, /unsupported response structure/],
          [{ choices: [{ message: { content: "   " } }] }, /without text output/],
        ] as const) {
          const provider = request(
            async () => new Response(JSON.stringify(body), { status: 200 }),
          )[providerName];
          await assert.rejects(
            provider.generateText({ systemPrompt: "", conversation: [] }),
            expected,
          );
        }
      }
    },
  ));

test("each provider can power Muse research and a sourced writing assignment using mocked HTTP", async () => {
  for (const providerName of ["groq", "openrouter"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `muse-${providerName}-`));
    const requests: Array<Record<string, unknown>> = [];
    let modelCalls = 0;
    await withEnvironment(
      {
        GROQ_API_KEY: GROQ_KEY,
        OPENROUTER_API_KEY: OPENROUTER_KEY,
        OPENROUTER_MODEL: "publisher/model",
      },
      async () => {
        const fetchImplementation: typeof fetch = async (_url, init) => {
          modelCalls += 1;
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (modelCalls === 1) {
            return chatResponse(JSON.stringify({
              objective: "Explain TypeScript narrowing.",
              taskType: "general",
              deliverable: "A sourced explanation.",
              requiresCurrentInformation: false,
              sourcePreferences: ["official documentation"],
              questions: [],
              queries: ["TypeScript narrowing handbook"],
            }));
          }
          if (modelCalls === 2) {
            return chatResponse(JSON.stringify({
              answer: "The handbook explains control-flow narrowing [1].",
              unresolvedQuestions: [],
              contradictions: [],
              completeness: "supported",
            }));
          }
          return chatResponse(
            "# TypeScript Narrowing\n\nControl-flow analysis narrows union types [1].",
          );
        };
        const provider =
          providerName === "groq"
            ? new GroqProvider({ fetchImplementation })
            : new OpenRouterProvider({ fetchImplementation, model: "publisher/model" });
        const source = {
          title: "TypeScript Handbook: Narrowing",
          url: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
          retrievedAt: "2026-10-17T12:00:00.000Z",
          content: "TypeScript uses control flow analysis to narrow union types.",
        };
        const agent = new MuseAgent(
          provider,
          new MemoryService(
            new JsonMemoryRepository(join(directory, "memory.json")),
          ),
          undefined,
          (question, archivedContext) =>
            runResearch(question, [], {
              provider,
              archivedContext,
              config: {
                maxRounds: 1,
                maxSearches: 1,
                maxCandidates: 1,
                maxSources: 1,
              },
              search: async () => [{ title: source.title, url: source.url }],
              retrieve: async () => source,
              archive: async () => ({
                markdownPath: join(directory, "research.md"),
                jsonPath: join(directory, "research.json"),
              }),
              onProgress: () => {},
            }),
        );

        try {
          const article = await agent.respond(
            "Write a research-based article about TypeScript narrowing with citations.",
          );
          assert.match(article, /TypeScript Narrowing/);
          assert.match(article, /TypeScript Handbook: Narrowing/);
          assert.match(article, /https:\/\/www\.typescriptlang\.org\/docs\/handbook\/2\/narrowing\.html/);
          assert.equal(modelCalls, 3);
          assert.equal(requests.length, 3);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
});
