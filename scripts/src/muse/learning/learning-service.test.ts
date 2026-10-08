import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonLearningRepository } from "./json-learning-repository.js";
import { LearningService } from "./learning-service.js";
import type { ObservedOutcome, OutcomeContext } from "./outcome-types.js";

const successfulOpportunity: ObservedOutcome = {
  domain: "opportunity",
  eventType: "partnership outreach",
  description: "Personalized email pitch to independent game studios",
  characteristics: {
    audience: "independent game studios",
    channel: "email",
    tone: "personalized",
  },
  outcome: "success",
  evidence: "The studio replied and booked a follow-up call.",
};

function similarSuccess(): ObservedOutcome {
  return {
    ...successfulOpportunity,
    description: "Personalized email pitch for independent gaming studios",
    evidence: "A second studio booked a partnership call.",
  };
}

function withService(
  run: (
    service: LearningService,
    repository: JsonLearningRepository,
  ) => Promise<void>,
): Promise<void> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-learning-service-"));
    try {
      const repository = new JsonLearningRepository(
        join(directory, "learning.json"),
      );
      await run(new LearningService(repository), repository);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

test("a first successful opportunity creates one weak pattern", async () =>
  withService(async (service) => {
    const record = await service.recordOutcome(successfulOpportunity);

    assert.equal(record.category, "SUCCESS_PATTERN");
    assert.equal(record.outcome, "success");
    assert.equal(record.observations, 1);
    assert.equal(record.confidence, 0.3);
    assert.match(record.evidence, /booked a follow-up call/);
  }));

test("a repeated similar success reinforces the existing pattern", async () =>
  withService(async (service) => {
    const first = await service.recordOutcome(successfulOpportunity);
    const second = await service.recordOutcome(similarSuccess());

    assert.equal(second.id, first.id);
    assert.equal(second.observations, 2);
    assert.equal(second.confidence, 0.4);
    assert.equal((await service.retrieveRelevant(successfulOpportunity)).length, 1);
  }));

test("a contradictory failure gradually reduces confidence", async () =>
  withService(async (service) => {
    const first = await service.recordOutcome(successfulOpportunity);
    const reinforced = await service.recordOutcome(similarSuccess());
    const failure = await service.recordOutcome({
      ...successfulOpportunity,
      outcome: "failure",
      evidence: "A similar studio declined the same partnership pitch.",
    });

    assert.equal(reinforced.id, first.id);
    assert.equal(failure.id, first.id);
    assert.equal(failure.category, "FAILURE_PATTERN");
    assert.equal(failure.outcome, "failure");
    assert.equal(failure.observations, 3);
    assert.equal(failure.confidence, 0.3);
    assert.equal((await service.retrieveRelevant(successfulOpportunity)).length, 1);
  }));

test("an unrelated event does not reinforce an existing pattern", async () =>
  withService(async (service, repository) => {
    const first = await service.recordOutcome(successfulOpportunity);
    const unrelated: ObservedOutcome = {
      domain: "opportunity",
      eventType: "grant application",
      description: "Submitted a public goods grant proposal",
      characteristics: {
        program: "retroactive public goods",
        format: "application",
      },
      outcome: "success",
      evidence: "The grant program confirmed receipt.",
    };

    const second = await service.recordOutcome(unrelated);
    const records = await repository.list();

    assert.notEqual(second.id, first.id);
    assert.equal(first.confidence, 0.3);
    assert.equal(first.observations, 1);
    assert.equal(records.length, 2);
  }));

test("a relevant future event retrieves the learned pattern", async () =>
  withService(async (service) => {
    const learned = await service.recordOutcome(successfulOpportunity);
    const futureEvent: OutcomeContext = {
      ...successfulOpportunity,
      description: "Personalized email pitch for independent gaming studios",
    };

    const retrieved = await service.retrieveRelevant(futureEvent);
    assert.deepEqual(
      retrieved.map((record) => record.id),
      [learned.id],
    );
  }));

test("duplicate similar observations update one record instead of creating duplicates", async () =>
  withService(async (service) => {
    const first = await service.recordOutcome(successfulOpportunity);
    await service.recordOutcome(similarSuccess());
    const third = await service.recordOutcome({
      ...similarSuccess(),
      description: "Personalized email pitch to independent game studios",
      evidence: "A third studio booked a call.",
    });
    const retrieved = await service.retrieveRelevant(successfulOpportunity, 10);

    assert.equal(third.id, first.id);
    assert.equal(third.observations, 3);
    assert.equal(retrieved.length, 1);
  }));
