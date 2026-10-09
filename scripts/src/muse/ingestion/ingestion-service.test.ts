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
import { JsonWatchRuleRepository } from "../watch/json-watch-rule-repository.js";
import { WatchService } from "../watch/watch-service.js";
import { JsonSourceRepository } from "./json-source-repository.js";
import { MockSourceAdapter } from "./mock-source-adapter.js";
import { SourceIngestionService, SourceRateLimitError } from "./source-ingestion-service.js";
import type { SchedulerRuntime } from "./runtime.js";
import { SourceRegistry } from "./source-registry.js";
import { SourceScheduler } from "./source-scheduler.js";
import type {
  SourceAdapter,
  SourceConfiguration,
  SourceFetchContext,
  SourceUpdate,
} from "./source-types.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

class FakeRuntime implements SchedulerRuntime {
  private currentTime = NOW.getTime();
  private nextHandle = 1;
  private readonly timers = new Map<
    number,
    { dueAt: number; callback: () => void }
  >();

  now(): Date {
    return new Date(this.currentTime);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, {
      dueAt: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.setTimeout(resolve, delayMs);
    });
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  async advanceBy(milliseconds: number): Promise<void> {
    const targetTime = this.currentTime + milliseconds;
    for (let step = 0; step < 100; step += 1) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.timers.delete(handle);
      this.currentTime = timer.dueAt;
      timer.callback();
      await flushAsyncWork();
    }
    this.currentTime = targetTime;
    await flushAsyncWork();
  }
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeUpdate(
  id: string,
  sourceId: string,
  overrides: Partial<SourceUpdate> = {},
): SourceUpdate {
  return {
    id,
    sourceId,
    sourceType: "feed",
    sourceUrl: `https://updates.example/${id}`,
    title: "Orbit Airdrop",
    text: "Airdrop rewards for Orbit contributors.",
    publishedAt: "2026-10-07T10:00:00.000Z",
    retrievedAt: NOW.toISOString(),
    ...overrides,
  };
}

function withIngestion(
  run: (context: {
    runtime: FakeRuntime;
    sourceRepository: JsonSourceRepository;
    registry: SourceRegistry;
    mockAdapter: MockSourceAdapter;
    ingestion: SourceIngestionService;
    scheduler: SourceScheduler;
    memoryRepository: JsonMemoryRepository;
    opportunityRepository: JsonOpportunityRepository;
    watchService: WatchService;
    sourceFile: string;
  }) => Promise<void>,
  options: { maxRetries?: number } = {},
): Promise<void> {
  return (async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-ingestion-"));
    const runtime = new FakeRuntime();
    try {
      const sourceFile = join(directory, "sources.json");
      const sourceRepository = new JsonSourceRepository(
        sourceFile,
        () => runtime.now(),
      );
      const registry = new SourceRegistry();
      const mockAdapter = new MockSourceAdapter();
      registry.register(mockAdapter);

      const memoryRepository = new JsonMemoryRepository(
        join(directory, "memories.json"),
      );
      const learningService = new LearningService(
        new JsonLearningRepository(join(directory, "learning.json")),
      );
      const opportunityRepository = new JsonOpportunityRepository(
        join(directory, "opportunities.json"),
      );
      const opportunityService = new OpportunityService(
        new DecisionService(memoryRepository, learningService, {
          now: () => runtime.now(),
        }),
        opportunityRepository,
        { now: () => runtime.now() },
      );
      const watchService = new WatchService(
        new JsonWatchRuleRepository(join(directory, "watch-rules.json")),
        opportunityService,
      );
      const ingestion = new SourceIngestionService(
        sourceRepository,
        registry,
        watchService,
        {
          runtime,
          retryDelayMs: 0,
          ...(options.maxRetries !== undefined
            ? { maxRetries: options.maxRetries }
            : {}),
        },
      );
      const scheduler = new SourceScheduler(
        sourceRepository,
        ingestion,
        runtime,
      );
      await run({
        runtime,
        sourceRepository,
        registry,
        mockAdapter,
        ingestion,
        scheduler,
        memoryRepository,
        opportunityRepository,
        watchService,
        sourceFile,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

async function configureSource(
  sourceRepository: JsonSourceRepository,
  id: string,
  overrides: Partial<{
    adapterType: string;
    sourceType: string;
    sourceUrl: string;
    pollIntervalMs: number;
    timeoutMs: number;
    enabled: boolean;
    defaultOpportunityType: "AIRDROP" | "OTHER";
  }> = {},
): Promise<SourceConfiguration> {
  return sourceRepository.createSource({
    id,
    adapterType: "mock",
    sourceType: "feed",
    sourceUrl: `https://${id}.source.example/feed`,
    pollIntervalMs: 1_000,
    timeoutMs: 100,
    ...overrides,
  });
}

test("source registry registers, retrieves, enables, and disables adapters", () => {
  const registry = new SourceRegistry();
  const adapter = new MockSourceAdapter();
  registry.register(adapter);

  assert.equal(registry.get("mock"), adapter);
  assert.equal(registry.isEnabled("mock"), true);
  assert.equal(registry.disable("mock"), true);
  assert.equal(registry.get("mock"), adapter);
  assert.equal(registry.isEnabled("mock"), false);
  assert.equal(registry.enable("mock"), true);
  assert.equal(registry.isEnabled("mock"), true);
  assert.equal(registry.disable("missing"), false);
  assert.throws(() => registry.register(adapter), /already registered/);
});

test("disabled sources and adapters are skipped without fetching", async () =>
  withIngestion(async ({ sourceRepository, registry, mockAdapter, ingestion }) => {
    await configureSource(sourceRepository, "disabled-source", { enabled: false });
    await configureSource(sourceRepository, "disabled-adapter");
    registry.disable("mock");

    const disabledSource = await ingestion.runSource("disabled-source");
    const disabledAdapter = await ingestion.runSource("disabled-adapter");

    assert.equal(disabledSource.status, "SKIPPED");
    assert.equal(disabledAdapter.status, "SKIPPED");
    assert.equal(mockAdapter.callsBySource.size, 0);
  }));

test("a failed source is recorded without stopping other sources", async () =>
  withIngestion(
    async ({ sourceRepository, mockAdapter, scheduler, runtime }) => {
      await configureSource(sourceRepository, "a-fails");
      await configureSource(sourceRepository, "b-succeeds");
      mockAdapter.enqueueResponse(
        "a-fails",
        new Error("Authorization: Bearer hidden-secret token=hidden-value"),
      );
      mockAdapter.setUpdates("b-succeeds", [
        makeUpdate("good-update", "b-succeeds"),
      ]);

      const results = await scheduler.runOnce();
      const failed = results.find((result) => result.sourceId === "a-fails");
      const succeeded = results.find((result) => result.sourceId === "b-succeeds");
      const failedState = await sourceRepository.getState("a-fails");
      const successState = await sourceRepository.getState("b-succeeds");

      assert.equal(failed?.status, "FAILED");
      assert.equal(succeeded?.status, "SUCCESS");
      assert.equal(failedState?.lastError?.kind, "FETCH");
      assert.equal(failedState?.lastError?.attempts, 1);
      assert.ok(!failedState?.lastError?.message.includes("hidden-secret"));
      assert.ok(!failedState?.lastError?.message.includes("hidden-value"));
      assert.equal(successState?.lastSuccessAt, runtime.now().toISOString());
    },
    { maxRetries: 0 },
  ));

test("transient provider failures retry up to the configured bound", async () =>
  withIngestion(
    async ({ sourceRepository, mockAdapter, ingestion }) => {
      await configureSource(sourceRepository, "retry-source");
      mockAdapter.enqueueResponse("retry-source", new Error("temporary failure"));
      mockAdapter.enqueueResponse("retry-source", new Error("still unavailable"));
      mockAdapter.enqueueResponse("retry-source", [
        makeUpdate("retry-success", "retry-source"),
      ]);

      const result = await ingestion.runSource("retry-source");
      const state = await sourceRepository.getState("retry-source");

      assert.equal(result.status, "SUCCESS");
      assert.equal(result.attempts, 3);
      assert.equal(mockAdapter.callsBySource.get("retry-source"), 3);
      assert.equal(state?.lastAttemptCount, 3);
      assert.equal(state?.consecutiveFailures, 0);
      assert.equal(state?.lastError, null);
    },
    { maxRetries: 2 },
  ));

test("rate limits set a bounded cooldown and are not retried immediately", async () =>
  withIngestion(
    async ({ sourceRepository, mockAdapter, ingestion, runtime }) => {
      await configureSource(sourceRepository, "limited-source");
      mockAdapter.enqueueResponse(
        "limited-source",
        new SourceRateLimitError("rate limit token=must-not-print", 5_000),
      );
      const limited = await ingestion.runSource("limited-source");
      const state = await sourceRepository.getState("limited-source");

      assert.equal(limited.status, "FAILED");
      assert.equal(limited.attempts, 1);
      assert.equal(limited.retryAt, new Date(NOW.getTime() + 5_000).toISOString());
      assert.equal(state?.lastError?.kind, "RATE_LIMIT");
      assert.ok(!state?.lastError?.message.includes("must-not-print"));

      const skipped = await ingestion.runSource("limited-source");
      assert.equal(skipped.status, "SKIPPED");
      assert.equal(mockAdapter.callsBySource.get("limited-source"), 1);

      await runtime.advanceBy(5_000);
      const afterCooldown = await ingestion.runSource("limited-source");
      assert.equal(afterCooldown.status, "SUCCESS");
      assert.equal(mockAdapter.callsBySource.get("limited-source"), 2);
    },
    { maxRetries: 2 },
  ));

test("timeouts abort the adapter request and are recorded", async () =>
  withIngestion(
    async ({ sourceRepository, registry, ingestion, runtime }) => {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const hangingAdapter: SourceAdapter = {
        type: "hanging",
        fetchUpdates: (
          _source: SourceConfiguration,
          context: SourceFetchContext,
        ) => {
          markStarted();
          return new Promise<SourceUpdate[]>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(context.signal.reason),
              { once: true },
            );
          });
        },
      };
      registry.register(hangingAdapter);
      await configureSource(sourceRepository, "timeout-source", {
        adapterType: "hanging",
        timeoutMs: 50,
      });

      const pending = ingestion.runSource("timeout-source");
      await started;
      await runtime.advanceBy(50);
      const result = await pending;
      const state = await sourceRepository.getState("timeout-source");

      assert.equal(result.status, "FAILED");
      assert.equal(result.attempts, 1);
      assert.equal(state?.lastError?.kind, "TIMEOUT");
      assert.match(state?.lastError?.message ?? "", /timed out after 50ms/);
    },
    { maxRetries: 0 },
  ));

test("stable update IDs and opportunity URLs deduplicate repeated deliveries", async () =>
  withIngestion(async ({
    sourceRepository,
    mockAdapter,
    ingestion,
    memoryRepository,
    watchService,
    opportunityRepository,
  }) => {
    await configureSource(sourceRepository, "dedupe-source");
    await memoryRepository.create({
      category: "WATCHING",
      content: "Orbit Airdrop",
    });
    await watchService.addRule({
      targetType: "KEYWORD",
      target: "airdrop",
    });
    mockAdapter.setUpdates("dedupe-source", [
      makeUpdate("update-1", "dedupe-source", {
        sourceUrl: "https://events.example/orbit?id=7&utm_source=first",
      }),
      makeUpdate("update-1", "dedupe-source", {
        sourceUrl: "https://events.example/orbit?id=7&utm_source=first",
      }),
    ]);

    const first = await ingestion.runSource("dedupe-source");
    assert.equal(first.status, "SUCCESS");
    assert.equal(first.processed, 1);
    assert.equal(first.duplicates, 1);
    assert.equal((await opportunityRepository.list()).length, 1);

    mockAdapter.setUpdates("dedupe-source", [
      makeUpdate("update-2", "dedupe-source", {
        title: "Orbit Airdrop Update",
        sourceUrl: "https://events.example/orbit?utm_source=second&id=7#new",
      }),
    ]);
    const second = await ingestion.runSource("dedupe-source");
    const persisted = (await opportunityRepository.list())[0];

    assert.equal(second.processed, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(persisted?.sourceUrl, "https://events.example/orbit?id=7&utm_source=first");
    assert.equal(persisted?.detectedAt, "2026-10-07T10:00:00.000Z");
    assert.equal(
      (persisted?.characteristics as Record<string, unknown>).retrievedAt,
      NOW.toISOString(),
    );
    assert.equal((await opportunityRepository.list()).length, 1);

    mockAdapter.setUpdates("dedupe-source", [
      makeUpdate("update-2", "dedupe-source"),
    ]);
    const repeat = await ingestion.runSource("dedupe-source");
    assert.equal(repeat.processed, 0);
    assert.equal(repeat.duplicates, 1);
  }));

test("concurrent sources serialize opportunity evaluation and avoid duplicate saves", async () =>
  withIngestion(async ({
    sourceRepository,
    mockAdapter,
    ingestion,
    memoryRepository,
    watchService,
    opportunityRepository,
  }) => {
    await configureSource(sourceRepository, "parallel-a");
    await configureSource(sourceRepository, "parallel-b");
    await memoryRepository.create({
      category: "WATCHING",
      content: "Orbit Airdrop",
    });
    await watchService.addRule({
      targetType: "KEYWORD",
      target: "airdrop",
    });
    mockAdapter.setUpdates("parallel-a", [
      makeUpdate("a-update", "parallel-a", {
        sourceUrl: "https://events.example/shared-orbit",
      }),
    ]);
    mockAdapter.setUpdates("parallel-b", [
      makeUpdate("b-update", "parallel-b", {
        sourceUrl: "https://events.example/shared-orbit",
      }),
    ]);

    const results = await Promise.all([
      ingestion.runSource("parallel-a"),
      ingestion.runSource("parallel-b"),
    ]);

    assert.ok(results.every((result) => result.status === "SUCCESS"));
    assert.equal(results.reduce((total, result) => total + result.duplicates, 0), 1);
    assert.equal((await opportunityRepository.list()).length, 1);
  }));

test("source configuration and check state persist across repository instances", async () =>
  withIngestion(async ({ sourceRepository, sourceFile, mockAdapter, ingestion, runtime }) => {
    await configureSource(sourceRepository, "persisted-source", {
      defaultOpportunityType: "AIRDROP",
    });
    mockAdapter.setUpdates("persisted-source", [
      makeUpdate("persisted-update", "persisted-source"),
    ]);
    const result = await ingestion.runSource("persisted-source");
    assert.equal(result.status, "SUCCESS");

    const reopened = new JsonSourceRepository(sourceFile, () => runtime.now());
    const source = await reopened.getSource("persisted-source");
    const state = await reopened.getState("persisted-source");
    assert.equal(source?.defaultOpportunityType, "AIRDROP");
    assert.equal(state?.lastCheckedAt, NOW.toISOString());
    assert.equal(state?.lastSuccessAt, NOW.toISOString());
    assert.deepEqual(state?.seenUpdateIds, ["persisted-update"]);
  }));

test("scheduler polls on configured intervals and stops future ticks", async () =>
  withIngestion(async ({
    sourceRepository,
    mockAdapter,
    scheduler,
    runtime,
  }) => {
    await configureSource(sourceRepository, "scheduled-source", {
      pollIntervalMs: 2_000,
    });
    await scheduler.start();
    await runtime.advanceBy(0);
    await scheduler.waitForIdle();
    assert.equal(mockAdapter.callsBySource.get("scheduled-source"), 1);

    await runtime.advanceBy(1_999);
    assert.equal(mockAdapter.callsBySource.get("scheduled-source"), 1);
    await runtime.advanceBy(1);
    await scheduler.waitForIdle();
    assert.equal(mockAdapter.callsBySource.get("scheduled-source"), 2);

    await scheduler.stop();
    assert.equal(runtime.pendingTimers, 0);
    await runtime.advanceBy(10_000);
    assert.equal(mockAdapter.callsBySource.get("scheduled-source"), 2);
  }));

test("overlapping runs for one source are skipped", async () =>
  withIngestion(async ({ sourceRepository, registry, ingestion }) => {
    let release!: (updates: SourceUpdate[]) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Promise<SourceUpdate[]>((resolve) => {
      release = resolve;
    });
    registry.register({
      type: "deferred",
      fetchUpdates: () => {
        markStarted();
        return response;
      },
    });
    await configureSource(sourceRepository, "overlap-source", {
      adapterType: "deferred",
    });

    const first = ingestion.runSource("overlap-source");
    await started;
    const second = await ingestion.runSource("overlap-source");
    assert.equal(second.status, "SKIPPED");
    release([]);
    assert.equal((await first).status, "SUCCESS");
  }));

test("graceful shutdown waits for active work and prevents another poll", async () =>
  withIngestion(async ({
    sourceRepository,
    registry,
    scheduler,
    runtime,
    mockAdapter,
  }) => {
    let release!: (updates: SourceUpdate[]) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Promise<SourceUpdate[]>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    registry.register({
      type: "deferred-shutdown",
      fetchUpdates: () => {
        calls += 1;
        markStarted();
        return response;
      },
    });
    await configureSource(sourceRepository, "shutdown-source", {
      adapterType: "deferred-shutdown",
    });

    await scheduler.start();
    await runtime.advanceBy(0);
    await started;
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await flushAsyncWork();
    assert.equal(stopped, false);

    release([]);
    await stopping;
    assert.equal(stopped, true);
    assert.equal(calls, 1);
    assert.equal(runtime.pendingTimers, 0);
    await runtime.advanceBy(10_000);
    assert.equal(calls, 1);
    assert.equal(mockAdapter.callsBySource.size, 0);
  }));
