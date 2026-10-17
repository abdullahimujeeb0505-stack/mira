import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DecisionService } from "../decision/decision-service.js";
import { JsonLearningRepository } from "../learning/json-learning-repository.js";
import { LearningService } from "../learning/learning-service.js";
import { JsonMemoryRepository } from "../memory/json-memory-repository.js";
import { JsonOpportunityRepository } from "../opportunities/json-opportunity-repository.js";
import { OpportunityService } from "../opportunities/opportunity-service.js";
import type { NormalizedOpportunity } from "../opportunities/opportunity-types.js";
import { JsonWatchRuleRepository } from "./json-watch-rule-repository.js";
import { WatchService } from "./watch-service.js";
import type { NewWatchRule, WatchUpdate } from "./watch-types.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function makeOpportunity(
  overrides: Partial<NormalizedOpportunity> = {},
): NormalizedOpportunity {
  return {
    id: "watch-event-1",
    title: "Sunrise Airdrop",
    description: "Token rewards for Sunrise community contributors.",
    source: "Community Bulletin",
    sourceUrl: "https://updates.sunrise.example/airdrop",
    detectedAt: NOW.toISOString(),
    deadline: null,
    opportunityType: "AIRDROP",
    characteristics: {
      project: "Sunrise",
      audience: "Web3 community",
    },
    requirements: ["Join the project community"],
    ...overrides,
  };
}

function withWatchSystem(
  run: (context: {
    watchService: WatchService;
    watchRepository: JsonWatchRuleRepository;
    opportunityRepository: JsonOpportunityRepository;
    memoryRepository: JsonMemoryRepository;
    learningService: LearningService;
    watchFile: string;
  }) => Promise<void>,
): Promise<void> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-watch-system-"));
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
      const watchFile = join(directory, "watch-rules.json");
      const now = () => new Date(NOW);
      const decisionService = new DecisionService(
        memoryRepository,
        learningService,
        { now },
      );
      const opportunityService = new OpportunityService(
        decisionService,
        opportunityRepository,
        { now },
      );
      const watchRepository = new JsonWatchRuleRepository(watchFile, now);
      const watchService = new WatchService(watchRepository, opportunityService);
      await run({
        watchService,
        watchRepository,
        opportunityRepository,
        memoryRepository,
        learningService,
        watchFile,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

function rule(input: Partial<NewWatchRule> = {}): NewWatchRule {
  return {
    targetType: "KEYWORD",
    target: "airdrop",
    ...input,
  };
}

test("watch rules support add, list, get, update, enable, disable, and remove", async () =>
  withWatchSystem(async ({ watchService }) => {
    const created = await watchService.addRule(
      rule({
        sources: ["Community Bulletin"],
        keywords: ["early access"],
        opportunityTypes: ["AIRDROP"],
        exclusions: ["phishing"],
        priority: 70,
      }),
    );
    assert.equal(created.enabled, true);
    assert.deepEqual(created.sources, ["Community Bulletin"]);
    assert.equal((await watchService.getRule(created.id))?.id, created.id);
    assert.equal((await watchService.listRules()).length, 1);

    const updated = await watchService.updateRule(created.id, {
      target: "campaign",
      priority: 85,
      keywords: ["early access", "community"],
    });
    assert.equal(updated?.target, "campaign");
    assert.equal(updated?.priority, 85);
    assert.deepEqual(updated?.keywords, ["early access", "community"]);
    assert.equal(updated?.createdAt, created.createdAt);
    assert.equal(updated?.updatedAt, NOW.toISOString());

    assert.equal((await watchService.disableRule(created.id))?.enabled, false);
    assert.equal((await watchService.enableRule(created.id))?.enabled, true);
    assert.equal(await watchService.removeRule(created.id), true);
    assert.equal(await watchService.removeRule(created.id), false);
    assert.deepEqual(await watchService.listRules(), []);
  }));

test("disabled rules do not match or send updates for evaluation", async () =>
  withWatchSystem(async ({ watchService, opportunityRepository }) => {
    await watchService.addRule({ ...rule(), enabled: false });

    const result = await watchService.processUpdate({
      opportunity: makeOpportunity(),
    });

    assert.deepEqual(result.matchedRules, []);
    assert.equal(result.evaluation, null);
    assert.equal((await opportunityRepository.list()).length, 0);
  }));

test("all supported target kinds match normalized update identity hints", async () =>
  withWatchSystem(async ({ watchService }) => {
    const ruleInputs: NewWatchRule[] = [
      { targetType: "TRUSTED_ACCOUNT", target: "@SunriseDAO", priority: 10 },
      { targetType: "PROJECT", target: "Sunrise", priority: 20 },
      { targetType: "WEBSITE", target: "sunrise.example", priority: 70 },
      {
        targetType: "ANNOUNCEMENT_CHANNEL",
        target: "official-announcements",
        sources: ["Community Bulletin"],
        priority: 5,
      },
      { targetType: "KEYWORD", target: "airdrop" },
      { targetType: "OPPORTUNITY", target: "watch-event-1", priority: 90 },
    ];
    for (const input of ruleInputs) await watchService.addRule(input);

    const result = await watchService.processUpdate({
      opportunity: makeOpportunity(),
      entities: {
        trustedAccounts: ["@SunriseDAO"],
        projects: ["Sunrise"],
        websites: ["docs.sunrise.example"],
        announcementChannels: ["official-announcements"],
      },
    });

    assert.equal(result.matchedRules.length, 6);
    assert.deepEqual(
      result.matchedRules.map((matched) => matched.priority ?? 0),
      [90, 70, 20, 10, 5, 0],
    );
    assert.equal(result.effectivePriority, 90);
    assert.ok(result.evaluation);
  }));

test("source, keyword, opportunity type, and exclusion filters gate matching", async () =>
  withWatchSystem(async ({ watchService }) => {
    await watchService.addRule({
      targetType: "KEYWORD",
      target: "airdrop",
      sources: ["Curated Airdrop Bulletin"],
      keywords: ["early access"],
      opportunityTypes: ["AIRDROP"],
      exclusions: ["phishing"],
    });

    const cases: Array<[string, NormalizedOpportunity, boolean]> = [
      [
        "wrong source",
        makeOpportunity({ source: "Unknown Feed" }),
        false,
      ],
      [
        "wrong type",
        makeOpportunity({ opportunityType: "CAMPAIGN" }),
        false,
      ],
      [
        "missing required keyword",
        makeOpportunity({ description: "Token rewards for contributors." }),
        false,
      ],
      [
        "excluded content",
        makeOpportunity({
          description: "Early access to this phishing airdrop.",
        }),
        false,
      ],
      [
        "all filters satisfied",
        makeOpportunity({
          source: "Curated Airdrop Bulletin",
          description: "Early access for Sunrise airdrop contributors.",
        }),
        true,
      ],
    ];

    for (const [label, opportunity, shouldMatch] of cases) {
      const result = await watchService.processUpdate({ opportunity });
      assert.equal(
        result.matchedRules.length > 0,
        shouldMatch,
        `${label} should ${shouldMatch ? "match" : "not match"}`,
      );
      assert.equal(result.evaluation !== null, shouldMatch);
    }
  }));

test("airdrop, campaign, competition, grant, content, product launch, and other types are supported", async () =>
  withWatchSystem(async ({ watchService }) => {
    const types = [
      "AIRDROP",
      "CAMPAIGN",
      "COMPETITION",
      "GRANT",
      "CONTENT",
      "PRODUCT_LAUNCH",
      "OTHER",
    ] as const;
    for (const opportunityType of types) {
      await watchService.addRule({
        targetType: "KEYWORD",
        target: "sunrise",
        opportunityTypes: [opportunityType],
      });
      const result = await watchService.processUpdate({
        opportunity: makeOpportunity({ opportunityType }),
      });
      assert.ok(
        result.matchedRules.some((matched) =>
          matched.opportunityTypes.includes(opportunityType),
        ),
        `${opportunityType} should be supported`,
      );
    }
  }));

test("repeated updates deduplicate and retain the first source URL and timestamp", async () =>
  withWatchSystem(
    async ({
      watchService,
      opportunityRepository,
      memoryRepository,
    }) => {
      const firstInput = makeOpportunity({
        title: "Solstice Airdrop",
        description: "Airdrop rewards for Solstice contributors.",
        source: "Project Bulletin",
        sourceUrl:
          "https://events.example/solstice?id=7&utm_source=first",
        detectedAt: "2026-10-08T10:00:00.000Z",
      });
      await memoryRepository.create({
        category: "WATCHING",
        content: "I am watching Solstice Airdrop.",
      });
      await watchService.addRule({
        targetType: "KEYWORD",
        target: "airdrop",
      });

      const first = await watchService.processUpdate({
        opportunity: firstInput,
      });
      const second = await watchService.processUpdate({
        opportunity: {
          ...firstInput,
          id: "revised-id",
          title: "Solstice Airdrop Details",
          sourceUrl:
            "https://events.example/solstice?utm_source=second&id=7#details",
          detectedAt: "2026-10-08T11:00:00.000Z",
        },
      });

      assert.equal(first.evaluation?.saved, true);
      assert.equal(first.evaluation?.duplicate, false);
      assert.equal(second.evaluation?.duplicate, true);
      assert.equal(second.evaluation?.opportunity.id, first.evaluation?.opportunity.id);
      assert.equal(
        second.evaluation?.opportunity.sourceUrl,
        "https://events.example/solstice?id=7&utm_source=first",
      );
      assert.equal(
        second.evaluation?.opportunity.detectedAt,
        "2026-10-08T10:00:00.000Z",
      );
      assert.equal((await opportunityRepository.list()).length, 1);
    },
  ));

test("watch rules persist across repository instances", async () =>
  withWatchSystem(async ({ watchService, watchFile }) => {
    const created = await watchService.addRule({
      targetType: "PROJECT",
      target: "Cedar Protocol",
      opportunityTypes: ["GRANT", "PRODUCT_LAUNCH"],
      sources: ["official announcements"],
      priority: 45,
      enabled: false,
    });

    const reopened = new JsonWatchRuleRepository(watchFile, () => new Date(NOW));
    assert.deepEqual(await reopened.get(created.id), created);
    assert.equal((await reopened.list())[0]?.enabled, false);
  }));

test("matching uses OpportunityService and DecisionService with memory and learned patterns", async () =>
  withWatchSystem(
    async ({ watchService, memoryRepository, learningService }) => {
      const opportunity = makeOpportunity({
        title: "Luma Airdrop",
        description: "Token rewards for community contributors",
        source: "Luma announcements",
        sourceUrl: "https://luma.example/airdrop",
        characteristics: ["Luma Airdrop", "community contributors"],
        requirements: ["Join the project community"],
      });
      const observed = {
        domain: "opportunity" as const,
        eventType: "AIRDROP",
        description:
          "Luma Airdrop. Token rewards for community contributors. Requirements: Join the project community.",
        characteristics: [
          "Luma Airdrop",
          "community contributors",
          "Join the project community",
        ],
        outcome: "success" as const,
        evidence: "The previous Luma campaign reached its participation goal.",
      };
      const learned = await learningService.recordOutcome(observed);
      await memoryRepository.create({
        category: "WATCHING",
        content: "Luma Airdrop",
      });
      await watchService.addRule({
        targetType: "PROJECT",
        target: "Luma",
        keywords: ["rewards"],
        opportunityTypes: ["AIRDROP"],
      });

      const result = await watchService.processUpdate({ opportunity });

      assert.equal(result.matchedRules.length, 1);
      assert.ok(
        result.evaluation?.decision.reasons.some((reason) =>
          reason.includes("matched 1 enabled watch rule(s) (+5 relevance)"),
        ),
        "the decision should explain the relevance boost from the matched watch rule",
      );
      assert.equal(result.evaluation?.decision.level, "SURFACE");
      assert.equal(result.evaluation?.saved, true);
      assert.ok(
        result.evaluation?.decision.relevantLearnedPatterns.some(
          (record) => record.id === learned.id,
        ),
      );
    },
  ));
