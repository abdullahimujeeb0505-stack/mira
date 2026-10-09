import { JsonLearningRepository } from "../learning/json-learning-repository.js";
import { LearningService } from "../learning/learning-service.js";
import { JsonMemoryRepository } from "../memory/json-memory-repository.js";
import { DecisionService } from "../decision/decision-service.js";
import { JsonOpportunityRepository } from "../opportunities/json-opportunity-repository.js";
import { OpportunityService } from "../opportunities/opportunity-service.js";
import { JsonWatchRuleRepository } from "../watch/json-watch-rule-repository.js";
import { WatchService } from "../watch/watch-service.js";
import { JsonSourceRepository } from "./json-source-repository.js";
import { MockSourceAdapter } from "./mock-source-adapter.js";
import { SourceIngestionService } from "./source-ingestion-service.js";
import { SourceRegistry } from "./source-registry.js";
import { SourceScheduler } from "./source-scheduler.js";

async function main(): Promise<void> {
  const command = process.argv.slice(2).find((argument) => argument !== "--") ?? "inspect";
  const sourceRepository = new JsonSourceRepository();
  const sourceRegistry = new SourceRegistry();
  sourceRegistry.register(new MockSourceAdapter());

  const memoryRepository = new JsonMemoryRepository();
  const learningService = new LearningService(new JsonLearningRepository());
  const decisionService = new DecisionService(memoryRepository, learningService);
  const opportunityService = new OpportunityService(
    decisionService,
    new JsonOpportunityRepository(),
  );
  const watchService = new WatchService(
    new JsonWatchRuleRepository(),
    opportunityService,
  );
  const ingestionService = new SourceIngestionService(
    sourceRepository,
    sourceRegistry,
    watchService,
  );
  const scheduler = new SourceScheduler(sourceRepository, ingestionService);

  if (command === "inspect") {
    await inspectSources(sourceRepository, sourceRegistry);
    return;
  }
  if (command === "run-once") {
    const results = await scheduler.runOnce();
    if (results.length === 0) {
      console.log("No sources are configured.");
      return;
    }
    for (const result of results) {
      console.log(
        `${result.sourceId}: ${result.status}; attempts=${result.attempts}; retrieved=${result.retrieved}; processed=${result.processed}; duplicates=${result.duplicates}`,
      );
      if (result.error) console.log(`  ${result.error}`);
      if (result.retryAt) console.log(`  Retry after: ${result.retryAt}`);
    }
    if (results.some((result) => result.status === "FAILED" || result.status === "PARTIAL")) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('Use "inspect" or "run-once".');
}

async function inspectSources(
  repository: JsonSourceRepository,
  registry: SourceRegistry,
): Promise<void> {
  console.log("Registered adapters:");
  const adapters = registry.list();
  if (adapters.length === 0) console.log("  None");
  for (const adapter of adapters) {
    console.log(`  ${adapter.type}: ${adapter.enabled ? "enabled" : "disabled"}`);
  }

  const sources = await repository.listSources();
  console.log("Configured sources:");
  if (sources.length === 0) {
    console.log("  None");
    return;
  }
  for (const source of sources) {
    const adapter = registry.get(source.adapterType);
    const adapterStatus = !adapter
      ? "unavailable"
      : registry.isEnabled(source.adapterType)
        ? "ready"
        : "disabled";
    const state = await repository.getState(source.id);
    console.log(
      `  ${source.id}: ${source.enabled ? "enabled" : "disabled"}; adapter=${source.adapterType} (${adapterStatus}); interval=${source.pollIntervalMs}ms; url=${safeDisplayUrl(source.sourceUrl)}`,
    );
    console.log(
      `    last checked=${state?.lastCheckedAt ?? "never"}; last success=${state?.lastSuccessAt ?? "never"}; failures=${state?.consecutiveFailures ?? 0}`,
    );
    if (state?.lastError) {
      console.log(`    last error=${state.lastError.kind} at ${state.lastError.at}`);
    }
  }
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Source command failed.";
  console.error(message.replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]"));
  process.exitCode = 1;
});
