import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionService } from "../decision/decision-service.js";
import { JsonLearningRepository } from "../learning/json-learning-repository.js";
import { LearningService } from "../learning/learning-service.js";
import { JsonMemoryRepository } from "../memory/json-memory-repository.js";
import { JsonOpportunityRepository } from "./json-opportunity-repository.js";
import {
  createOpportunityOutcome,
  toLearningObservation,
} from "./outcome-model.js";
import { OpportunityService } from "./opportunity-service.js";
import type {
  NormalizedOpportunity,
  OpportunityType,
} from "./opportunity-types.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function createInput(
  opportunityType: OpportunityType,
  title: string,
  sourceUrl: string | null = `https://opportunities.test/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
): NormalizedOpportunity {
  return {
    title,
    description: `${title} for Web3 builders.`,
    source: "community calendar",
    sourceUrl,
    detectedAt: NOW.toISOString(),
    deadline: null,
    opportunityType,
    characteristics: {
      project: title,
      audience: "Web3 builders",
      potentialValue: 80,
    },
    requirements: ["Follow the project guidelines"],
  };
}

function withOpportunityService(
  run: (
    service: OpportunityService,
    opportunityRepository: JsonOpportunityRepository,
    memoryRepository: JsonMemoryRepository,
    learningService: LearningService,
  ) => Promise<void>,
): Promise<void> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-opportunities-"));
    try {
      const memoryRepository = new JsonMemoryRepository(
        join(directory, "memories.json"),
      );
      const learningService = new LearningService(
        new JsonLearningRepository(join(directory, "learning.json")),
      );
      const opportunityRepository = new JsonOpportunityRepository(
        join(directory, "opportunities.json"),
      );
      const now = () => new Date(NOW);
      const decisionService = new DecisionService(
        memoryRepository,
        learningService,
        { now },
      );
      const service = new OpportunityService(
        decisionService,
        opportunityRepository,
        { now },
      );
      await run(
        service,
        opportunityRepository,
        memoryRepository,
        learningService,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

test("WL, free mint, competition, and content opportunities are decided and saved", async () =>
  withOpportunityService(
    async (service, opportunityRepository, memoryRepository) => {
      const examples: Array<{
        type: OpportunityType;
        title: string;
        memoryCategory: "WATCHING" | "CONTENT";
      }> = [
        { type: "WL", title: "Nebula WL", memoryCategory: "WATCHING" },
        {
          type: "FREE_MINT",
          title: "Aster Free Mint",
          memoryCategory: "WATCHING",
        },
        {
          type: "COMPETITION",
          title: "Pixel Build Competition",
          memoryCategory: "WATCHING",
        },
        {
          type: "CONTENT",
          title: "Wallet UX Article",
          memoryCategory: "CONTENT",
        },
      ];

      for (const example of examples) {
        await memoryRepository.create({
          category: example.memoryCategory,
          content:
            example.memoryCategory === "WATCHING"
              ? `I am watching ${example.title}.`
              : example.title,
        });
      }

      for (const example of examples) {
        const result = await service.evaluate(
          createInput(example.type, example.title),
        );
        assert.equal(result.opportunity.opportunityType, example.type);
        assert.notEqual(result.decision.level, "IGNORE");
        assert.equal(result.saved, true);
        assert.equal(result.duplicate, false);
      }

      assert.equal((await opportunityRepository.list()).length, 4);
    },
  ));

test("tracking parameters and fragments do not create duplicate opportunities", async () =>
  withOpportunityService(
    async (service, opportunityRepository, memoryRepository) => {
      const input = createInput(
        "FREE_MINT",
        "Orion Free Mint",
        "https://opportunities.test/orion?id=42&utm_source=first#details",
      );
      await memoryRepository.create({
        category: "WATCHING",
        content: "I am watching the Orion Free Mint.",
      });

      const [first, second, titleFallback] = await Promise.all([
        service.evaluate(input),
        service.evaluate({
          ...input,
          sourceUrl:
            "https://opportunities.test/orion?utm_source=second&id=42#new",
        }),
        service.evaluate({ ...input, sourceUrl: null }),
      ]);

      assert.equal(first.saved, true);
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(titleFallback.duplicate, true);
      assert.equal(second.opportunity.id, first.opportunity.id);
      assert.equal(titleFallback.opportunity.id, first.opportunity.id);
      assert.equal((await opportunityRepository.list()).length, 1);
    },
  ));

test("ignored opportunities are returned but not persisted", async () =>
  withOpportunityService(async (service, opportunityRepository) => {
    const result = await service.evaluate(
      createInput("OTHER", "Unrelated birdwatching meetup"),
    );

    assert.equal(result.decision.level, "IGNORE");
    assert.equal(result.opportunity.status, "IGNORED");
    assert.equal(result.saved, false);
    assert.equal((await opportunityRepository.list()).length, 0);
  }));

test("opportunity outcomes map to LearningService input and unknown remains unlearned", async () =>
  withOpportunityService(async (service, _repository, memoryRepository, learningService) => {
    const input = createInput("GRANT", "Cedar Builder Grant");
    await memoryRepository.create({
      category: "WATCHING",
      content: "I am watching the Cedar Builder Grant.",
    });
    const evaluated = await service.evaluate(input);
    const success = createOpportunityOutcome(evaluated.opportunity, {
      outcome: "success",
      description: "The grant application was accepted.",
      evidence: "Award notification received.",
      occurredAt: NOW.toISOString(),
    });
    const learningInput = toLearningObservation(success);

    assert.ok(learningInput);
    assert.equal(learningInput.domain, "opportunity");
    assert.equal(learningInput.eventType, "GRANT");
    assert.equal(
      (await learningService.recordOutcome(learningInput)).category,
      "SUCCESS_PATTERN",
    );

    const unknown = createOpportunityOutcome(evaluated.opportunity, {
      outcome: "unknown",
      description: "The application result is not known yet.",
      evidence: "Awaiting the announcement.",
      occurredAt: NOW.toISOString(),
    });
    assert.equal(toLearningObservation(unknown), undefined);
  }));
