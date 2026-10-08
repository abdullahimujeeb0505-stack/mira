import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionService, formatDecision } from "./decision-service.js";
import { JsonLearningRepository } from "../learning/json-learning-repository.js";
import { LearningService } from "../learning/learning-service.js";
import type { ObservedOutcome } from "../learning/outcome-types.js";
import { JsonMemoryRepository } from "../memory/json-memory-repository.js";
import type { DecisionEvent } from "./decision-types.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

const opportunity: DecisionEvent = {
  title: "Atlas creator grant",
  domain: "opportunity",
  eventType: "creator grant",
  description: "Atlas creator grant for Web3 teams building creator tools",
  characteristics: {
    project: "Atlas creator tools",
    audience: "Web3 teams",
  },
};

const observedSuccess: ObservedOutcome = {
  ...opportunity,
  eventType: "creator grant",
  outcome: "success",
  evidence: "The grant application was accepted.",
};

function withDecisionService(
  run: (
    service: DecisionService,
    memoryRepository: JsonMemoryRepository,
    learningService: LearningService,
  ) => Promise<void>,
): Promise<void> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-decision-test-"));
    try {
      const memoryRepository = new JsonMemoryRepository(
        join(directory, "memories.json"),
      );
      const learningService = new LearningService(
        new JsonLearningRepository(join(directory, "learning.json")),
      );
      const service = new DecisionService(memoryRepository, learningService, {
        now: () => new Date(NOW),
      });
      await run(service, memoryRepository, learningService);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

test("a highly relevant opportunity is surfaced with explainable reasons", async () =>
  withDecisionService(async (service, memoryRepository) => {
    await memoryRepository.create({
      category: "WATCHING",
      content: "I am watching the Atlas Creator Grant.",
    });
    await memoryRepository.create({
      category: "ACTIVE",
      content: "My current goal is to apply for the Atlas Creator Grant.",
    });

    const decision = await service.evaluate(opportunity);

    assert.equal(decision.level, "SURFACE");
    assert.equal(decision.shouldNotifyUser, true);
    assert.ok(decision.relevanceScore >= 65);
    assert.ok(decision.reasons.some((reason) => reason.includes("watched project")));
    assert.ok(decision.reasons.some((reason) => reason.includes("active goal")));
    assert.match(formatDecision(decision), /^SURFACE Relevance: \d+ Reasons:/);
    assert.match(formatDecision(decision), /matches a watched project/);
  }));

test("an irrelevant opportunity is ignored", async () =>
  withDecisionService(async (service) => {
    const decision = await service.evaluate({
      domain: "opportunity",
      eventType: "dog walking meetup",
      description: "A neighborhood dog walking group is meeting this weekend",
      characteristics: ["local", "pets"],
    });

    assert.equal(decision.level, "IGNORE");
    assert.equal(decision.shouldNotifyUser, false);
    assert.equal(decision.relevanceScore, 15);
  }));

test("a previously successful pattern increases relevance", async () =>
  withDecisionService(async (service, _memoryRepository, learningService) => {
    const before = await service.evaluate(opportunity);
    await learningService.recordOutcome(observedSuccess);
    const after = await service.evaluate(opportunity);

    assert.ok(after.relevanceScore > before.relevanceScore);
    assert.ok(after.relevantLearnedPatterns.some((record) => record.category === "SUCCESS_PATTERN"));
  }));

test("a contradictory failure pattern reduces relevance", async () =>
  withDecisionService(async (service, _memoryRepository, learningService) => {
    await learningService.recordOutcome(observedSuccess);
    await learningService.recordOutcome({
      ...observedSuccess,
      evidence: "A similar application was declined.",
    });
    const beforeFailure = await service.evaluate(opportunity);

    await learningService.recordOutcome({
      ...observedSuccess,
      outcome: "failure",
      evidence: "The latest similar application was rejected.",
    });
    const afterFailure = await service.evaluate(opportunity);

    assert.ok(afterFailure.relevanceScore < beforeFailure.relevanceScore);
    assert.ok(afterFailure.relevantLearnedPatterns.some((record) => record.category === "FAILURE_PATTERN"));
  }));

test("an imminent deadline increases priority to urgent", async () =>
  withDecisionService(async (service, memoryRepository) => {
    await memoryRepository.create({
      category: "WATCHING",
      content: "I am watching the Atlas Creator Grant.",
    });
    const withoutDeadline = await service.evaluate(opportunity);
    const withDeadline = await service.evaluate({
      ...opportunity,
      deadlineAt: "2026-10-08T18:00:00.000Z",
    });

    assert.equal(withoutDeadline.level, "SURFACE");
    assert.equal(withDeadline.level, "URGENT");
    assert.ok(withDeadline.urgencyScore > withoutDeadline.urgencyScore);
    assert.equal(withDeadline.shouldNotifyUser, true);
    assert.ok(withDeadline.reasons.some((reason) => reason.includes("deadline is within 24 hours")));
  }));

test("the decision returns the learned patterns that influenced it", async () =>
  withDecisionService(async (service, _memoryRepository, learningService) => {
    const learned = await learningService.recordOutcome(observedSuccess);
    const decision = await service.evaluate(opportunity);

    assert.deepEqual(
      decision.relevantLearnedPatterns.map((record) => record.id),
      [learned.id],
    );
    assert.ok(decision.reasons.some((reason) => reason.includes("previous successful pattern")));
  }));

test("a modest match is saved without notifying the user", async () =>
  withDecisionService(async (service, memoryRepository) => {
    await memoryRepository.create({
      category: "ACTIVE",
      content: "My goal is to attend an Ethereum workshop.",
    });
    const decision = await service.evaluate({
      domain: "opportunity",
      eventType: "Ethereum workshop",
      description: "A workshop about Ethereum networking",
    });

    assert.equal(decision.level, "SAVE");
    assert.equal(decision.shouldNotifyUser, false);
  }));
