import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  TextGenerationProvider,
  TextGenerationRequest,
} from "./llm-provider.js";
import { formatResearchReply, MuseAgent } from "./muse-agent.js";
import type { ResearchResult } from "./research-cli.js";
import type { ResearchImage } from "./research-images.js";
import { JsonMemoryRepository } from "./memory/json-memory-repository.js";
import { MemoryService } from "./memory/memory-service.js";

const researchResult: ResearchResult = {
  question: "How does this work?",
  plan: {
    objective: "Explain the topic.",
    taskType: "general",
    deliverable: "A concise answer.",
    requiresCurrentInformation: false,
    sourcePreferences: [],
    questions: [],
    queries: [],
    unresolvedQuestions: [],
  },
  answer: "The sources describe the mechanism. [1]",
  sources: [{
    title: "Official guide",
    url: "https://example.org/guide",
    retrievedAt: "2026-10-17T12:00:00.000Z",
    content:
      "TypeScript narrowing improves safe handling of union values. Control flow analysis narrows union types.",
  }],
  unresolvedQuestions: [],
  contradictions: [],
  completeness: "supported",
  limitations: [],
  archive: { markdownPath: "/archive/result.md", jsonPath: "/archive/result.json" },
  retrieval: {
    candidateCount: 3,
    retrievedCount: 1,
    failedCount: 2,
    rounds: 2,
    searches: 4,
  },
};

test("Muse identifies itself as a research agent without delegating identity to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-identity-"));
  let modelCalls = 0;
  let researchCalls = 0;
  const agent = new MuseAgent(
    {
      async generateText() {
        modelCalls += 1;
        return "I am ChatGPT.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async () => {
      researchCalls += 1;
      return researchResult;
    },
  );

  try {
    await agent.respond("Hey");
    const modelCallsAfterGreeting = modelCalls;
    for (const question of [
      "What are you?",
      "What are you man?",
      "Who are you and whats your purpose?",
      "What's your purpose, and who are you?",
      "Tell me about yourself.",
      "What are your capabilities",
      "Are you sure you are a research agent?",
      "No, I'm asking you that: are you sure you are a research agent?",
      "How can you help me?",
    ]) {
      const answer = await agent.respond(question);
      assert.match(answer, /I'm Muse, a conversational research agent/);
      assert.match(answer, /My purpose is to help you understand topics/);
      assert.doesNotMatch(answer, /ChatGPT|OpenAI/);
    }
    const creatorAnswer = await agent.respond("Who created you, my guy?");
    assert.match(creatorAnswer, /I don't have a verified creator credit/);
    assert.doesNotMatch(creatorAnswer, /ChatGPT|OpenAI/);
    assert.equal(modelCalls, modelCallsAfterGreeting);
    assert.equal(researchCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse handles casual messages without web research and researches factual questions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-test-"));
  let modelCalls = 0;
  const researchQuestions: string[] = [];
  const agent = new MuseAgent(
    {
      async generateText() {
        modelCalls += 1;
        return "Hello!";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchQuestions.push(question);
      return {
        ...researchResult,
        followUpQuestions: ["how the process works", "its main types"],
      };
    },
  );

  try {
    assert.equal(await agent.respond("Hi Muse"), "Hello!");
    assert.equal(modelCalls, 1);
    assert.equal(researchQuestions.length, 0);

    assert.equal(await agent.respond("Are you okay?"), "Hello!");
    assert.equal(modelCalls, 2);
    assert.equal(researchQuestions.length, 0);

    const answer = await agent.respond("How does this work?");
    assert.match(answer, /Would you like to explore how the process works or its main types next\?/);
    assert.doesNotMatch(answer, /\[1\]|\[SRC-|Sources:|example\.org\/guide/);
    assert.doesNotMatch(answer, /candidate pages|Research completeness|Limitations:/);
    assert.equal(researchQuestions[0], "How does this work?");
    assert.equal(modelCalls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse can use emoji when requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-emoji-"));
  let systemPrompt = "";
  const agent = new MuseAgent(
    {
      async generateText(request) {
        systemPrompt = request.systemPrompt;
        return "Sure 🚀!";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
  );

  try {
    assert.equal(await agent.respond("Use emojis in your reply."), "Sure 🚀!");
    assert.match(systemPrompt, /unless the user explicitly asks for them/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research follow-ups use prior conversation without repeating research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-followup-"));
  const questions: string[] = [];
  const modelRequests: TextGenerationRequest[] = [];
  const agent = new MuseAgent(
    {
      generateText: async (request) => {
        modelRequests.push(request);
        return "The earlier evidence supports that because of the documented mechanism.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      questions.push(question);
      return researchResult;
    },
  );

  try {
    await agent.respond("How does this work?");
    const followUp = await agent.respond("What does that mean in practice?");
    assert.match(followUp, /earlier evidence supports/);
    assert.equal(questions.length, 1);
    assert.match(modelRequests[0]?.systemPrompt ?? "", /Question: How does this work\?/);
    assert.match(modelRequests[0]?.systemPrompt ?? "", /Official guide/);
    assert.match(
      modelRequests[0]?.conversation.at(-1)?.content ?? "",
      /^What does that mean in practice\?$/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rewrite requests about the previous answer reuse prior research instead of searching its diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-rewrite-followup-"));
  const questions: string[] = [];
  const requests: TextGenerationRequest[] = [];
  const agent = new MuseAgent(
    {
      async generateText(request) {
        requests.push(request);
        return "TypeScript narrows values by analyzing control flow.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      questions.push(question);
      return { ...researchResult, question };
    },
  );
  const rewrite = "Rewrite your answer as a simple explanation for a beginner. Keep the important facts, remove unnecessary research diagnostics, and retain appropriate citations.";

  try {
    await agent.respond("Research how TypeScript narrowing works?");
    assert.match(await agent.respond(rewrite), /TypeScript narrows values/);

    assert.deepEqual(questions, ["Research how TypeScript narrowing works?"]);
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.systemPrompt ?? "", /Question: Research how TypeScript narrowing works\?/);
    assert.match(requests[0]?.systemPrompt ?? "", /Relevant previously retrieved evidence/);
    assert.equal(requests[0]?.conversation.at(-1)?.content, rewrite);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Are you sure and Confirm follow-ups reuse prior research instead of researching the phrase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-confirmation-"));
  const questions: string[] = [];
  const requests: TextGenerationRequest[] = [];
  const agent = new MuseAgent(
    {
      async generateText(request) {
        requests.push(request);
        return "Yes. The earlier source supports that claim.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      questions.push(question);
      return { ...researchResult, question };
    },
  );

  try {
    await agent.respond("What is photosynthesis?");
    assert.match(await agent.respond("Are you sure ?"), /earlier source supports/);
    assert.match(await agent.respond("Confirm?"), /earlier source supports/);

    assert.deepEqual(questions, ["What is photosynthesis?"]);
    assert.equal(requests.length, 2);
    assert.match(requests[0]?.systemPrompt ?? "", /Question: What is photosynthesis\?/);
    assert.match(requests[0]?.systemPrompt ?? "", /Relevant previously retrieved evidence/);
    assert.equal(requests[0]?.conversation.at(-1)?.content, "Are you sure ?");
    assert.equal(requests[1]?.conversation.at(-1)?.content, "Confirm?");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pronoun-based research follow-ups receive the previous topic and evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-pronoun-followup-"));
  const questions: string[] = [];
  const researchContexts: string[] = [];
  const agent = new MuseAgent(
    { generateText: async () => "unused" },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question, _archive, conversationContext) => {
      questions.push(question);
      researchContexts.push(conversationContext ?? "");
      return { ...researchResult, question };
    },
  );

  try {
    await agent.respond("What can you say about Elon Musk's flying cars?");
    await agent.respond("What's his net worth? Use recent sources and state the date.");

    assert.deepEqual(questions, [
      "What can you say about Elon Musk's flying cars?",
      "What's his net worth? Use recent sources and state the date.",
    ]);
    assert.match(researchContexts[1] ?? "", /Previous user-facing answer/);
    assert.match(researchContexts[1] ?? "", /Previous research question: What can you say about Elon Musk's flying cars\?/);
    assert.match(researchContexts[1] ?? "", /Previously retrieved evidence/);
    assert.match(researchContexts[1] ?? "", /Official guide/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research reply hides citations and sources unless requested", () => {
  const answer = formatResearchReply({
    ...researchResult,
    sources: [
      ...researchResult.sources,
      {
        title: "Uncited extra source",
        url: "https://example.net/unused",
        retrievedAt: "2026-10-17T12:00:00.000Z",
        content: "This retrieved source was not cited in the answer.",
      },
    ],
  }, true);

  assert.match(answer, /The sources describe the mechanism/);
  assert.doesNotMatch(answer, /\[1\]|\[SRC-|Sources:|example\.org\/guide/);
  assert.doesNotMatch(answer, /Official guide - https:\/\/example\.org\/guide/);
  assert.doesNotMatch(answer, /Uncited extra source|example\.net\/unused/);
  assert.doesNotMatch(
    answer,
    /candidate pages|Research completeness|Limitations:|Unresolved questions:|saved to Muse's local archive/,
  );
});

test("research replies show unnumbered source links when explicitly requested", () => {
  const answer = formatResearchReply({
    ...researchResult,
    question: "What sources support this explanation?",
    answer:
      "The handbook documents control flow narrowing [SRC-handbook123]. " +
      "Read more at https://www.typescriptlang.org/docs/handbook/2/narrowing.html.",
    sources: [{
      ...researchResult.sources[0]!,
      sourceId: "SRC-handbook123",
      title: "TypeScript Handbook: Narrowing",
      url: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
    }],
  });

  assert.match(answer, /control flow narrowing/);
  assert.match(answer, /\[TypeScript Handbook: Narrowing\]\(https:\/\/www\.typescriptlang\.org\/docs\/handbook\/2\/narrowing\.html\)/);
  assert.match(answer, /Sources:\n- \[TypeScript Handbook: Narrowing\]\(https:\/\/www\.typescriptlang\.org\/docs\/handbook\/2\/narrowing\.html\)/);
  assert.doesNotMatch(answer, /\[1\]|SRC-handbook123/);
});

test("research replies preserve emoji when they are requested", () => {
  const answer = formatResearchReply({
    ...researchResult,
    question: "Explain this with emojis.",
    answer: "The sources describe the mechanism 🚀. [1]",
  });

  assert.match(answer, /🚀/);
});

test("Muse adds attributed Commons images when requested to support research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-images-"));
  const imageRequests: string[] = [];
  const image: ResearchImage = {
    title: "Monarch butterfly",
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/1/1a/Monarch.jpg",
    pageUrl: "https://commons.wikimedia.org/wiki/File:Monarch.jpg",
    creator: "Photographer",
    license: "CC BY-SA 4.0",
  };
  const agent = new MuseAgent(
    { generateText: async () => "unused" },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => ({ ...researchResult, question }),
    async (request) => {
      imageRequests.push(request);
      return [image];
    },
  );

  try {
    const answer = await agent.respond(
      "Research monarch butterflies and show me pictures to support the research.",
    );
    assert.match(answer, /!\[Monarch butterfly\]\(https:\/\/upload\.wikimedia\.org/);
    assert.match(answer, /\[Monarch butterfly — Wikimedia Commons\]/);
    assert.match(answer, /Photographer; license: CC BY-SA 4\.0/);
    assert.deepEqual(imageRequests, [
      "Research monarch butterflies and show me pictures to support the research.",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research replies omit unsupported lines without displaying citations", () => {
  const answer = formatResearchReply({
    ...researchResult,
    answer:
      "Control flow analysis narrows union types [1].\n" +
      "Distant galaxies are classified by this handbook (unverified: no matching retrieved evidence).",
    completeness: "partial",
  });

  assert.match(answer, /Control flow analysis narrows union types/);
  assert.doesNotMatch(answer, /\[1\]|\[SRC-|Sources:|example\.org\/guide|Distant galaxies|unverified/);
});

test("research replies include raw source URLs only when requested", () => {
  const url = "https://www.typescriptlang.org/docs/handbook/2/narrowing.html";
  const answer = formatResearchReply({
    ...researchResult,
    question: "Please include the raw source URLs.",
    answer: "The handbook covers control flow [SRC-handbook123].",
    sources: [{
      ...researchResult.sources[0]!,
      sourceId: "SRC-handbook123",
      title: "TypeScript Handbook: Narrowing",
      url,
    }],
  });

  assert.match(answer, new RegExp(`\\[TypeScript Handbook: Narrowing\\]\\(${url}\\) - ${url}`));
});

test("a source request reuses the latest research without rerunning search", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-source-followup-"));
  const researchQuestions: string[] = [];
  const agent = new MuseAgent(
    { generateText: async () => "unused" },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchQuestions.push(question);
      return { ...researchResult, question };
    },
  );

  try {
    await agent.respond("What is photosynthesis?");
    const sources = await agent.respond("Show me the sources");

    assert.match(sources, /Sources:\n- \[Official guide\]/);
    assert.doesNotMatch(sources, /\[1\]|\[SRC-/);
    assert.deepEqual(researchQuestions, ["What is photosynthesis?"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-turn chat keeps roles and routes simple follow-ups separately from explicit research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-multiturn-"));
  const requests: TextGenerationRequest[] = [];
  const researchQuestions: string[] = [];
  const researchContexts: string[] = [];
  const agent = new MuseAgent(
    {
      generateText: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? "Hello!"
          : requests.length === 2
            ? "It was created to add static types to JavaScript."
            : "In simple terms, it helps catch mistakes before code runs.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question, _archive, context) => {
      researchQuestions.push(question);
      researchContexts.push(context ?? "");
      return { ...researchResult, question };
    },
  );

  try {
    assert.equal(await agent.respond("Hi Muse"), "Hello!");
    await agent.respond("What is TypeScript?");
    const why = await agent.respond("Why?");
    assert.match(why, /static types/);
    const simpler = await agent.respond("Explain that simply");
    assert.match(simpler, /simple terms/);
    await agent.respond("Search the web for TypeScript release history.");

    assert.deepEqual(researchQuestions, [
      "What is TypeScript?",
      "Search the web for TypeScript release history.",
    ]);
    assert.match(researchContexts[1] ?? "", /Previous user-facing answer/);
    assert.match(requests[1]?.systemPrompt ?? "", /Do not repeat or reproduce the previous report/);
    assert.deepEqual(
      requests[1]?.conversation.map(({ role }) => role),
      ["user", "assistant", "user"],
    );
    assert.match(requests[1]?.systemPrompt ?? "", /conversational research agent/);
    assert.match(requests[1]?.systemPrompt ?? "", /answer follow-ups directly/);
    assert.match(requests[1]?.systemPrompt ?? "", /never use tables/i);
    assert.match(requests[1]?.systemPrompt ?? "", /Question: What is TypeScript\?/);
    assert.doesNotMatch(requests[1]?.conversation.map(({ content }) => content).join("\n") ?? "", /Sources:\n/);
    assert.deepEqual(
      requests[2]?.conversation.slice(-2).map(({ role, content }) => [role, content]),
      [
        ["assistant", "It was created to add static types to JavaScript."],
        ["user", "Explain that simply"],
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse researches factual writing requests and preserves the assignment for revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-writing-"));
  const generated: string[] = [];
  const researchQuestions: string[] = [];
  const agent = new MuseAgent(
    {
      async generateText(request) {
        generated.push(request.systemPrompt);
        return generated.length === 1
          ? "## Thesis\nTypeScript narrowing improves safe handling of union values [1]."
          : "## Revised thesis\nNarrowing makes union handling safer [1].";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchQuestions.push(question);
      return researchResult;
    },
  );

  try {
    const article = await agent.respond(
      "Write a short technical article about TypeScript narrowing with sources.",
    );
    assert.match(article, /TypeScript narrowing improves safe handling/);
    assert.match(article, /Official guide/);
    assert.equal(researchQuestions.length, 1);

    const revision = await agent.respond("Make it shorter and more accessible.");
    assert.match(revision, /Revised thesis/);
    assert.equal(researchQuestions.length, 1);
    assert.match(generated[1] ?? "", /Revise the existing active writing assignment/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed synthesis stops article generation and gives one concise next step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-insufficient-research-"));
  let modelCalls = 0;
  let researchCalls = 0;
  const agent = new MuseAgent(
    {
      async generateText() {
        modelCalls += 1;
        return "This must not become an article.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchCalls += 1;
      return {
        ...researchResult,
        question,
        answer: "I retrieved 3 readable sources, but couldn't synthesize a reliable answer. Please try again shortly.",
        completeness: "partial",
      };
    },
  );

  try {
    const first = await agent.respond("How does TypeScript improve JavaScript?");
    const followUp = await agent.respond(
      "Turn those findings into a concise, publishable article.",
    );
    const expected =
      "I retrieved 3 readable sources, but couldn't synthesize a reliable answer. " +
      "Please try again shortly.";

    assert.equal(first, expected);
    assert.equal(followUp, expected);
    assert.equal(researchCalls, 1);
    assert.equal(modelCalls, 0);
    assert.doesNotMatch(followUp, /unverified|Sources:|Research completeness/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a draft with unsupported claims is withheld rather than returned as a full article", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-unsupported-draft-"));
  let modelCalls = 0;
  const agent = new MuseAgent(
    {
      async generateText() {
        modelCalls += 1;
        return [
          "# TypeScript",
          "TypeScript narrowing improves safe handling of union values [1].",
          "Ocean tides are caused by distant stars [1].",
        ].join("\n\n");
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => ({ ...researchResult, question }),
  );

  try {
    const response = await agent.respond(
      "Write a short sourced article about TypeScript narrowing.",
    );
    assert.equal(modelCalls, 1);
    assert.match(response, /couldn't verify enough relevant evidence/i);
    assert.doesNotMatch(response, /# TypeScript|ocean tides|unverified|\[1\]|Retrieved sources/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a brief history keeps validated research when an unrelated claim is unsupported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-partial-research-"));
  let researchCalls = 0;
  let generationCalls = 0;
  const source = {
    title: "Elon Musk biography",
    url: "https://example.org/elon-musk",
    retrievedAt: "2026-10-17T12:00:00.000Z",
    content:
      "Elon Musk was born in Pretoria, South Africa, and later co-founded SpaceX.",
  };
  const agent = new MuseAgent(
    {
      async generateText() {
        generationCalls += 1;
        return "Elon Musk was born in Pretoria, South Africa, and later co-founded SpaceX [1].";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchCalls += 1;
      return {
        ...researchResult,
        question,
        answer:
          "Musk was born in Pretoria and later co-founded SpaceX [1].\n" +
          "He held an unsupported role in 2001 (unverified: no matching retrieved evidence).",
        sources: [source],
        completeness: "partial",
      };
    },
  );

  try {
    const answer = await agent.respond("Give me a brief history of Elon Musk.");

    assert.match(answer, /born in Pretoria, South Africa/);
    assert.match(answer, /co-founded SpaceX/);
    assert.doesNotMatch(answer, /Elon Musk biography|example\.org\/elon-musk|\[1\]/);
    assert.doesNotMatch(answer, /unsupported role|unverified/);
    assert.equal(researchCalls, 1);
    assert.equal(generationCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writing requests still answer when no readable sources were retrieved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-search-failure-"));
  let modelCalls = 0;
  const failure =
    "I could not retrieve any readable web sources for this question, so I can't provide a source-grounded answer yet. " +
    "Search may be blocked or relevant pages may be inaccessible. Please try a narrower query or provide a source URL.";
  const agent = new MuseAgent(
    {
      async generateText() {
        modelCalls += 1;
        return "This should not be generated without evidence.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => ({
      ...researchResult,
      question,
      answer: failure,
      sources: [],
      completeness: "insufficient",
    }),
  );

  try {
    const answer = await agent.respond("Give me a brief history of Elon Musk.");
    assert.match(answer, /This should not be generated without evidence/);
    assert.match(answer, /not independently source-verified/);
    assert.equal(modelCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research-based writing falls back to general knowledge when retrieval has no sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-writing-fallback-"));
  const requests: TextGenerationRequest[] = [];
  let researchCalls = 0;
  const agent = new MuseAgent(
    {
      async generateText(request) {
        requests.push(request);
        return "# Photosynthesis\n\nPhotosynthesis is the process plants use to convert light into chemical energy.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchCalls += 1;
      return {
        ...researchResult,
        question,
        answer: "I could not retrieve readable sources.",
        sources: [],
        completeness: "insufficient",
      };
    },
  );

  try {
    const answer = await agent.respond("Write me an essay on photosynthesis.");

    assert.match(answer, /Photosynthesis is the process plants use/);
    assert.match(answer, /based on general knowledge and is not independently source-verified/);
    assert.match(requests[0]?.systemPrompt ?? "", /stable general knowledge/);
    assert.doesNotMatch(answer, /\[1\]|Sources:|example\.org/);
    assert.equal(researchCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse writes a concise note when research retrieves no usable sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-note-fallback-"));
  const requests: TextGenerationRequest[] = [];
  const agent = new MuseAgent(
    {
      async generateText(request) {
        requests.push(request);
        return "Photosynthesis is the process by which plants use light to make sugars from carbon dioxide and water.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => ({
      ...researchResult,
      question,
      answer: "I could not retrieve readable sources.",
      sources: [],
      completeness: "insufficient",
    }),
  );

  try {
    const answer = await agent.respond("Write me a note on photosynthesis.");

    assert.match(answer, /Photosynthesis is the process/);
    assert.match(answer, /not independently source-verified/);
    assert.match(requests[0]?.systemPrompt ?? "", /about 150 words for a note/);
    assert.equal(requests.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a writing follow-up reuses only its immediately relevant retrieved evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-writing-followup-"));
  const researchContexts: string[] = [];
  let researchCalls = 0;
  let modelCalls = 0;
  const agent = new MuseAgent(
    {
      async generateText() {
        modelCalls += 1;
        return "## Type narrowing\nControl flow analysis narrows union types [1].";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question, _archive, context) => {
      researchCalls += 1;
      researchContexts.push(context ?? "");
      return { ...researchResult, question };
    },
  );

  try {
    await agent.respond("How does TypeScript narrowing work?");
    const article = await agent.respond(
      "Turn those findings into a concise article about TypeScript narrowing.",
    );

    assert.match(article, /Control flow analysis narrows union types/);
    assert.equal(researchCalls, 1);
    assert.equal(modelCalls, 1);
    assert.equal(researchContexts[0], "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unrelated new research request does not receive stale research as context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-fresh-research-"));
  const researchContexts: string[] = [];
  const agent = new MuseAgent(
    { generateText: async () => "unused" },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question, _archive, context) => {
      researchContexts.push(context ?? "");
      return { ...researchResult, question };
    },
  );

  try {
    await agent.respond("How does TypeScript narrowing work?");
    await agent.respond("Search the web for current ocean tide predictions.");
    assert.equal(researchContexts.length, 2);
    assert.equal(researchContexts[1], "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a writing request cannot reuse research after an unrelated conversational turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-expired-research-"));
  const researchContexts: string[] = [];
  let researchCalls = 0;
  const agent = new MuseAgent(
    { generateText: async () => "A concise reply." },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question, _archive, context) => {
      researchCalls += 1;
      researchContexts.push(context ?? "");
      return { ...researchResult, question };
    },
  );

  try {
    await agent.respond("How does TypeScript narrowing work?");
    await agent.respond("I prefer concise wording.");
    await agent.respond("Turn those findings into a short article.");

    assert.equal(researchCalls, 2);
    assert.equal(researchContexts[1], "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse summarizes supplied text without invoking external research", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-supplied-text-"));
  const modelRequests: TextGenerationRequest[] = [];
  const researchQuestions: string[] = [];
  const agent = new MuseAgent(
    {
      async generateText(request) {
        modelRequests.push(request);
        return "Photosynthesis converts light energy into chemical energy.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchQuestions.push(question);
      return researchResult;
    },
  );

  try {
    const answer = await agent.respond(
      "Summarize the following text: Photosynthesis converts light energy into chemical energy.",
    );
    assert.match(answer, /Photosynthesis converts light energy/);
    assert.deepEqual(researchQuestions, []);
    assert.match(modelRequests[0]?.systemPrompt ?? "", /No external research was requested or retrieved/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse skips external research for a creative writing request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-creative-"));
  let researchCalls = 0;
  let writingPrompt = "";
  const agent = new MuseAgent(
    {
      generateText: async (request) => {
        writingPrompt = request.systemPrompt;
        return "A short article from the supplied notes.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async () => {
      researchCalls += 1;
      return researchResult;
    },
  );

  try {
    assert.equal(
      await agent.respond("Write a short article based on these notes about a lighthouse."),
      "A short article from the supplied notes.\n\nWould you like me to adjust the format, tone, or length?",
    );
    assert.equal(researchCalls, 0);
    assert.match(writingPrompt, /No external research was requested or retrieved/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Muse drafts a personal narrative without requiring web sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-personal-narrative-"));
  let researchCalls = 0;
  let writingPrompt = "";
  const agent = new MuseAgent(
    {
      generateText: async (request) => {
        writingPrompt = request.systemPrompt;
        return "Sample essay: The day I will never forget was the day I learned to be brave.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async () => {
      researchCalls += 1;
      return researchResult;
    },
  );

  try {
    const answer = await agent.respond(
      "Write essay on 'the day I will never forget'.",
    );
    assert.match(answer, /Sample essay/);
    assert.equal(researchCalls, 0);
    assert.match(writingPrompt, /No external research was requested or retrieved/);
    assert.match(writingPrompt, /illustrative sample they can personalize/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a message naming a website reaches research so the link can be read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-link-"));
  const researchQuestions: string[] = [];
  const agent = new MuseAgent(
    {
      async generateText() {
        return "A plain-chat reply.";
      },
    },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question) => {
      researchQuestions.push(question);
      return {
        ...researchResult,
        question,
        answer: "Photon is a framework connecting agents to messaging apps. [1]",
      };
    },
  );

  try {
    // The exact phrasings that previously fell through to plain chat.
    for (const message of [
      "look through photon.codes for me",
      "Look throught photon.codes up for me",
      "check out https://photon.codes/pricing",
    ]) {
      const answer = await agent.respond(message);
      assert.match(answer, /Photon is a framework/);
    }
    assert.equal(researchQuestions.length, 3);
    assert.equal(researchQuestions[0], "look through photon.codes for me");
    assert.equal(researchQuestions[2], "check out https://photon.codes/pricing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
