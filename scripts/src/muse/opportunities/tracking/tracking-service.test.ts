import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LearningService } from "../../learning/learning-service.js";
import { JsonLearningRepository } from "../../learning/json-learning-repository.js";
import { JsonOpportunityRepository } from "../json-opportunity-repository.js";
import { JsonTrackingRepository } from "./json-tracking-repository.js";
import { OpportunityTrackingService } from "./tracking-service.js";
import type {
  NewTrackedOpportunity,
  TrackingEvidence,
} from "./tracking-types.js";
import type { Opportunity } from "../opportunity-types.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function withTracking(
  run: (context: {
    service: OpportunityTrackingService;
    repository: JsonTrackingRepository;
    learningRepository: JsonLearningRepository;
    trackingFile: string;
  }) => Promise<void>,
): Promise<void> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-tracking-"));
    try {
      const trackingFile = join(directory, "tracked-opportunities.json");
      const repository = new JsonTrackingRepository(trackingFile);
      const learningRepository = new JsonLearningRepository(
        join(directory, "learning.json"),
      );
      const service = new OpportunityTrackingService(
        repository,
        new LearningService(learningRepository),
        { now: () => new Date(NOW) },
      );
      await run({ service, repository, learningRepository, trackingFile });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

function newOpportunity(
  overrides: Partial<NewTrackedOpportunity> = {},
): NewTrackedOpportunity {
  return {
    title: "Orbit contributor airdrop",
    category: "AIRDROP",
    project: "Orbit",
    description: "Airdrop for early contributors.",
    sourceName: "Orbit announcements",
    sourceUrl: "https://orbit.example/airdrop",
    ...overrides,
  };
}

function evidence(
  description = "Official project announcement confirms the result.",
  url = "https://orbit.example/announcement",
): TrackingEvidence[] {
  return [{ description, url, source: "official project" }];
}

function discoveredOpportunity(id = "discovered-1"): Opportunity {
  return {
    id,
    title: "Cinder waitlist",
    description: "Cinder is accepting waitlist applications.",
    source: "Cinder announcements",
    sourceUrl: "https://cinder.example/waitlist?utm_source=feed",
    detectedAt: "2026-10-07T10:00:00.000Z",
    deadline: "2026-10-20T00:00:00.000Z",
    opportunityType: "WL",
    characteristics: { project: "Cinder" },
    requirements: [],
    status: "SURFACED",
  };
}

test("tracking supports add, view, filtered lists, update, and delete", async () =>
  withTracking(async ({ service }) => {
    const created = await service.add(newOpportunity());
    assert.equal(created.created, true);
    assert.equal(created.record.status, "DISCOVERED");
    assert.equal(created.record.statusHistory.length, 1);
    assert.equal(created.record.statusHistory[0]?.previousStatus, null);

    const viewed = await service.get(created.record.id);
    assert.equal(viewed?.title, "Orbit contributor airdrop");
    assert.equal((await service.list({ category: "AIRDROP" })).length, 1);
    assert.equal((await service.list({ status: "INTERESTED" })).length, 0);

    const updated = await service.update(created.record.id, {
      deadline: "2026-10-15T00:00:00Z",
      notes: "Check application requirements.",
      nextAction: "Review the official application page",
      nextActionDueAt: "2026-10-10T00:00:00Z",
      walletAddressReferences: [
        {
          chain: "ethereum",
          address: `0x${"a".repeat(40)}`,
          label: "eligibility wallet",
        },
      ],
    });
    assert.equal(updated?.deadline, "2026-10-15T00:00:00.000Z");
    assert.equal(updated?.nextAction, "Review the official application page");
    assert.equal(updated?.walletAddressReferences[0]?.chain, "ethereum");
    assert.ok(updated?.updatedAt);

    assert.equal(await service.delete(created.record.id), true);
    assert.equal(await service.get(created.record.id), undefined);
    assert.equal(await service.delete(created.record.id), false);
  }));

test("invalid URLs, dates, statuses, wallet secrets, and mnemonic-like values are rejected", async () =>
  withTracking(async ({ service }) => {
    await assert.rejects(
      service.add(newOpportunity({ sourceUrl: "file:///etc/passwd" })),
      /HTTP or HTTPS URL/,
    );
    await assert.rejects(
      service.add(newOpportunity({ sourceUrl: "https://user:pass@orbit.example/" })),
      /without embedded credentials/,
    );
    await assert.rejects(
      service.add(newOpportunity({ sourceUrl: "https://orbit.example/apply?token=secret" })),
      /credential query parameters/,
    );
    await assert.rejects(
      service.add(newOpportunity({ category: "NFTS" as never })),
      /category is not supported/,
    );
    await assert.rejects(
      service.add(newOpportunity({ deadline: "not a date" })),
      /valid date/,
    );
    await assert.rejects(
      service.add(newOpportunity({ notes: `0x${"b".repeat(64)}` })),
      /credential, private key, or seed phrase/,
    );
    await assert.rejects(
      service.add(
        newOpportunity({
          notes:
            "abandon ability able about above absent absorb abstract absurd abuse access accident",
        }),
      ),
      /credential, private key, or seed phrase/,
    );
    await assert.rejects(
      service.add(
        newOpportunity({
          walletAddressReferences: [
            { chain: "ethereum", address: `0x${"c".repeat(64)}` },
          ],
        }),
      ),
      /credential, private key/,
    );

    const created = await service.add(newOpportunity());
    await assert.rejects(
      service.setStatus(created.record.id, "NOT_A_STATUS" as never),
      /status is not supported/,
    );
    await assert.rejects(
      service.setStatus(created.record.id, "WON"),
      /Evidence is required/,
    );
    assert.equal((await service.get(created.record.id))?.status, "DISCOVERED");
  }));

test("application, submission, and evidence-backed status changes retain history", async () =>
  withTracking(async ({ service }) => {
    const { record } = await service.add(newOpportunity());
    const applied = await service.markApplied(record.id, "2026-10-08T13:00:00Z");
    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.applicationDate, "2026-10-08T13:00:00.000Z");

    const submitted = await service.markSubmitted(
      record.id,
      "2026-10-09T13:00:00Z",
      [{ description: "Submission receipt received." }],
    );
    assert.equal(submitted.status, "SUBMITTED");
    assert.equal(submitted.submissionDate, "2026-10-09T13:00:00.000Z");

    await assert.rejects(service.setStatus(record.id, "ELIGIBLE"), /Evidence is required/);
    const eligible = await service.recordEligibilityResult(
      record.id,
      "ELIGIBLE",
      evidence("Eligibility checker reports eligible."),
      "2026-10-10T12:00:00Z",
    );
    assert.equal(eligible.status, "ELIGIBLE");
    const change = eligible.statusHistory.at(-1);
    assert.equal(change?.previousStatus, "SUBMITTED");
    assert.equal(change?.status, "ELIGIBLE");
    assert.equal(change?.evidence[0]?.url, "https://orbit.example/announcement");
    assert.equal(eligible.outcomes.at(-1)?.outcome, "success");
  }));

test("discovered opportunities import into tracking and duplicate imports are idempotent", async () =>
  withTracking(async ({ service }) => {
    const existingOpportunity = discoveredOpportunity();
    const first = await service.addFromOpportunity(existingOpportunity);
    const second = await service.addFromOpportunity(existingOpportunity);
    const sameUrl = await service.add(
      newOpportunity({
        title: "Cinder waitlist",
        category: "WL_APPLICATION",
        project: "Cinder",
        sourceUrl: "https://cinder.example/waitlist#application",
      }),
    );

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.record.id, first.record.id);
    assert.equal(sameUrl.created, false);
    assert.equal(sameUrl.record.sourceOpportunityId, existingOpportunity.id);
    assert.equal(first.record.category, "WL_APPLICATION");
    assert.equal(first.record.deadline, "2026-10-20T00:00:00.000Z");
    assert.equal((await service.list()).length, 1);
  }));

test("updates cannot create a duplicate tracking identity", async () =>
  withTracking(async ({ service }) => {
    const first = await service.add(newOpportunity({ title: "Orbit campaign" }));
    const second = await service.add(
      newOpportunity({
        title: "Another project grant",
        category: "GRANT",
        sourceUrl: "https://grant.example/apply",
      }),
    );

    await assert.rejects(
      service.update(second.record.id, { sourceUrl: first.record.sourceUrl }),
      /duplicate another tracked opportunity/,
    );
    assert.equal((await service.get(second.record.id))?.sourceUrl, "https://grant.example/apply");
  }));

test("eligibility and competition results require evidence and teach LearningService", async () =>
  withTracking(async ({ service, learningRepository }) => {
    const eligibility = await service.add(newOpportunity());
    const eligible = await service.recordEligibilityResult(
      eligibility.record.id,
      "ELIGIBLE",
      evidence("Eligibility confirmed by the official checker."),
    );
    assert.equal(eligible.status, "ELIGIBLE");

    const competition = await service.add(
      newOpportunity({
        title: "Orbit writing competition",
        category: "COMPETITION",
        sourceUrl: "https://orbit.example/writing-contest",
      }),
    );
    const won = await service.recordCompetitionResult(
      competition.record.id,
      "WON",
      evidence("The official results list the submission as a winner."),
    );
    assert.equal(won.status, "WON");

    const unknown = await service.add(
      newOpportunity({
        title: "Orbit campaign result",
        category: "CAMPAIGN",
        sourceUrl: "https://orbit.example/campaign-result",
      }),
    );
    await service.recordEligibilityResult(
      unknown.record.id,
      "UNKNOWN",
      evidence("The checker is not available yet."),
    );

    const records = await learningRepository.list();
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.outcome === "success"));
    assert.ok(records.some((record) => record.category === "SUCCESS_PATTERN"));
    assert.ok(records.every((record) => record.evidence.includes("https://orbit.example/announcement")));
  }));

test("general outcomes support failure, neutral, and unknown while unknown is not learned", async () =>
  withTracking(async ({ service, learningRepository }) => {
    const failed = await service.add(newOpportunity({ title: "Failed Orbit campaign" }));
    const failureRecord = await service.recordOutcome(failed.record.id, {
      outcome: "failure",
      description: "The application was declined.",
      evidence: evidence("Official decline notice."),
    });
    assert.equal(failureRecord.outcomes.at(-1)?.outcome, "failure");

    const neutral = await service.add(
      newOpportunity({
        title: "Completed Orbit quest",
        category: "QUEST",
        sourceUrl: "https://orbit.example/quest",
      }),
    );
    await service.recordOutcome(neutral.record.id, {
      outcome: "neutral",
      description: "The quest was completed without a reported reward.",
      evidence: evidence("Quest completion page."),
    });

    const unknown = await service.add(
      newOpportunity({
        title: "Unknown Orbit result",
        sourceUrl: "https://orbit.example/unknown-result",
      }),
    );
    await service.recordOutcome(unknown.record.id, {
      outcome: "unknown",
      description: "No result has been announced.",
      evidence: evidence("Official page has no result yet."),
    });

    const learned = await learningRepository.list();
    assert.equal(learned.length, 2);
    assert.ok(learned.some((record) => record.outcome === "failure"));
    assert.ok(learned.some((record) => record.outcome === "neutral"));
  }));

test("upcoming deadlines and overdue follow-ups are queried by dates and status", async () =>
  withTracking(async ({ service }) => {
    const upcoming = await service.add(
      newOpportunity({
        title: "Upcoming Orbit grant",
        category: "GRANT",
        sourceUrl: "https://orbit.example/grant",
        deadline: "2026-10-10T12:00:00Z",
      }),
    );
    const overdue = await service.add(
      newOpportunity({
        title: "Overdue Orbit application",
        category: "WL_APPLICATION",
        sourceUrl: "https://orbit.example/overdue",
        deadline: "2026-10-07T12:00:00Z",
        nextAction: "Follow up with the project",
        nextActionDueAt: "2026-10-06T12:00:00Z",
      }),
    );
    const closed = await service.add(
      newOpportunity({
        title: "Archived Orbit campaign",
        category: "CAMPAIGN",
        sourceUrl: "https://orbit.example/archived",
        deadline: "2026-10-06T12:00:00Z",
      }),
    );
    await service.archive(closed.record.id);

    const dueSoon = await service.listUpcoming(3);
    const late = await service.listOverdue();
    assert.deepEqual(dueSoon.map((record) => record.id), [upcoming.record.id]);
    assert.deepEqual(late.map((record) => record.id), [overdue.record.id]);
  }));

test("notes, next actions, close, archive, and reopen work without losing history", async () =>
  withTracking(async ({ service }) => {
    const { record } = await service.add(newOpportunity());
    const noted = await service.addNote(record.id, "Keep an eye on the checker.");
    const next = await service.setNextAction(
      record.id,
      "Check results",
      "2026-10-12T12:00:00Z",
    );
    assert.equal(noted.notes, "Keep an eye on the checker.");
    assert.equal(next.nextAction, "Check results");
    assert.equal(next.nextActionDueAt, "2026-10-12T12:00:00.000Z");

    const closed = await service.close(record.id);
    assert.equal(closed.status, "CLOSED");
    const archived = await service.archive(record.id);
    assert.equal(archived.status, "ARCHIVED");
    const reopened = await service.reopen(record.id, "INTERESTED");
    assert.equal(reopened.status, "INTERESTED");
    assert.equal(reopened.statusHistory.length, 4);
    assert.equal(reopened.statusHistory.at(-1)?.previousStatus, "ARCHIVED");
  }));

test("tracking records, dates, evidence, and wallet references persist", async () =>
  withTracking(async ({ service, trackingFile }) => {
    const added = await service.add(
      newOpportunity({
        walletAddressReferences: [
          { chain: "solana", address: "11111111111111111111111111111111" },
        ],
        deadline: "2026-10-18T00:00:00Z",
      }),
    );
    const applied = await service.markApplied(added.record.id);
    const reopened = new JsonTrackingRepository(trackingFile);
    const stored = await reopened.get(added.record.id);

    assert.equal(stored?.status, "APPLIED");
    assert.equal(stored?.deadline, "2026-10-18T00:00:00.000Z");
    assert.equal(stored?.walletAddressReferences[0]?.chain, "solana");
    assert.equal(stored?.applicationDate, applied.applicationDate);
    assert.equal(stored?.statusHistory.length, 2);
  }));
