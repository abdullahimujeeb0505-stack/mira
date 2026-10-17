import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TextGenerationProvider } from "./llm-provider.js";
import { formatResearchReply, MuseAgent } from "./muse-agent.js";
import type { ResearchResult } from "./research-cli.js";
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
    content: "Retrieved source text.",
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
      return researchResult;
    },
  );

  try {
    assert.equal(await agent.respond("Hi Muse"), "Hello!");
    assert.equal(modelCalls, 1);
    assert.equal(researchQuestions.length, 0);

    const answer = await agent.respond("How does this work?");
    assert.match(answer, /Official guide - https:\/\/example\.org\/guide/);
    assert.match(answer, /1 of 3 candidate pages/);
    assert.match(researchQuestions[0] ?? "", /Follow-up question: How does this work\?/);
    assert.equal(modelCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research follow-ups carry prior messages and disclose archived context status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "muse-agent-followup-"));
  let receivedArchiveContext = "";
  const questions: string[] = [];
  const agent = new MuseAgent(
    { generateText: async () => "Hello!" },
    new MemoryService(new JsonMemoryRepository(join(directory, "memory.json"))),
    undefined,
    async (question, archivedContext) => {
      questions.push(question);
      receivedArchiveContext = archivedContext ?? "";
      return researchResult;
    },
  );

  try {
    await agent.respond("How does this work?");
    await agent.respond("Why?");
    assert.match(questions[1] ?? "", /Follow-up question: Why\?/);
    assert.match(questions[1] ?? "", /How does this work\?/);
    assert.equal(receivedArchiveContext, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research reply formatting includes retrieval status and only retrieved source links", () => {
  const answer = formatResearchReply(researchResult, true);

  assert.match(answer, /The sources describe the mechanism/);
  assert.match(answer, /Live search and retrieval: 1 of 3/);
  assert.match(answer, /Official guide/);
  assert.match(answer, /not rechecked/);
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
      "A short article from the supplied notes.",
    );
    assert.equal(researchCalls, 0);
    assert.match(writingPrompt, /No external research was requested or retrieved/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
